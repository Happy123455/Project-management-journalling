import type { JournalStore } from "../store";
import { importRecords } from "./engine";
import type { SyncRecord } from "./merge";
import { receiveTyping, type TypingMsg } from "./liveTyping";
import { EVENT_LOGGED } from "../store/logged";
import { fromBase64, toBase64 } from "../store/files";
import { sha256 } from "../lib/files";
import type { FileRecord } from "../store/types";
import { visibleInterval } from "../lib/power";

/**
 * Instant sync over the home Wi-Fi. The Mac app listens (src-tauri/src/direct.rs) and puts its
 * address and a key in its presence file in the Drive folder; the phone app reads it and connects.
 * - Phone → Mac: the phone sends its new events (POST /push) as soon as they're saved.
 * - Mac → phone: the phone keeps one request open (POST /pull); the Mac answers it as soon as it
 *   has new events.
 * Both carry the same event records Drive does, and go through the same merge (importRecords):
 * an event already known is skipped, so getting the same edit by Wi-Fi and later by Drive changes
 * nothing. Drive keeps running underneath as the backup and catch-up path.
 * - Photos, GIFs and other files go across the link too: the phone asks the Mac for bytes it is
 *   missing (POST /file), and the Mac's pull answers list the bytes it is missing (`want`), which
 *   the phone then sends (POST /file-put). Drive still carries them when the link is down.
 */
export interface DirectAddress {
  ip: string;
  port: number;
  key: string;
}

/**
 * Edits go out the moment they're saved (the store fires EVENT_LOGGED); this slower check is only
 * a safety net. It used to be every second, which kept the phone's CPU busy the whole time.
 */
const CHECK_MS = 15_000;
/** Files bigger than this stay on Drive (they'd go through the page as text). */
const MAX_DIRECT_FILE = 40 * 1024 * 1024;
/** A file asked for and not there is asked for again after this long. */
const ASK_AGAIN_MS = 60_000;
/** How long the Mac holds a pull open when there's nothing new. */
const HOLD_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const inApp = () => "__TAURI_INTERNALS__" in window;
export const canHost = () => inApp() && !/Android/i.test(navigator.userAgent);
export const canConnect = () => inApp() && /Android/i.test(navigator.userAgent);

/** This device's events the other side hasn't been sent yet; marks them sent. */
async function unsent(store: JournalStore, sent: Set<string>) {
  const records = await store.syncRecords(sent);
  for (const r of records) sent.add(r.event.id);
  return records;
}

/** This device's copy of the file with these bytes, as base64 (null when it doesn't have them). */
async function fileData(store: JournalStore, hash: string): Promise<string | null> {
  const f = (await store.listFiles()).find((x) => x.hash === hash);
  if (!f || f.size > MAX_DIRECT_FILE) return null;
  const bytes = await store.fileBytes(f.id).catch(() => null);
  return bytes && bytes.length <= MAX_DIRECT_FILE ? toBase64(bytes) : null;
}

/** Stores bytes that arrived for files this device knows of but lacked; true when they fit. */
async function takeFile(store: JournalStore, hash: string, data: string): Promise<boolean> {
  const bytes = fromBase64(data);
  if ((await sha256(bytes)) !== hash) return false;
  const records: FileRecord[] = (await store.missingFiles()).filter((f) => f.hash === hash);
  if (!records.length) return false;
  await store.applySync({ events: [], blocks: [], files: records }, new Map([[hash, bytes]]));
  window.dispatchEvent(new Event("journal:files-arrived"));
  return true;
}

/** Hashes of files this device lacks, leaving out ones asked for within the last minute. */
async function missingHashes(store: JournalStore, asked: Map<string, number>) {
  const now = Date.now();
  const out = new Set<string>();
  for (const f of await store.missingFiles()) if (now - (asked.get(f.hash) ?? 0) > ASK_AGAIN_MS) out.add(f.hash);
  for (const h of out) asked.set(h, now);
  return [...out];
}

function newKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function savedKey() {
  try {
    let k = localStorage.getItem("journal.directKey");
    if (!k) localStorage.setItem("journal.directKey", (k = newKey()));
    return k;
  } catch {
    return newKey();
  }
}

