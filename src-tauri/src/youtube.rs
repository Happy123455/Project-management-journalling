//! Mac: YouTube refuses embeds from a page with no web address (Error 153: the app's pages are
//! tauri://localhost, so no Referer is sent). A tiny local web page wraps the player, so YouTube
//! sees http://127.0.0.1 as the site embedding it, like any web page.

use std::sync::{Mutex, OnceLock};
use tiny_http::{Header, Response, Server};

static PORT: OnceLock<u16> = OnceLock::new();
static STARTING: Mutex<()> = Mutex::new(());

fn valid_id(id: &str) -> bool {
    (6..=20).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn page(id: &str, start: u32, port: u16) -> String {
    let start = if start > 0 { format!("&start={start}") } else { String::new() };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}iframe{{border:0;width:100%;height:100%}}</style></head>
<body><iframe src="https://www.youtube-nocookie.com/embed/{id}?playsinline=1&rel=0&origin=http://127.0.0.1:{port}{start}"
 allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
 referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></body></html>"#
    )
}

fn serve(server: Server, port: u16) {
    let html = Header::from_bytes("Content-Type", "text/html; charset=utf-8").expect("static header");
    for request in server.incoming_requests() {
        // /yt/<id>?start=<seconds>
        let url = request.url().to_string();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let id = path.strip_prefix("/yt/").unwrap_or("");
        let start = query
            .split('&')
            .find_map(|kv| kv.strip_prefix("start="))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let _ = if valid_id(id) {
            request.respond(Response::from_string(page(id, start, port)).with_header(html.clone()))
        } else {
            request.respond(Response::from_string("Not found").with_status_code(404))
        };
    }
}

/// The local port for YouTube players, started on first use. Errors if no port could be opened.
#[tauri::command]
pub fn youtube_port() -> Result<u16, String> {
    if let Some(port) = PORT.get() {
        return Ok(*port);
    }
    let _guard = STARTING.lock().map_err(|e| e.to_string())?;
    if let Some(port) = PORT.get() {
        return Ok(*port);
    }
    // A fixed port keeps the same origin between runs; any free one if it is taken.
    let server = Server::http("127.0.0.1:51735")
        .or_else(|_| Server::http("127.0.0.1:0"))
        .map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    std::thread::spawn(move || serve(server, port));
    let _ = PORT.set(port);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::{page, valid_id};

    #[test]
    fn checks_ids_and_builds_the_page() {
        assert!(valid_id("dQw4w9WgXcQ"));
        assert!(!valid_id("../etc/passwd"));
        assert!(page("dQw4w9WgXcQ", 30, 51735).contains("embed/dQw4w9WgXcQ?playsinline=1&rel=0&origin=http://127.0.0.1:51735&start=30"));
    }
}
