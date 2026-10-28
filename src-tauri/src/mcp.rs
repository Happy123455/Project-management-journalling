//! The journal as an MCP server for Claude Desktop and other MCP clients (Mac app only).
//! Off by default; Settings turns it on. It listens on 127.0.0.1 only and refuses anything a web
//! page could send (requests with an Origin header). Tool calls are handed to the page (src/mcp.ts),
//! which reads and writes through the journal store, so every write is an event whose actor is the
//! client's name and shows up under AI changes with Undo.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Response, Server};

pub const PORT: u16 = 39477;
const PROTOCOL: &str = "2025-06-18";

static SERVER: Mutex<Option<Arc<Server>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);
static PENDING: Mutex<Option<HashMap<u64, mpsc::Sender<Value>>>> = Mutex::new(None);
static CLIENT: Mutex<Option<String>> = Mutex::new(None);

fn tools() -> Value {
    let text = |desc: &str| json!({ "type": "string", "description": desc });
    json!([
        { "name": "today", "description": "Today's journal page: its date and text.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "read_day", "description": "The journal page for a day.", "inputSchema": { "type": "object", "properties": { "date": text("YYYY-MM-DD") }, "required": ["date"] } },
        { "name": "read_page", "description": "A named page (person, project or topic) by its title.", "inputSchema": { "type": "object", "properties": { "title": text("Page title") }, "required": ["title"] } },
        { "name": "search", "description": "Days and pages containing every word of the query, newest first.", "inputSchema": { "type": "object", "properties": { "query": text("Words to find") }, "required": ["query"] } },
        { "name": "list_days", "description": "Every day that has a journal page (YYYY-MM-DD).", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "append", "description": "Add text to the end of a day's page (today if no date). Each line becomes a paragraph; [[Name]] links and #tags work. The edit is recorded under your name and can be undone in the app.", "inputSchema": { "type": "object", "properties": { "text": text("What to add"), "date": text("YYYY-MM-DD; default today") }, "required": ["text"] } },
    ])
}

/// Asks the page to run a tool and waits for its answer.
fn call_page(app: &AppHandle, tool: &str, args: Value) -> Value {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, tx);
    let actor = CLIENT.lock().unwrap().clone().unwrap_or_else(|| "MCP client".into());
    let _ = app.emit("mcp-call", json!({ "id": id, "tool": tool, "args": args, "actor": actor }));
    let answer = rx.recv_timeout(Duration::from_secs(20));
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
    match answer {
        Ok(v) => v,
        Err(_) => json!({ "isError": true, "content": [{ "type": "text", "text": "The journal didn't answer (is the app window open?)." }] }),
    }
}

/// The page's answer to a tool call.
#[tauri::command]
pub fn mcp_reply(id: u64, result: Value) {
    if let Some(tx) = PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id) {
        let _ = tx.send(result);
    }
}

/// Runs a tool: the page in the app, a stand-in in tests.
type Caller = Arc<dyn Fn(&str, Value) -> Value + Send + Sync>;

fn handle(call: &Caller, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => {
            let name = msg["params"]["clientInfo"]["name"].as_str().unwrap_or("MCP client");
            *CLIENT.lock().unwrap() = Some(name.to_string());
            json!({
                "protocolVersion": PROTOCOL,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "dynamic-journal", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Hapi's journal. Read with today/read_day/read_page/search; add with append. Write only what was asked."
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => call(msg["params"]["name"].as_str().unwrap_or(""), msg["params"]["arguments"].clone()),
        // Notifications (no id) need no answer.
        _ if id.is_none() => return None,
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Unknown method {method}") } })),
    };
    id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn serve(call: Caller, server: Arc<Server>) {
    for mut request in server.incoming_requests() {
        // Browsers always send Origin; MCP clients don't. Refusing it keeps web pages out.
        if request.headers().iter().any(|h| h.field.equiv("Origin")) {
            let _ = request.respond(Response::from_string("Forbidden").with_status_code(403));
            continue;
        }
        if *request.method() != Method::Post || request.url() != "/mcp" {
            let _ = request.respond(Response::from_string("Dynamic Journal MCP: POST JSON-RPC to /mcp").with_status_code(405));
            continue;
        }
        let mut body = String::new();
        if request.as_reader().take(1 << 20).read_to_string(&mut body).is_err() {
            let _ = request.respond(Response::from_string("Bad request").with_status_code(400));
            continue;
        }
        let call = call.clone();
        // Tool calls wait on the page, so each request gets its own thread.
        std::thread::spawn(move || {
            let reply = match serde_json::from_str::<Value>(&body) {
                Ok(Value::Array(batch)) => {
                    let out: Vec<Value> = batch.iter().filter_map(|m| handle(&call, m)).collect();
                    (!out.is_empty()).then(|| Value::Array(out))
                }
                Ok(msg) => handle(&call, &msg),
                Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })),
            };
            let json_header = Header::from_bytes("Content-Type", "application/json").unwrap();
            let _ = match reply {
                Some(v) => request.respond(Response::from_string(v.to_string()).with_header(json_header)),
                None => request.respond(Response::empty(202)),
            };
        });
    }
}

#[tauri::command]
pub fn mcp_start(app: AppHandle) -> Result<u16, String> {
    let mut slot = SERVER.lock().unwrap();
    if slot.is_some() {
        return Ok(PORT);
    }
    let server = Arc::new(Server::http(("127.0.0.1", PORT)).map_err(|e| e.to_string())?);
    *slot = Some(server.clone());
    let call: Caller = Arc::new(move |tool: &str, args: Value| call_page(&app, tool, args));
    std::thread::spawn(move || serve(call, server));
    Ok(PORT)
}

#[tauri::command]
pub fn mcp_stop() {
    if let Some(server) = SERVER.lock().unwrap().take() {
        server.unblock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    fn post(port: u16, body: &str, origin: bool) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let extra = if origin { "Origin: https://evil.example\r\n" } else { "" };
        write!(s, "POST /mcp HTTP/1.1\r\nHost: x\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn speaks_mcp_over_http_and_refuses_web_pages() {
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let call: Caller = Arc::new(|tool: &str, args: Value| json!({ "content": [{ "type": "text", "text": format!("{tool} {args}") }] }));
        std::thread::spawn(move || serve(call, server));
        let init = post(port, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claude-ai"}}}"#, false);
        assert!(init.contains("dynamic-journal") && init.contains(PROTOCOL));
        assert_eq!(CLIENT.lock().unwrap().as_deref(), Some("claude-ai"));
        assert!(post(port, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, false).starts_with("HTTP/1.1 202"));
        assert!(post(port, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, false).contains("\"append\""));
        assert!(post(port, r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"today","arguments":{}}}"#, false).contains("today {}"));
        assert!(post(port, r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#, true).starts_with("HTTP/1.1 403"));
    }

    #[test]
    fn every_tool_has_a_schema() {
        for t in tools().as_array().unwrap() {
            assert!(t["name"].is_string() && t["inputSchema"]["type"] == "object");
        }
    }
}
