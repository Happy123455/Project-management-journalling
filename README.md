# Dynamic Journal

A local-first daily journal with blocks, `[[wikilinks]]`, `#tags` and one-click timestamps. Runs on macOS and Android (Tauri 2).

## Run it

You need Node 20+ and Rust ([rustup.rs](https://rustup.rs)). On a Mac, also run `xcode-select --install` once.

```sh
npm install
npm run tauri dev        # opens the desktop app
```

Android (needs Android Studio with the SDK and NDK; see [Tauri's Android setup](https://v2.tauri.app/start/prerequisites/#android)):

```sh
npm run tauri android init   # once
npm run tauri android dev
```

`npm run dev` runs just the web UI in a browser, saving to browser storage instead of SQLite.

## What works now
- A page for each day, with previous/next and a list of days you've written in.
- Rich text with lists and headings (`# ` at line start), autosaved to `journal.db`.
- `[[wikilinks]]` and `#tags` highlighted as you type and listed beside the page.
- Timestamp button or Cmd/Ctrl+Shift+T: `28,October,2026 Wednesday (08:14:35)`.
- Every save is recorded in an event log, ready for sync and the nexus view.

See `CLAUDE.md` for how the code is organised.
