# Dynamic Journal

Hapi's local-first block journal, built to replace Obsidian. Targets: **macOS and Android** from one Tauri 2 codebase.
Full plan (features, phases, data model): https://claude.ai/artifact/8tWDAKMkVDan6UayPDWVGn

## Stack
- Tauri 2 shell (`src-tauri/`), React 19 + TypeScript + Vite frontend (`src/`).
- Editor: TipTap 3 (`src/editor/`). Custom behaviour goes in TipTap extensions, not in React state.
- Storage: SQLite through `tauri-plugin-sql`. Schema = migrations in `src-tauri/src/lib.rs`; add a new migration, never edit a shipped one.
- `src/store/` hides storage behind `JournalStore`. `SqliteStore` runs in the app; `MemoryStore` runs in a plain browser (`npm run dev`) and in tests. Keep both behaving the same.

## Core rules
- Everything is a block (pages, people, projects, log entries). A daily page is a block of type `day`.
- Every change is appended to `events` (device, actor, before/after, parent event ids). Sync, the nexus conflict view, the growth graph and AI undo all build on this log, so never write to `blocks` without also writing an event.
- Never lose the user's text. Saves are debounced and flushed before switching day or closing.
- AI edits use `actor` = the AI's name so they can be shown and undone.
- Timestamp format is Hapi's: `27,October,2026 Tuesday (22:04:26)`.

## Commands
- `npm run dev`: frontend in the browser (MemoryStore).
- `npm run tauri dev`: desktop app. `npm run tauri android init` once, then `npm run tauri android dev`.
- `npm test`: unit tests (vitest). `npm run build`: type-check + build.