export interface Host {
  /** The address to put in the presence file (null when the Mac isn't on a network). */
  address(): Promise<DirectAddress | null>;
  /** When the phone last talked to this Mac (ms). */
  lastSeen(): number;
  /** Something was saved: answer a waiting pull now. */
  notify(): void;
  /** Letter-by-letter typing for the phone. */
  sendTyping(m: TypingMsg): void;
  stop(): void;
}

/** Mac: listen for the phone. */
export async function startHost(store: JournalStore, onImported: () => void): Promise<Host> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const key = savedKey();
  let seen = 0;
  let sent: Set<string> | null = null;
  let wake: (() => void) | null = null;
  let typing: TypingMsg[] = [];
  /** Bytes this Mac lacks, asked of the phone in pull answers (when last asked). */
  const asked = new Map<string, number>();
  /** Look for missing bytes at the next pull (a new link, or the phone sent new files). */
  let checkWant = true;
  const onLogged = () => wake?.();
  window.addEventListener(EVENT_LOGGED, onLogged);

  type Body = { records?: SyncRecord[]; fresh?: boolean; typing?: TypingMsg[]; hash?: string; data?: string } | null;
  const answer = async (path: string, body: Body) => {
    seen = Date.now();
    if (path === "/hello") return { ok: true, device: store.deviceId };
    if (path === "/typing") {
      for (const m of body?.typing ?? []) receiveTyping(m);
      return { ok: true };
    }
    if (path === "/push") {
      const plan = await importRecords(store, body?.records ?? []);
      if (plan.events.length) onImported();
      if (plan.files.length) {
        checkWant = true;
        wake?.();
      }
      return { ok: true, imported: plan.events.length };
    }
    if (path === "/file") return { ok: true, data: body?.hash ? await fileData(store, body.hash) : null };
    if (path === "/file-put") {
      const took = body?.hash && body.data ? await takeFile(store, body.hash, body.data) : false;
      if (took) onImported();
      return { ok: true, took };
    }
    if (path === "/pull") {
      // A new connection: what happened before it goes by Drive (the phone syncs Drive as it connects).
      if (!sent || body?.fresh) {
        sent = new Set(await store.ownEventIds());
        checkWant = true;
      }
      const until = Date.now() + HOLD_MS;
      while (Date.now() < until) {
        const records = await unsent(store, sent);
        const want = checkWant ? await missingHashes(store, asked) : [];
        checkWant = false;
        if (records.length || typing.length || want.length) {
          const t = typing;
          typing = [];
          return { ok: true, records, typing: t, want };
        }
        await new Promise<void>((r) => {
          wake = r;
          window.setTimeout(r, CHECK_MS);
        });
        wake = null;
      }
      return { ok: true, records: [] };
    }
    return { ok: false, error: "unknown" };
  };

  const unlisten = await listen<{ id: number; path: string; body: Body }>("direct-req", async (e) => {
    const result = await answer(e.payload.path, e.payload.body).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    await invoke("direct_reply", { id: e.payload.id, result });
  });

  return {
    async address() {
      const r = await invoke<{ ip: string | null; port: number }>("direct_start", { key }).catch(() => null);
      return r?.ip ? { ip: r.ip, port: r.port, key } : null;
    },
    lastSeen: () => seen,
    notify: () => wake?.(),
    sendTyping(m) {
      // Only the newest full copy per note is worth keeping in the queue.
      if (m.full !== undefined) typing = typing.filter((t) => t.key !== m.key);
      typing.push(m);
      wake?.();
    },
    stop: () => {
      window.removeEventListener(EVENT_LOGGED, onLogged);
      unlisten();
    },
  };
}

export interface Client {
  /** Same Mac address: keep this client. */
  readonly address: DirectAddress;
  /** Something was saved: send it now. */
  notify(): void;
  /** Letter-by-letter typing for the Mac. */
  sendTyping(m: TypingMsg): void;
  stop(): void;
}

/**
 * Phone: connect to the Mac at `address`. `onState(true)` once connected (then the caller runs a
 * Drive round to catch up), `false` when the link drops; it keeps trying while running.
 */
