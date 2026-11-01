//! Instant sync with the phone over the home Wi-Fi (Mac app only).
//! The Mac listens on PORT on every network; the phone finds the address and the key in the Mac's
//! presence file in the Drive folder (src/sync/direct.ts). Every request must carry the key, so
//! nobody else on the network gets in. Requests are handed to the page, which reads and writes
//! through the journal store and the same merge Drive sync uses: this file only relays.

use std::collections::HashMap;
use std::io::Read;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Response, Server};

pub const PORT: u16 = 39478;

static SERVER: Mutex<Option<Arc<Server>>> = Mutex::new(None);
static KEY: Mutex<String> = Mutex::new(String::new());
static NEXT: AtomicU64 = AtomicU64::new(1);
static PENDING: Mutex<Option<HashMap<u64, mpsc::Sender<Value>>>> = Mutex::new(None);

/// This Mac's address on the local network (no packet is sent: connecting a UDP socket only
/// picks the interface the default route uses).
fn lan_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

fn ask_page(app: &AppHandle, path: &str, body: Value) -> Option<Value> {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(id, tx);
    let _ = app.emit("direct-req", json!({ "id": id, "path": path, "body": body }));
    // A pull waits up to 20 s on the page for new edits.
    let answer = rx.recv_timeout(Duration::from_secs(30)).ok();
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).remove(&id);
    answer
}

/// The page's answer to a request.
#[tauri::command]
pub fn direct_reply(id: u64, result: Value) {
    if let Some(tx) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).remove(&id) {
        let _ = tx.send(result);
    }
}

/// Starts listening (once) with this key; answers the address the phone should use.
#[tauri::command]
pub fn direct_start(app: AppHandle, key: String) -> Result<Value, String> {
    if key.len() < 16 {
        return Err("key too short".into());
    }
    *KEY.lock().unwrap_or_else(|e| e.into_inner()) = key;
    let mut slot = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        let server = Arc::new(Server::http(("0.0.0.0", PORT)).map_err(|e| e.to_string())?);
        *slot = Some(server.clone());
        std::thread::spawn(move || serve(app, server));
    }
    Ok(json!({ "ip": lan_ip(), "port": PORT }))
}

fn serve(app: AppHandle, server: Arc<Server>) {
    let json_header = Header::from_bytes("Content-Type", "application/json").unwrap();
    for mut request in server.incoming_requests() {
        let key = KEY.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let ok_key = request.headers().iter().any(|h| h.field.equiv("X-Journal-Key") && h.value.as_str() == key);
        // Keeps web pages out: a browser always sends its page's Origin. The phone app's HTTP
        // plugin sends one too, but it's the app's own (tauri.localhost), which no web page can use.
        let from_page = request.headers().iter().any(|h| {
            h.field.equiv("Origin") && !matches!(h.value.as_str(), "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost")
        });
        if !ok_key || from_page || *request.method() != Method::Post {
            let _ = request.respond(Response::from_string("Forbidden").with_status_code(403));
            continue;
        }
        let path = request.url().to_string();
        let mut body = String::new();
        if request.as_reader().take(64 << 20).read_to_string(&mut body).is_err() {
            let _ = request.respond(Response::from_string("Bad request").with_status_code(400));
            continue;
        }
        let app = app.clone();
        let header = json_header.clone();
        std::thread::spawn(move || {
            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let response = match ask_page(&app, &path, body) {
                Some(v) => Response::from_string(v.to_string()).with_header(header),
                None => Response::from_string("{\"error\":\"busy\"}").with_header(header).with_status_code(503),
            };
            let _ = request.respond(response);
        });
    }
}
