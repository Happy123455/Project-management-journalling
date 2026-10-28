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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:journal.db", migrations())
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
