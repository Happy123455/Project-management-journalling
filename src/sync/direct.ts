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
 * address and a key in its presence file in the Drive folder; the phone app reads it, remembers
 * it, and connects.
 * - Phone → Mac: the phone sends its new events (POST /push) as soon as they're saved, and the
 *   bytes of a new photo or file right behind them (POST /file-put), without waiting to be asked.
 * - Mac → phone: the phone keeps one request open (POST /pull); the Mac answers it as soon as it
 *   has new events, typing or a copied clip.
 * Both carry the same event records Drive does, and go through the same merge (importRecords):
 * an event already known is skipped, so getting the same edit by Wi-Fi and later by Drive changes
 * nothing. Drive keeps running underneath as the backup and catch-up path, and takes over as
 * soon as either app closes or goes to the background.
 *
 * Connecting by hand (the ⚡ Connect button): the phone tries the Mac's last address, then knocks
 * on every address of its Wi-Fi (direct_scan) and says hello with the key to the ones that answer.
 * The phone listens too while its app is open, so the Mac's button finds the phone the same way
 * and rings it (POST /ring with the Mac's address); the phone then connects at once.
 */
export interface DirectAddress {
  ip: string;
  port: number;
  key: string;
}

/** Copied text or an image going to the other device's clipboard (see clipboard.ts). */
export interface Clip {
  id: string;
  from: string;
  at: number;
  text?: string;
  mime?: string;
  /** Image bytes, base64. */
  data?: string;
}

/** Both apps listen on this port (direct.rs). */
export const PORT = 39478;
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
/** The phone counts as linked while it was heard from this recently (a pull comes every ≤ 20 s). */
const LINK_FRESH_MS = 35_000;

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const inApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const canHost = () => inApp() && !/Android/i.test(navigator.userAgent);
export const canConnect = () => inApp() && /Android/i.test(navigator.userAgent);

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the address is found again next time.
  }
}

const MAC_KEY = "journal.directMac";
const PHONE_KEY = "journal.directPhone";

/** Phone: the Mac it last reached (or read from the Mac's presence file), with its key. */
export function savedMac(): DirectAddress | null {
  try {
    const a = JSON.parse(readLocal(MAC_KEY) ?? "null") as DirectAddress | null;
    return a && typeof a.ip === "string" && typeof a.key === "string" && a.key.length >= 16 ? { ip: a.ip, port: a.port || PORT, key: a.key } : null;
  } catch {
    return null;
  }
}
export function rememberMac(a: DirectAddress) {
  const prev = readLocal(MAC_KEY);
  const next = JSON.stringify({ ip: a.ip, port: a.port, key: a.key });
  if (prev !== next) writeLocal(MAC_KEY, next);
}
const sameAddress = (a: DirectAddress | null | undefined, b: DirectAddress | null | undefined) =>
  !!a && !!b && a.ip === b.ip && a.port === b.port && a.key === b.key;

/** This device's Wi-Fi address and the addresses on the same Wi-Fi with a journal app listening. */
export async function scanWifi(): Promise<{ ip: string | null; found: string[] }> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ ip: string | null; found: string[] }>("direct_scan", { port: PORT });
}

