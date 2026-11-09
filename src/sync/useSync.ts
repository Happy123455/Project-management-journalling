import { useCallback, useEffect, useRef, useState } from "react";
import { coalesce } from "../lib/coalesce";
import type { JournalStore } from "../store";
import { syncOnce, type SyncMemory } from "./engine";
import { repairMergeLosses } from "../lib/repairMerge";
import { showToast } from "../lib/toast";
import { findSyncFolder, pickSyncFolder, type FolderLookup } from "./folders";
import { BEAT_MS, CALM_POLL_MS, HOT_MS, LIVE_POLL_MS, PHONE_BEAT_MS, LIVE_SAVE_MS, openHost, othersRev, readPresence, someoneOpen, writePresence, type Presence } from "./live";
import { setTypingSink } from "./liveTyping";
import { visibleInterval } from "../lib/power";
import {
  canConnect,
  canHost,
  findMac,
  rememberMac,
  sameAddress,
  savedMac,
  startClient,
  startHost,
  startRinger,
  type Client,
  type Clip,
  type ConnectResult,
  type DirectAddress,
  type Host,
  type Ringer,
} from "./direct";
import { receiveClip, setClipSink, startClipWatch } from "./clipboard";
import { setSideNames } from "./merge";

// Clash lines are labelled by device (sync/merge.ts): the Mac hosts the Wi-Fi link, the phone joins it.
setSideNames(canHost() ? "Mac" : "Phone", canHost() ? "Phone" : "Mac");

/** What sync remembers between rounds (what it sent and read), so it only moves what's new. */
const localMemory: SyncMemory = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Full or blocked: the next round just checks the folder again.
    }
  },
};

const EVERY_MS = 3 * 60 * 1000;
const AFTER_SAVE_MS = 15 * 1000;

export type SyncStatus =
  | { state: "off"; reason: string }
  | { state: "needs-folder" }
  | { state: "syncing"; label: string; last: Date | null }
  | { state: "ok"; label: string; last: Date }
  | { state: "error"; label: string; last: Date | null; message: string };

/**
 * Keeps this device in sync through the Google Drive folder: on start, on coming back to the
 * app, every few minutes, and shortly after saves. `onImported` runs when other devices' changes arrived.
 */
