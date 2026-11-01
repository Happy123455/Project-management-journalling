import type { JournalStore } from "../store";
import { importRecords } from "./engine";
import type { SyncRecord } from "./merge";
import { receiveTyping, type TypingMsg } from "./liveTyping";

/**
 * Instant sync over the home Wi-Fi. The Mac app listens (src-tauri/src/direct.rs) and puts its
 * address and a key in its presence file in the Drive folder; the phone app reads it and connects.
 * - Phone → Mac: the phone sends its new events (POST /push) as soon as they're saved.
 * - Mac → phone: the phone keeps one request open (POST /pull); the Mac answers it as soon as it
 *   has new events.
 * Both carry the same event records Drive does, and go through the same merge (importRecords):
 * an event already known is skipped, so getting the same edit by Wi-Fi and later by Drive changes
 * nothing. Drive keeps running underneath as the backup and catch-up path (and carries photos).
 */
export interface DirectAddress {
  ip: string;
  port: number;
  key: string;
}

/** How often each side looks in its own database for edits not sent yet (cheap, ids only). */
const CHECK_MS = 1000;
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

  type Body = { records?: SyncRecord[]; fresh?: boolean; typing?: TypingMsg[] } | null;
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
      return { ok: true, imported: plan.events.length };
    }
    if (path === "/pull") {
      // A new connection: what happened before it goes by Drive (the phone syncs Drive as it connects).
      if (!sent || body?.fresh) sent = new Set(await store.ownEventIds());
      const until = Date.now() + HOLD_MS;
      while (Date.now() < until) {
        const records = await unsent(store, sent);
        if (records.length || typing.length) {
          const t = typing;
          typing = [];
          return { ok: true, records, typing: t };
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
    stop: unlisten,
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
        let fresh = true;
        while (!stopped && up) {
          const r = await post<{ records: SyncRecord[]; typing?: TypingMsg[] }>("/pull", { fresh }, HOLD_MS + 10_000);
          fresh = false;
          for (const m of r.typing ?? []) receiveTyping(m);
          if (r.records?.length) {
            const plan = await importRecords(store, r.records);
            if (plan.events.length) onImported();
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

  // Catches every kind of save, not only the day page's.
  const checker = window.setInterval(() => void push(), CHECK_MS);

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
      window.clearInterval(checker);
      for (const c of live) c.abort();
      setUp(false);
    },
  };
}