/** One request to the other device's app; throws when it can't be reached or refuses. */
async function postTo<T>(address: DirectAddress, path: string, body: unknown, timeoutMs: number, live?: Set<AbortController>): Promise<T> {
  const { fetch } = await import("@tauri-apps/plugin-http");
  const ctl = new AbortController();
  live?.add(ctl);
  const t = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${address.ip}:${address.port}${path}`, {
      method: "POST",
      headers: { "X-Journal-Key": address.key, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
      connectTimeout: Math.min(3000, timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = (await res.json()) as T & { ok?: boolean; error?: string };
    if (out.ok === false) throw new Error(out.error ?? "refused");
    return out;
  } finally {
    window.clearTimeout(t);
    live?.delete(ctl);
  }
}

/** Answers the requests direct.rs hands to the page. */
async function serveRequests(answer: (path: string, body: Body) => Promise<unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ id: number; path: string; body: Body }>("direct-req", async (e) => {
    const result = await answer(e.payload.path, e.payload.body).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    await invoke("direct_reply", { id: e.payload.id, result }).catch(() => {});
  });
}

type Body = {
  records?: SyncRecord[];
  fresh?: boolean;
  typing?: TypingMsg[];
  hash?: string;
  data?: string;
  clip?: Clip;
  /** Hashes whose bytes the phone sends right after this push. */
  sending?: string[];
  probe?: boolean;
  ip?: string | null;
  port?: number;
} | null;

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

/** Hashes of the files among these records that are small enough to go over the link. */
const fileHashes = (records: SyncRecord[]) =>
  records.flatMap((r) => (r.meta.kind === "file" && r.event.op === "create" && r.meta.file.size <= MAX_DIRECT_FILE ? [r.meta.file.hash] : []));

function newKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function savedKey() {
  let k = readLocal("journal.directKey");
  if (!k) writeLocal("journal.directKey", (k = newKey()));
  return k;
}

/** What a press of ⚡ Connect came to. */
export type ConnectResult = "linked" | "not-found" | "no-wifi" | "no-key";

export interface Host {
  /** The address to put in the presence file (null when the Mac isn't on a network). */
  address(): Promise<DirectAddress | null>;
  /** True while the phone is linked. */
  linked(): boolean;
  /** Something was saved: answer a waiting pull now. */
  notify(): void;
  /** Letter-by-letter typing for the phone. */
  sendTyping(m: TypingMsg): void;
  /** A clip for the phone's clipboard. */
  sendClip(c: Clip): void;
  /** ⚡ Connect: find the phone app on this Wi-Fi and ask it to connect now. */
  ring(): Promise<ConnectResult>;
  stop(): void;
}

export interface HostOptions {
  onImported: () => void;
  /** The phone linked (true) or left (false). */
  onLink: (up: boolean) => void;
  onClip: (c: Clip) => void;
}

/** Mac: listen for the phone. */
export async function startHost(store: JournalStore, opts: HostOptions): Promise<Host> {
  const { invoke } = await import("@tauri-apps/api/core");
  const key = savedKey();
  let seen = 0;
  let up = false;
  let sent: Set<string> | null = null;
  let wake: (() => void) | null = null;
  let typing: TypingMsg[] = [];
  let clips: Clip[] = [];
  /** Bytes this Mac lacks, asked of the phone in pull answers (when last asked). */
  const asked = new Map<string, number>();
  /** Look for missing bytes at the next pull (a new link, or the phone sent new files). */
  let checkWant = true;
  let wantAt = 0;
  const onLogged = () => wake?.();
  window.addEventListener(EVENT_LOGGED, onLogged);

  const setLinked = (v: boolean) => {
    if (v === up) return;
    up = v;
    opts.onLink(v);
  };
  const heard = () => {
    seen = Date.now();
    setLinked(true);
  };
  // A phone that went quiet without saying goodbye (Wi-Fi lost) stops counting as linked.
  const quiet = window.setInterval(() => up && Date.now() - seen > LINK_FRESH_MS && setLinked(false), 5000);

  const answer = async (path: string, body: Body) => {
    if (path === "/hello") {
      if (!body?.probe) heard();
      if (body?.ip) writeLocal(PHONE_KEY, body.ip);
      return { ok: true, device: store.deviceId };
    }
    if (path === "/bye") {
      seen = 0;
      sent = null;
      setLinked(false);
      wake?.();
      return { ok: true };
    }
    if (!["/typing", "/clip", "/push", "/file", "/file-put", "/pull"].includes(path)) return { ok: false, error: "unknown" };
    heard();
    if (path === "/typing") {
      for (const m of body?.typing ?? []) receiveTyping(m);
      return { ok: true };
    }
    if (path === "/clip") {
      if (body?.clip) opts.onClip(body.clip);
      return { ok: true };
    }
    if (path === "/push") {
      // The phone sends these bytes right behind the push: don't ask for them as well.
      for (const h of body?.sending ?? []) asked.set(h, Date.now());
      const plan = await importRecords(store, body?.records ?? []);
      if (plan.events.length) opts.onImported();
      if (plan.files.length) {
        checkWant = true;
        wake?.();
      }
      return { ok: true, imported: plan.events.length };
    }
    if (path === "/file") return { ok: true, data: body?.hash ? await fileData(store, body.hash) : null };
    if (path === "/file-put") {
      const took = body?.hash && body.data ? await takeFile(store, body.hash, body.data) : false;
      if (took) opts.onImported();
      return { ok: true, took };
    }
    if (path === "/pull") {
      // A new connection: what happened before it goes by Drive (the phone syncs Drive as it connects).
      if (!sent || body?.fresh) {
        sent = new Set(await store.ownEventIds());
        checkWant = true;
      }
      const until = Date.now() + HOLD_MS;
      while (Date.now() < until && sent) {
        // Bytes that didn't come when first asked are asked for again now and then.
        if (Date.now() - wantAt > ASK_AGAIN_MS) checkWant = true;
        const records = await unsent(store, sent);
        const want = checkWant ? await missingHashes(store, asked) : [];
        if (checkWant) wantAt = Date.now();
        checkWant = false;
        if (records.length || typing.length || want.length || clips.length) {
          const t = typing;
          const c = clips;
          typing = [];
          clips = [];
          return { ok: true, records, typing: t, want, clips: c };
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

  const unlisten = await serveRequests(answer);

  const address = async () => {
    const r = await invoke<{ ip: string | null; port: number }>("direct_start", { key }).catch(() => null);
    return r?.ip ? { ip: r.ip, port: r.port, key } : null;
  };

  return {
    address,
    linked: () => up,
    notify: () => wake?.(),
    sendTyping(m) {
      // Only the newest full copy per note is worth keeping in the queue.
      if (m.full !== undefined) typing = typing.filter((t) => t.key !== m.key);
      typing.push(m);
      wake?.();
    },
    sendClip(c) {
      clips = [...clips.slice(-2), c];
      wake?.();
    },
    async ring() {
      if (up && Date.now() - seen < 5000) return "linked";
      const me = await address();
      if (!me) return "no-wifi";
      const before = seen;
      const ringAt = (ip: string) =>
        postTo({ ip, port: PORT, key }, "/ring", { ip: me.ip, port: me.port }, 2500).then(
          () => true,
          () => false,
        );
      const last = readLocal(PHONE_KEY);
      let rang = !!last && last !== me.ip && (await ringAt(last));
      if (!rang) {
        const { found } = await scanWifi().catch(() => ({ found: [] as string[] }));
        rang = (await Promise.all(found.filter((ip) => ip !== me.ip && ip !== last).map(ringAt))).some(Boolean);
      }
      if (!rang) return up ? "linked" : "not-found";
      // The phone connects right after it's rung.
      for (let i = 0; i < 40; i++) {
        if (up && seen > before) return "linked";
        await sleep(200);
      }
      return up ? "linked" : "not-found";
    },
    stop: () => {
      window.removeEventListener(EVENT_LOGGED, onLogged);
      window.clearInterval(quiet);
      unlisten();
    },
  };
}

export interface Ringer {
  /** This phone's Wi-Fi address (null off Wi-Fi). */
  readonly ip: string | null;
  /** The Mac's key changed (or became known): listen with it. */
  setKey(key: string): void;
  stop(): void;
}

/**
 * Phone: listen while the app is open, so the Mac's ⚡ Connect can ring it. Only a request with the
 * Mac's key gets in; it carries the Mac's address, and `onRing` connects to it.
 */
export async function startRinger(key: string, onRing: (a: DirectAddress) => void): Promise<Ringer> {
  const { invoke } = await import("@tauri-apps/api/core");
  let current = key;
  const listenWith = (k: string) => invoke<{ ip: string | null }>("direct_start", { key: k }).catch(() => null);
  const started = await listenWith(key);
  const unlisten = await serveRequests(async (path, body) => {
    if (path === "/ring" && body?.ip && document.visibilityState !== "hidden") {
      onRing({ ip: body.ip, port: body.port || PORT, key: current });
      return { ok: true };
    }
    return { ok: false, error: path === "/ring" ? "asleep" : "unknown" };
  });
  return {
    ip: started?.ip ?? null,
    setKey(k) {
      if (k === current) return;
      current = k;
      void listenWith(k);
    },
    stop: () => unlisten(),
  };
}

/** Phone: the Mac app on this Wi-Fi, if it's open: its last address first, then a look around. */
export async function findMac(hint?: DirectAddress | null): Promise<{ address: DirectAddress | null; result: ConnectResult }> {
  const saved = savedMac();
  const key = hint?.key ?? saved?.key;
  if (!key) return { address: null, result: "no-key" };
  const hello = (a: DirectAddress) =>
    postTo(a, "/hello", { probe: true }, 2500).then(
      () => true,
      () => false,
    );
  const tried = new Set<string>();
  for (const a of [hint, saved]) {
    if (!a || tried.has(a.ip)) continue;
    tried.add(a.ip);
    if (await hello(a)) return { address: a, result: "linked" };
  }
  const { ip, found } = await scanWifi().catch(() => ({ ip: null, found: [] as string[] }));
  if (!ip) return { address: null, result: "no-wifi" };
  const port = hint?.port ?? saved?.port ?? PORT;
  const answers = await Promise.all(
    found.filter((x) => !tried.has(x)).map(async (x) => ((await hello({ ip: x, port, key })) ? x : null)),
  );
  const hit = answers.find((x): x is string => !!x);
  return hit ? { address: { ip: hit, port, key }, result: "linked" } : { address: null, result: "not-found" };
}

export interface Client {
  /** Same Mac address: keep this client. */
  readonly address: DirectAddress;
  /** True while linked. */
  isUp(): boolean;
  /** Something was saved: send it now. */
  notify(): void;
  /** Letter-by-letter typing for the Mac. */
  sendTyping(m: TypingMsg): void;
  /** A clip for the Mac's clipboard. */
  sendClip(c: Clip): void;
  /** Try to connect now instead of after the wait. */
  kick(): void;
  /** Tell the Mac this phone is leaving (it goes back to Drive at once), then stop. */
  bye(): void;
  stop(): void;
}

export interface ClientOptions {
  onImported: () => void;
  /** `true` once connected (then the caller runs a Drive round to catch up), `false` when the link drops. */
  onState: (up: boolean) => void;
  onClip: (c: Clip) => void;
  /** This phone's Wi-Fi address, so the Mac's ⚡ Connect can ring it directly next time. */
  myIp?: () => string | null;
}

/** Phone: connect to the Mac at `address`; it keeps trying (less and less often) while running. */
export function startClient(store: JournalStore, address: DirectAddress, opts: ClientOptions): Client {
  let stopped = false;
  let up = false;
  let sent: Set<string> | null = null;
  let pushing = false;
  let again = false;
  const live = new Set<AbortController>();
  /** Files asked of the Mac (when), so a missing one isn't asked for over and over. */
  const asked = new Map<string, number>();
  /** Files already sent to the Mac on this link. */
  const given = new Set<string>();
  let retryMs = 3000;
  let wakeRetry: (() => void) | null = null;

  const post = <T,>(path: string, body: unknown, timeoutMs: number) => postTo<T>(address, path, body, timeoutMs, live);

  // Photos and GIFs: fetch the bytes this phone lacks from the Mac, one at a time.
  let fetching = false;
  const fetchMissing = async () => {
    if (fetching || stopped || !up) return;
    fetching = true;
    try {
      for (const hash of await missingHashes(store, asked)) {
        if (stopped || !up) break;
        const r = await post<{ data: string | null }>("/file", { hash }, 120_000).catch(() => null);
        if (r?.data && (await takeFile(store, hash, r.data).catch(() => false))) opts.onImported();
      }
    } finally {
      fetching = false;
    }
  };
  // And send the Mac the bytes it asked for (or a new photo right after its record went).
  let sendQueue: string[] = [];
  let sendingFiles = false;
  const sendFiles = async (hashes: string[]) => {
    sendQueue.push(...hashes.filter((h) => !sendQueue.includes(h)));
    if (sendingFiles) return;
    sendingFiles = true;
    try {
      while (sendQueue.length && !stopped && up) {
        const hash = sendQueue.shift()!;
        const data = await fileData(store, hash).catch(() => null);
        if (!data) continue;
        const r = await post<{ took?: boolean }>("/file-put", { hash, data }, 120_000).catch(() => null);
        if (r) given.add(hash);
      }
    } finally {
      sendingFiles = false;
    }
  };

  const setUp = (v: boolean) => {
    if (v === up) return;
    up = v;
    if (!v) {
      sent = null;
      given.clear();
    }
    opts.onState(v);
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
        const files = fileHashes(records).filter((h) => !given.has(h));
        try {
          await post("/push", { records, sending: files }, 30_000);
        } catch (e) {
          sent = before; // not sent: try again (and Drive carries it anyway)
          throw e;
        }
        // A new photo: its bytes go right behind its record, so the Mac shows it at once.
        if (files.length) void sendFiles(files);
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
        await post("/hello", { ip: opts.myIp?.() ?? null }, 4000);
        sent = new Set(await store.ownEventIds());
        retryMs = 3000;
        setUp(true);
        void fetchMissing();
        let fresh = true;
        while (!stopped && up) {
          const r = await post<{ records: SyncRecord[]; typing?: TypingMsg[]; want?: string[]; clips?: Clip[] }>("/pull", { fresh }, HOLD_MS + 10_000);
          fresh = false;
          for (const m of r.typing ?? []) receiveTyping(m);
          for (const c of r.clips ?? []) opts.onClip(c);
          if (r.want?.length) void sendFiles(r.want.filter((h) => !given.has(h)));
          if (r.records?.length) {
            const plan = await importRecords(store, r.records);
            if (plan.events.length) opts.onImported();
            if (plan.files.length) void fetchMissing();
          }
        }
      } catch {
        setUp(false);
      }
      if (stopped) break;
      // Not there (the Mac app closed or another Wi-Fi): try again, less often each time.
      await new Promise<void>((r) => {
        const t = window.setTimeout(r, retryMs);
        wakeRetry = () => (window.clearTimeout(t), r());
      });
      wakeRetry = null;
      retryMs = Math.min(retryMs * 2, 30_000);
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

  const stop = () => {
    stopped = true;
    window.removeEventListener(EVENT_LOGGED, onLogged);
    stopChecker();
    stopFiles();
    wakeRetry?.();
    for (const c of live) c.abort();
    setUp(false);
  };

  return {
    address,
    isUp: () => up,
    notify: () => void push(),
    sendTyping(m) {
      if (m.full !== undefined) typingOut = typingOut.filter((t) => t.key !== m.key);
      typingOut.push(m);
      void flushTyping();
    },
    sendClip(c) {
      if (up) void post("/clip", { clip: c }, 60_000).catch(() => {});
    },
    kick() {
      retryMs = 3000;
      wakeRetry?.();
    },
    bye() {
      const was = up;
      // The goodbye goes out on its own (not through `live`, which stop() aborts).
      if (was) void postTo(address, "/bye", {}, 1500).catch(() => {});
      stop();
    },
    stop,
  };
}

export { sameAddress };