export function useSync(store: JournalStore | null, onImported: () => void) {
  const [status, setStatus] = useState<SyncStatus>({ state: "off", reason: "Starting…" });
  /** Both apps open: changes go across within seconds (see live.ts). */
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  /** Connected straight over Wi-Fi (see direct.ts): edits go across in about a second. */
  const [direct, setDirect] = useState(false);
  const directRef = useRef(false);
  const host = useRef<Host | null>(null);
  const client = useRef<Client | null>(null);
  const lan = useRef<DirectAddress | null>(null);
  const myRev = useRef(String(Date.now()));
  const folderCache = useRef<{ found: Extract<FolderLookup, { kind: "ready" }>; at: number } | null>(null);
  const last = useRef<Date | null>(null);
  const afterSave = useRef<number | undefined>(undefined);
  /** Last time an edit was seen arriving or saved here: Drive is watched closely for a minute after. */
  const hotAt = useRef(0);
  const repaired = useRef(false);
  const imported = useRef(onImported);
  imported.current = onImported;

  const run = useCallback(
    () =>
      coalesce(async () => {
        if (!store) return;
        const found = await findSyncFolder(store.deviceId);
        if (found.kind === "pick") return setStatus({ state: "needs-folder" });
        if (found.kind === "unavailable") return setStatus({ state: "off", reason: found.reason });
        folderCache.current = { found, at: Date.now() };
        setStatus({ state: "syncing", label: found.label, last: last.current });
        try {
          const result = await syncOnce(store, found.folder, localMemory);
          // New edits went out: tell an open app on the other device to fetch them now.
          if (result.exported) {
            myRev.current = String(Date.now());
            void writePresence(found.folder, store.deviceId, { at: Date.now(), rev: myRev.current, lan: lan.current ?? undefined }).catch(() => {});
          }
          last.current = new Date();
          setStatus({ state: "ok", label: found.label, last: last.current });
          if (result.files) window.dispatchEvent(new Event("journal:files-arrived"));
          if (result.imported || result.files) imported.current();
          // Once per launch, after the first round (so this device has both sides' history): put
          // back link cards and media the old merge dropped. Never while typing.
          const typing = !!document.activeElement?.closest?.(".tiptap, .source-text");
          if (!repaired.current && !typing) {
            repaired.current = true;
            await window.__journalFlush?.();
            const back = await repairMergeLosses(store).catch(() => 0);
            if (back) {
              showToast(`Brought back ${back} ${back === 1 ? "link or photo" : "links and photos"} an earlier sync had dropped`);
              imported.current();
            }
          }
        } catch (e) {
          setStatus({ state: "error", label: found.label, last: last.current, message: e instanceof Error ? e.message : String(e) });
        }
      }),
    [store],
  );
  const syncNow = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    syncNow.current = run();
  }, [run]);

  useEffect(() => {
    if (!store) return;
    void syncNow.current();
    // Every few minutes while the app is on screen; never in the background (battery).
    const stopTimer = visibleInterval(() => void syncNow.current(), EVERY_MS);
    // Coming back to the app: sync once things have settled, not in the same moment the page is
    // redrawn (that stalled the first touches after returning from YouTube or another app).
    // Leaving it: the page saves (App.tsx) and then sends the edits to Drive once, before the
    // phone lets the app sleep (see lib/power.ts).
    let back: number | undefined;
    const onVisible = () => {
      window.clearTimeout(back);
      back = window.setTimeout(() => void syncNow.current(), document.visibilityState === "visible" ? 2500 : 1200);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(back);
      stopTimer();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [store]);

  // Live mode: say this app is open, watch for the other device's app, and while both are open
  // look for its changes every couple of seconds. Over that, the direct Wi-Fi link (direct.ts):
  // the phone connects to the Mac as soon as it knows where it is (its last address, at once, then
  // the Mac's presence file), and either side's ⚡ Connect finds the other on the Wi-Fi.
  const connectRef = useRef<() => Promise<ConnectResult>>(async () => "not-found");
  useEffect(() => {
    if (!store) return;
    const me = store.deviceId;
    const known = new Map<string, { stamp: string; p: Presence | null }>();
    let lastRev: string | null = null;
    let stopped = false;
    let timer: number | undefined;
    let lastBeat = 0;
    let myIp: string | null = null;
    let ringer: Ringer | null = null;
    const folder = async () => {
      const c = folderCache.current;
      if (c && Date.now() - c.at < 5 * 60_000) return c.found.folder;
      const found = await findSyncFolder(me);
      if (found.kind !== "ready") return null;
      folderCache.current = { found, at: Date.now() };
      return found.folder;
    };
    let sinkLink: Client | Host | null = null;
    const showDirect = (v: boolean) => {
      const link = v ? (client.current ?? host.current) : null;
      if (link !== sinkLink) {
        sinkLink = link;
        setTypingSink(me, link ? (m) => link.sendTyping(m) : null);
        setClipSink(me, link ? (c) => link.sendClip(c) : null, canHost() ? "your phone" : "your Mac");
      }
      if (v === directRef.current) return;
      directRef.current = v;
      setDirect(v);
      // Off the link: Drive takes over at once (and catches up what the link carried).
      if (!v) void syncNow.current();
    };
    const onClip = (c: Clip) => void receiveClip(c);
    startClipWatch();
    // Mac: take the phone's direct connections, whether or not the window is in front.
    if (canHost())
      void startHost(store, { onImported: () => imported.current(), onLink: showDirect, onClip }).then(
        (h) => (stopped ? h.stop() : (host.current = h)),
        () => {},
      );
    /** Phone: listen, so the Mac's ⚡ Connect can ring this phone (once its key is known). */
    let ringing = false;
    const ensureRinger = (key: string) => {
      if (ringer) return ringer.setKey(key);
      if (ringing) return;
      ringing = true;
      void startRinger(key, (at) => linkTo(at, true)).then(
        (r) => (stopped ? r.stop() : ((ringer = r), (myIp = r.ip))),
        () => (ringing = false),
      );
    };
    /** Phone: connect to the Mac at `at` (keeps a working link; a new address replaces a dead one). */
    const linkTo = (at: DirectAddress, force = false) => {
      if (stopped || document.visibilityState === "hidden") return;
      rememberMac(at);
      ensureRinger(at.key);
      const cur = client.current;
      if (cur && sameAddress(cur.address, at)) return void (force && cur.kick());
      if (cur?.isUp() && !force) return;
      cur?.stop();
      client.current = startClient(store, at, {
        onImported: () => imported.current(),
        onState: (up) => {
          showDirect(up);
          if (up) void syncNow.current(); // catch up on what happened before the link
        },
        onClip,
        myIp: () => myIp,
      });
    };
    if (canConnect()) {
      // The Mac's last address: try it right away, without waiting for Drive.
      const saved = savedMac();
      if (saved) linkTo(saved);
    }
    connectRef.current = async () => {
      if (canHost()) {
        // Tell the phone through Drive too (it reads it when it next looks), then ring it.
        const f = folderCache.current?.found.folder;
        if (f && host.current) {
          lan.current = await host.current.address();
          void writePresence(f, me, { at: Date.now(), rev: myRev.current, lan: lan.current ?? undefined }).catch(() => {});
        }
        return host.current ? host.current.ring() : "not-found";
      }
      if (!canConnect()) return "not-found";
      if (client.current?.isUp()) return "linked";
      const f = await folder().catch(() => null);
      if (f) await readPresence(f, me, known).catch(() => {});
      const { address, result } = await findMac(openHost(known) ?? null);
      if (!address) return result;
      linkTo(address, true);
      for (let i = 0; i < 30; i++) {
        if (client.current?.isUp()) return "linked";
        await new Promise((r) => window.setTimeout(r, 200));
      }
      return client.current?.isUp() ? "linked" : "not-found";
    };
    const tick = async () => {
      if (stopped) return;
      // The Mac keeps its presence fresh in the background too (no battery to save), so the phone
      // still sees it while its window is behind others.
      const visible = document.visibilityState === "visible" || canHost();
      try {
        const f = visible ? await folder() : null;
        if (f) {
          if (Date.now() - lastBeat > (canHost() ? BEAT_MS : PHONE_BEAT_MS)) {
            lastBeat = Date.now();
            // The Mac's Wi-Fi address can change (another network); look it up with each beat.
            if (host.current) lan.current = await host.current.address();
            await writePresence(f, me, { at: Date.now(), rev: myRev.current, lan: lan.current ?? undefined });
          }
          await readPresence(f, me, known);
          if (host.current) showDirect(host.current.linked());
          // Phone: connect straight to the Mac while its app is open.
          if (canConnect()) {
            const at = openHost(known);
            if (at) linkTo(at);
          }
          const open = someoneOpen(known);
          if (open !== liveRef.current) {
            liveRef.current = open;
            setLive(open);
          }
          const rev = othersRev(known);
          if (lastRev !== null && rev !== lastRev && open) {
            hotAt.current = Date.now();
            void syncNow.current();
          }
          lastRev = rev;
        }
      } catch {
        folderCache.current = null; // e.g. the Drive sign-in expired: look the folder up again
      }
      // Connected directly: Drive is only the backup, so it needn't be watched closely.
      // In the background nothing is watched at all on the phone: the loop starts again when the app is back.
      // Both open over Drive: every 2 s only while edits are flowing, else every 10 s (8 Nov: a
      // Mac left open kept the phone asking Drive every 2 s all day, ~1,800 requests an hour).
      const livePoll = Date.now() - hotAt.current < HOT_MS ? LIVE_POLL_MS : CALM_POLL_MS;
      if (!stopped && (canHost() || document.visibilityState !== "hidden")) timer = window.setTimeout(tick, liveRef.current && !directRef.current ? livePoll : directRef.current && !canHost() ? 60_000 : 15_000);
    };
    timer = window.setTimeout(tick, 4000);
    // Going to the background or closing: tell the other device right away.
    const bye = () => {
      const f = folderCache.current?.found.folder;
      if (f) void writePresence(f, me, { at: Date.now(), rev: myRev.current, closed: true }).catch(() => {});
      lastBeat = 0;
      // Phone in the background: drop the link (it comes back on return); Drive carries on.
      client.current?.bye();
      client.current = null;
    };
    const onVisible = () => {
      // The Mac stays linked while its window is hidden; it only says goodbye when it quits.
      if (canHost()) return;
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timer);
        bye();
      } else {
        window.clearTimeout(timer);
        timer = window.setTimeout(tick, 500);
        const saved = savedMac();
        if (saved) linkTo(saved);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", bye);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      client.current?.stop();
      client.current = null;
      host.current?.stop();
      host.current = null;
      ringer?.stop();
      setTypingSink(me, null);
      setClipSink(me, null);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", bye);
    };
  }, [store]);

  /** Call after a save; syncs once things have been quiet for a moment (right away in live mode). */
  const afterSaved = useCallback(() => {
    window.clearTimeout(afterSave.current);
    hotAt.current = Date.now();
    client.current?.notify();
    host.current?.notify();
    // Connected directly the edit is already across; Drive gets it a little later as the backup.
    const delay = directRef.current ? AFTER_SAVE_MS : liveRef.current ? LIVE_SAVE_MS : AFTER_SAVE_MS;
    afterSave.current = window.setTimeout(() => void syncNow.current(), delay);
  }, []);

  const chooseFolder = useCallback(async () => {
    if (await pickSyncFolder()) await syncNow.current();
  }, []);

  /** ⚡ Connect: find the other device's open app on this Wi-Fi and link now. */
  const connect = useCallback(() => connectRef.current(), []);

  return { status, live, direct, syncNow: () => syncNow.current(), afterSaved, chooseFolder, connect };
}