export function startClient(store: JournalStore, address: DirectAddress, onImported: () => void, onState: (up: boolean) => void): Client {
  let stopped = false;
  let up = false;
  let sent: Set<string> | null = null;
  let pushing = false;
  let again = false;
  const live = new Set<AbortController>();
  /** Files asked of the Mac (when), so a missing one isn't asked for over and over. */
  const asked = new Map<string, number>();

  const post = async <T,>(path: string, body: unknown, timeoutMs: number): Promise<T> => {
    const { fetch } = await import("@tauri-apps/plugin-http");
    const ctl = new AbortController();
    live.add(ctl);
    const t = window.setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${address.ip}:${address.port}${path}`, {
        method: "POST",
        headers: { "X-Journal-Key": address.key, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: ctl.signal,
        connectTimeout: 3000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = (await res.json()) as T & { ok?: boolean; error?: string };
      if (out.ok === false) throw new Error(out.error ?? "refused");
      return out;
    } finally {
      window.clearTimeout(t);
      live.delete(ctl);
    }
  };

  // Photos and GIFs: fetch the bytes this phone lacks from the Mac, one at a time.
  let fetching = false;
  const fetchMissing = async () => {
    if (fetching || stopped || !up) return;
    fetching = true;
    try {
      for (const hash of await missingHashes(store, asked)) {
        if (stopped || !up) break;
        const r = await post<{ data: string | null }>("/file", { hash }, 120_000).catch(() => null);
        if (r?.data && (await takeFile(store, hash, r.data).catch(() => false))) onImported();
      }
    } finally {
      fetching = false;
    }
  };
  // And send the Mac the bytes it asked for.
  const sendFiles = async (hashes: string[]) => {
    for (const hash of hashes) {
      if (stopped || !up) break;
      const data = await fileData(store, hash).catch(() => null);
      if (data) await post("/file-put", { hash, data }, 120_000).catch(() => {});
    }
  };

  const setUp = (v: boolean) => {
    if (v === up) return;
    up = v;
    if (!v) sent = null;
    onState(v);
  };

  const push = async () => {
    if (!sent || stopped) return;
    if (pushing) return void (again = true);
    pushing = true;
    try {
      do {
        again = false;
        const before = new Set(sent);
        const records = await unsent(store, sent);
        if (!records.length) break;
        try {
          await post("/push", { records }, 30_000);
        } catch (e) {
          sent = before; // not sent: try again (and Drive carries it anyway)
          throw e;
        }
      } while (again);
    } catch {
      setUp(false);
    } finally {
      pushing = false;
    }
  };

  void (async () => {
    while (!stopped) {
      try {
        await post("/hello", {}, 4000);
        sent = new Set(await store.ownEventIds());
        setUp(true);
        void fetchMissing();
        let fresh = true;
        while (!stopped && up) {
          const r = await post<{ records: SyncRecord[]; typing?: TypingMsg[]; want?: string[] }>("/pull", { fresh }, HOLD_MS + 10_000);
          fresh = false;
          for (const m of r.typing ?? []) receiveTyping(m);
          if (r.want?.length) void sendFiles(r.want);
          if (r.records?.length) {
            const plan = await importRecords(store, r.records);
            if (plan.events.length) onImported();
            if (plan.files.length) void fetchMissing();
          }
        }
      } catch {
        setUp(false);
      }
      if (!stopped) await sleep(8000);
    }
  })();
  // Typing goes out one request at a time; what's typed meanwhile goes in the next one.
  let typingOut: TypingMsg[] = [];
  let typingBusy = false;
  const flushTyping = async () => {
    if (typingBusy || !up || stopped) return;
    typingBusy = true;
    try {
      while (typingOut.length && up && !stopped) {
        const batch = typingOut;
        typingOut = [];
        await post("/typing", { typing: batch }, 5000).catch(() => {});
      }
    } finally {
      typingBusy = false;
    }
  };

  // Every save of every kind goes out as it happens; the slow check is only a safety net.
  const onLogged = () => void push();
  window.addEventListener(EVENT_LOGGED, onLogged);
  const stopChecker = visibleInterval(() => void push(), CHECK_MS);
  // Bytes the Mac didn't have yet when first asked: try again now and then while linked.
  const stopFiles = visibleInterval(() => void fetchMissing(), ASK_AGAIN_MS);

  return {
    address,
    notify: () => void push(),
    sendTyping(m) {
      if (m.full !== undefined) typingOut = typingOut.filter((t) => t.key !== m.key);
      typingOut.push(m);
      void flushTyping();
    },
    stop() {
      stopped = true;
      window.removeEventListener(EVENT_LOGGED, onLogged);
      stopChecker();
      stopFiles();
      for (const c of live) c.abort();
      setUp(false);
    },
  };
}
