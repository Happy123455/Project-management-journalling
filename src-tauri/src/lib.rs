use tauri_plugin_sql::{Migration, MigrationKind};

/// Local journal schema. Everything is a block; `events` is the append-only
/// timeline that sync, the nexus view and AI undo build on.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create journal tables",
        sql: r#"
            CREATE TABLE blocks (
                id TEXT PRIMARY KEY,
                parent_id TEXT REFERENCES blocks(id),
                sort_order REAL NOT NULL DEFAULT 0,
                type TEXT NOT NULL,
                type_version INTEGER NOT NULL DEFAULT 1,
                day TEXT,
                content TEXT NOT NULL,
                props TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX blocks_day ON blocks(day) WHERE type = 'day';
            CREATE INDEX blocks_parent ON blocks(parent_id);

            CREATE TABLE block_types (
                id TEXT NOT NULL,
                version INTEGER NOT NULL,
                name TEXT NOT NULL,
                fields TEXT NOT NULL DEFAULT '[]',
                icon TEXT,
                created_at TEXT NOT NULL,
                PRIMARY KEY (id, version)
            );

            CREATE TABLE links (
                from_block TEXT NOT NULL REFERENCES blocks(id),
                target TEXT NOT NULL,
                kind TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (from_block, target, kind)
            );
            CREATE INDEX links_target ON links(target);

            CREATE TABLE files (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                mime TEXT NOT NULL,
                size INTEGER NOT NULL,
                hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE events (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                actor TEXT NOT NULL,
                block_id TEXT NOT NULL,
                op TEXT NOT NULL,
                before TEXT,
                after TEXT NOT NULL,
                parent_event_ids TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE INDEX events_block ON events(block_id, created_at);
        "#,
        kind: MigrationKind::Up,
    }]
}

/// Secrets (the AI key) in the macOS Keychain, never in the journal, sync files or backups.
#[cfg(desktop)]
mod kokoro;

#[cfg(desktop)]
mod mcp;

/// Instant sync between the phone and the Mac over Wi-Fi (both listen: see direct.rs).
mod direct;

#[cfg(desktop)]
mod youtube;

#[cfg(desktop)]
mod secrets {
    const SERVICE: &str = "com.hapi.dynamicjournal";

    fn entry(name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn secret_get(name: String) -> Result<Option<String>, String> {
        match entry(&name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    #[tauri::command]
    pub fn secret_set(name: String, value: String) -> Result<(), String> {
        entry(&name)?.set_password(&value).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn secret_delete(name: String) -> Result<(), String> {
        match entry(&name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_panics();
    let builder = tauri::Builder::default();
    // Mac: the floating bubble's keyboard shortcut.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:journal.db", migrations())
                .build(),
        )
        .invoke_handler(handlers())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Writes every panic (message, place, thread) to ~/Library/Logs/Dynamic Journal/panic.log, then lets
/// the default report run: a crash report alone doesn't say which line failed.
fn log_panics() {
    #[cfg(target_os = "macos")]
    {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Ok(home) = std::env::var("HOME") {
                let dir = std::path::Path::new(&home).join("Library/Logs/Dynamic Journal");
                let _ = std::fs::create_dir_all(&dir);
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("panic.log")) {
                    use std::io::Write;
                    let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    let thread = std::thread::current().name().unwrap_or("?").to_string();
                    let _ = writeln!(f, "[{when}] thread {thread}: {info}\n{}", std::backtrace::Backtrace::force_capture());
                }
            }
            default(info);
        }));
    }
}

/// AI chat's rests between bursts (src/ai/chatRunner.ts): waited here, because macOS slows the
/// timers of a hidden window and a reply would stall while the person works in another app.
#[cfg(desktop)]
#[tauri::command]
async fn ai_rest(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms.min(120_000)))).await;
}

/// How many times anything was copied on this Mac (NSPasteboard's changeCount), so the shared
/// clipboard only reads the clipboard when it changed. Reading it every second, and a picture on
/// it every 2.5 s (a whole screenshot's pixels each time), kept the Mac busy while linked.
#[cfg(desktop)]
#[tauri::command]
fn clipboard_changes() -> i64 {
    #[cfg(target_os = "macos")]
    {
        objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as i64
    }
    #[cfg(not(target_os = "macos"))]
    {
        -1
    }
}

#[cfg(desktop)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        kokoro::voice_info,
        kokoro::set_voice_model,
        kokoro::set_voice,
        kokoro::remove_voice,
        kokoro::download_voice,
        kokoro::speak,
        kokoro::stop_speech,
        mcp::mcp_start,
        mcp::mcp_stop,
        mcp::mcp_reply,
        direct::direct_start,
        direct::direct_reply,
        direct::direct_scan,
        youtube::youtube_port,
        ai_rest,
        clipboard_changes
    ]
}

#[cfg(mobile)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![direct::direct_start, direct::direct_reply, direct::direct_scan]
}
