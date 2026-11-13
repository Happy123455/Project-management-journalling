import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor, JSONContent } from "@tiptap/react";
import {
  branchOf, byTime, entryStart, itemsFromBlocks, layoutCanvas, momentsOf, NODE_H, NODE_W, noonOf, PILL_W, ROOT_W, shortWhen, sliderTicks,
  type CanvasItem, type CanvasLayout, type GroupMode, type PlacedItem,
} from "../lib/canvas";
import { dayColor, entryFor } from "../lib/projectDays";
import { skyAt } from "../lib/sky";
import { formatTimestamp } from "../lib/timestamp";
import { readAloud, stopReading, subscribeReadAloud } from "../lib/readAloud";
import { loadAiSettings } from "../ai/settings";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { docText } from "../lib/words";
import { GRAPH_PREFIX, loadoutFrom, loadoutPageContent, parseLoadout, type Loadout } from "../lib/canvasLoadout";
import type { JournalStore } from "../store";
import "./canvas.css";
import { loadCanvasData, sortIntoTopics, summarize, summaryHash, updateCanvasData, type NoteCanvasData, type SummaryScope } from "./canvasData";

/** What a note's canvas shows: a daily note (its own lines) or a page (its own lines and every day's entry for it). */
export interface CanvasSource {
  /** "day:2026-11-13" or "page:<id>": one canvas per note. */
  key: string;
  title: string;
  /** A daily note's date. */
  day?: string;
  store: JournalStore;
  /** Changes when the note or its entries were saved. */
  refreshKey?: unknown;
  /** Opens another day at a line (an entry from a daily note). */
  onOpenDay?: (day: string, line?: string) => void;
  /** A page's last change: when its own lines have no time. */
  updatedAt?: string;
}

type Sel = { kind: "root" } | { kind: "branch"; name: string } | { kind: "item"; key: string };
interface Cam {
  x: number;
  y: number;
  z: number;
}

const GROUPS: { mode: GroupMode; label: string; title: string }[] = [
  { mode: "topics", label: "✨ Topics", title: "Topics sorted by your AI (local model on the Mac)" },
  { mode: "keywords", label: "Words", title: "Lines that share words, no AI needed" },
  { mode: "sections", label: "Sections", title: "The note's headings and label lines" },
  { mode: "tags", label: "Tags", title: "#tags and [[links]] in each line" },
];
const GROUP_KEY = "journal.canvas.group";
const GRAPH_KEY = "journal.canvas.graph";
/** Below this width (the map's, not the window's) the details become a sheet from the bottom. */
const NARROW = 640;
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Only a convenience.
    }
  },
};
const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const hueColor = (h: number, a = 1) => (h < 0 ? `color-mix(in srgb, var(--muted) ${a * 100}%, transparent)` : `hsl(${h} 62% 52% / ${a})`);
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The note as a growing mind map: its lines placed by when they were written, on branches by topic. */
export default function NoteCanvas({ editor, source, onJump, onClose }: { editor: Editor; source: CanvasSource; onJump: (item: CanvasItem) => void; onClose: () => void }) {
  const { store, day, refreshKey } = source;
  const noteTitle = source.title;
  /** A phone: Canvas fills the screen, the bar packs tight, motion is kept cheap. */
  const [phone] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches && window.innerWidth <= 760);

  // ── The note's lines ──
  const [ownDoc, setOwnDoc] = useState<JSONContent>(() => editor.getJSON());
  useEffect(() => {
    let t: number | undefined;
    const on = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setOwnDoc(editor.getJSON()), 700);
    };
    editor.on("update", on);
    return () => {
      window.clearTimeout(t);
      editor.off("update", on);
    };
  }, [editor]);
  const [entries, setEntries] = useState<{ day: string; doc: JSONContent[] }[]>([]);
  const [ready, setReady] = useState(!!day);
  useEffect(() => {
    if (day) return;
    let live = true;
    void store.references("wikilink", noteTitle).then((refs) => {
      const list = refs
        .flatMap((r) => (r.day ? [entryFor(r.day, r.content as never, noteTitle)] : []))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({ day: e.day, doc: (e.doc ?? []) as JSONContent[] }))
        .sort((a, b) => a.day.localeCompare(b.day));
      if (!live) return;
      setEntries(list);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [store, noteTitle, day, refreshKey]);

  // ── Graph loadouts: ready-made graphs (pages "Graph · …") shown instead of the note ──
  const [graphs, setGraphs] = useState<string[]>([]);
  const [graph, setGraphState] = useState<string>(() => ls.get(`${GRAPH_KEY}:${source.key}`) ?? "");
  const [loadout, setLoadout] = useState<Loadout | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    let live = true;
    void store.pageNames().then((names) => live && setGraphs(names.filter((n) => n.startsWith(GRAPH_PREFIX)).sort()));
    return () => {
      live = false;
    };
  }, [store, refreshKey]);
  useEffect(() => {
    if (!graph) return setLoadout(null);
    let live = true;
    void store.getPage(graph).then((page) => {
      if (!live) return;
      const text = page?.content?.content?.[0]?.content?.[0]?.text ?? (page ? JSON.stringify(page.content) : "");
      const d = page ? parseLoadout(page.content?.content?.[0]?.type === "codeBlock" ? text : docText(page.content)) : null;
      setLoadout(d ? loadoutFrom(d, graph.slice(GRAPH_PREFIX.length)) : null);
      if (!d) setStatus(`"${graph}" has no graph in it.`);
    });
    return () => {
      live = false;
    };
  }, [store, graph]);
  const isGraph = !!graph && !!loadout;
  const title = isGraph ? loadout!.title : noteTitle;

  const noteItems = useMemo(() => {
    const out: CanvasItem[] = [];
    entries.forEach((e, i) => out.push(...itemsFromBlocks(e.doc, { day: e.day, self: noteTitle, fallbackMs: entryStart(e.doc, e.day), startOrder: (i + 1) * 100_000 })));
    const earliest = out.length ? Math.min(...out.map((it) => it.ms)) : NaN;
    const fallback = day ? noonOf(day) : Number.isFinite(earliest) ? earliest - 3_600_000 : Date.parse(source.updatedAt ?? "") || Date.now();
    out.unshift(...itemsFromBlocks(ownDoc.content ?? [], { day: day ?? null, self: noteTitle, fallbackMs: fallback }));
    // Keys must be unique (a line copied into two days keeps its id).
    const seen = new Set<string>();
    for (const it of out) {
      let k = it.key;
      for (let n = 2; seen.has(k); n++) k = `${it.key}~${n}`;
      it.key = k;
      seen.add(k);
    }
    return out.sort(byTime);
  }, [entries, ownDoc, noteTitle, day, source.updatedAt]);
  const items = isGraph ? loadout!.items : noteItems;
  /** Topics and summaries are kept per note, and per graph. */
  const dataKey = isGraph ? `graph:${graph}` : source.key;

  // ── Saved topics and summaries ──
  const [data, setData] = useState<NoteCanvasData>({});
  useEffect(() => {
    let live = true;
    void loadCanvasData(store, dataKey).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [store, dataKey, refreshKey]);
  const hasTopics = !!data.topics && Object.keys(data.topics).length > 0;
  const [group, setGroupState] = useState<GroupMode | null>(() => (ls.get(`${GROUP_KEY}:${source.key}`) as GroupMode | null) ?? null);
  const mode: GroupMode = group === "topics" && !hasTopics ? "keywords" : (group ?? (hasTopics ? "topics" : "keywords"));
  const setGroup = (g: GroupMode) => {
    setGroupState(g);
    ls.set(`${GROUP_KEY}:${source.key}`, g);
  };
  const branchMap = useMemo(() => (isGraph ? loadout!.branches : branchOf(items, mode, title, data.topics)), [isGraph, loadout, items, mode, title, data.topics]);
  const L: CanvasLayout = useMemo(() => layoutCanvas(items, branchMap), [items, branchMap]);
  const unsorted = !isGraph && mode === "topics" ? items.filter((it) => !data.topics?.[it.key]).length : 0;

  // ── Time ──
  const moments = useMemo(() => momentsOf(L.items), [L.items]);
  const tMin = moments[0] ?? Date.now();
  const tMax = moments[moments.length - 1] ?? tMin;
  const [cur, setCur] = useState<number>(Infinity);
  const shownCur = Math.min(cur, tMax);
  const atEnd = cur >= tMax;
  const [freshAt, setFreshAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // ── Selection, search, branch focus ──
  const [sel, setSel] = useState<Sel>({ kind: "root" });
  // Details open beside the map when there's room; on a phone they wait for a tap.
  const [panel, setPanel] = useState(false);
  const wide = () => (stageRef.current?.getBoundingClientRect().width ?? 0) > NARROW;
  const [query, setQuery] = useState("");
  const [focusBranch, setFocusBranch] = useState<string | null>(null);
  const [full, setFull] = useState(phone);
  const [more, setMore] = useState(false);
  const slide = useRef(0);
  const slideFrame = useRef(0);
  const byKey = useMemo(() => new Map(L.items.map((it) => [it.key, it])), [L.items]);
  const q = query.trim().toLowerCase();
  const hits = useMemo(() => (q ? new Set(L.items.filter((it) => it.text.toLowerCase().includes(q)).map((it) => it.key)) : null), [q, L.items]);

  // ── Camera ──
  const cam = useRef<Cam>({ x: 0, y: 0, z: 0.7 });
  const placed = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const apply = useCallback((smooth = false) => {
    const w = worldRef.current;
    if (!w) return;
    const { x, y, z } = cam.current;
    w.style.transition = smooth && !reduceMotion() ? "transform 0.5s cubic-bezier(0.2, 0.9, 0.3, 1)" : "";
    w.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${z})`;
    w.dataset.far = z < 0.45 ? "1" : "";
  }, []);
  /** Room the details card takes on the right (wide) or at the bottom (narrow). */
  const covered = (r: { width: number; height: number }) => ({
    right: panelRef.current && r.width > NARROW ? Math.min(380, r.width * 0.44) + 12 : 0,
    bottom: panelRef.current && r.width <= NARROW ? r.height * 0.5 : 0,
  });
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const stageSize = () => stageRef.current?.getBoundingClientRect() ?? { width: 800, height: 500, left: 0, top: 0 };
  const fit = useCallback(
    (smooth = true) => {
      const r = stageSize();
      const z = Math.max(0.12, Math.min(1, Math.min(r.width / L.width, (r.height - 20) / L.height)));
      cam.current = { z, x: (r.width - L.width * z) / 2, y: Math.max(6, (r.height - L.height * z) / 2) };
      apply(smooth);
    },
    [L.width, L.height, apply],
  );
  /** First look: readable size, the newest lines in view. */
  const home = useCallback(() => {
    const r = stageSize();
    const room = r.width - covered(r).right;
    // A phone shows a little more of the map at once (still readable).
    const z = Math.max(0.42, Math.min(phone ? 0.68 : 0.9, (r.height - 20) / L.height));
    const x = L.width * z <= room ? (room - L.width * z) / 2 : room - L.width * z;
    cam.current = { z, x, y: Math.max(6, (r.height - L.height * z) / 2) };
    apply();
  }, [L.width, L.height, apply]);
  const zoomAt = useCallback(
    (f: number, px: number, py: number) => {
      const c = cam.current;
      const z = Math.max(0.1, Math.min(2.6, c.z * f));
      cam.current = { z, x: px - ((px - c.x) * z) / c.z, y: py - ((py - c.y) * z) / c.z };
      apply();
    },
    [apply],
  );
  const focusOn = useCallback(
    (x: number, y: number, w = NODE_W, h = NODE_H) => {
      const r = stageSize();
      const z = Math.max(cam.current.z, 0.8);
      const c = covered(r);
      cam.current = { z, x: (r.width - c.right) / 2 - (x + w / 2) * z, y: (r.height - c.bottom) / 2.2 - (y + h / 2) * z };
      apply(true);
    },
    [apply],
  );
  const placedFor = useRef("");
  useEffect(() => {
    if (!ready || !L.items.length || placedFor.current === dataKey) return;
    placedFor.current = dataKey;
    placed.current = true;
    if (wide()) {
      setPanel(true);
      panelRef.current = true;
    }
    requestAnimationFrame(home);
  }, [ready, L.items.length, home, dataKey]);
  // The stage was moved (full screen in or out): put the world back where it was.
  const firstFull = useRef(true);
  useEffect(() => {
    if (firstFull.current) {
      firstFull.current = false;
      return;
    }
    requestAnimationFrame(() => {
      // New size: the whole map when it reads well that small, else the newest lines.
      const r = stageSize();
      if (Math.min(r.width / L.width, r.height / L.height) >= 0.5) fit(false);
      else home();
    });
    // Only when going in or out of full screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  // Pan, pinch and wheel.
  const gesture = useRef({ pts: new Map<number, { x: number; y: number }>(), pinch: 0, moved: 0 });
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const zoom = e.ctrlKey || e.metaKey || (e.deltaMode !== 0 && !e.shiftKey) || (Math.abs(e.deltaY) >= 50 && Math.abs(e.deltaX) < 2 && !e.shiftKey && e.deltaMode === 0 && Number.isInteger(e.deltaY));
      if (zoom) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), e.clientX - r.left, e.clientY - r.top);
      else {
        cam.current.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        cam.current.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        apply();
      }
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [full, zoomAt, apply]);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".nc-zoom, .nc-panel")) return;
    const g = gesture.current;
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g.moved = 0;
    if (g.pts.size === 2) {
      const [a, b] = [...g.pts.values()];
      g.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
    stageRef.current?.classList.add("dragging");
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    const o = g.pts.get(e.pointerId);
    if (!o) return;
    if (g.pts.size === 1) {
      cam.current.x += e.clientX - o.x;
      cam.current.y += e.clientY - o.y;
      g.moved += Math.abs(e.clientX - o.x) + Math.abs(e.clientY - o.y);
      if (g.moved > (phone ? 10 : 6) && !stageRef.current?.hasPointerCapture(e.pointerId)) stageRef.current?.setPointerCapture(e.pointerId);
      apply();
    }
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pts.size === 2 && g.pinch) {
      const [a, b] = [...g.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = stageSize();
      zoomAt(d / g.pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      g.pinch = d;
      g.moved = 99;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    g.pts.delete(e.pointerId);
    if (g.pts.size < 2) g.pinch = 0;
    if (!g.pts.size) stageRef.current?.classList.remove("dragging");
  };

  // ── Stepping through time ──
  const goTo = useCallback(
    (ms: number, follow: boolean) => {
      setCur(ms);
      setFreshAt(ms);
      if (!follow) return;
      const fresh = L.items.filter((it) => it.ms === ms);
      if (fresh.length) {
        focusOn(fresh[0].x, fresh[0].y);
        setSel({ kind: "item", key: fresh[0].key });
      }
    },
    [L.items, focusOn],
  );
  const step = useCallback(
    (dir: 1 | -1): boolean => {
      const at = Math.min(cur, tMax);
      const t = dir > 0 ? moments.find((m) => m > at) : [...moments].reverse().find((m) => m < at);
      if (t === undefined) return false;
      goTo(t, true);
      return true;
    },
    [cur, tMax, moments, goTo],
  );
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      if (!stepRef.current(1)) setPlaying(false);
    }, 950 / speed);
    return () => window.clearInterval(id);
  }, [playing, speed]);
  const play = () => {
    if (playing) return setPlaying(false);
    if (atEnd) {
      setCur(tMin - 1);
      setFreshAt(null);
      fit(false);
      window.setTimeout(() => setPlaying(true), 350);
      return;
    }
    setPlaying(true);
  };

  // ── AI and voice ──
  const [busy, setBusy] = useState<string>("");
  const [status, setStatus] = useState("");
  const [reading, setReading] = useState(false);
  const readingMine = useRef(false);
  useEffect(
    () =>
      subscribeReadAloud((s) => {
        if (s.status === "idle") readingMine.current = false;
        setReading(s.status !== "idle" && readingMine.current);
      }),
    [],
  );
  const ctx = useMemo(() => {
    if (sel.kind === "item") {
      const it = byKey.get(sel.key);
      if (it) return { key: `i:${it.key}`, items: [it] as CanvasItem[], scope: { kind: "item", branch: it.branch } as SummaryScope };
    }
    if (sel.kind === "branch") {
      const b = L.branches.find((x) => x.name === sel.name);
      if (b) return { key: `b:${mode}:${b.name}`, items: b.items as CanvasItem[], scope: { kind: "branch", name: b.name } as SummaryScope };
    }
    return { key: "root", items: L.items as CanvasItem[], scope: { kind: "root", title } as SummaryScope };
  }, [sel, byKey, L.branches, L.items, mode, title]);
  const saved = data.summaries?.[ctx.key];
  const summary = saved && saved.h === summaryHash(ctx.items) ? saved : null;
  const stale = saved && !summary;
  const aiOn = loadAiSettings().enabled;

  const doSummarize = async () => {
    if (busy || !ctx.items.length) return;
    const key = ctx.key;
    setBusy(`sum:${key}`);
    setStatus("Summarizing…");
    try {
      const { text, by } = await summarize(ctx.scope, ctx.items, title);
      if (!text) throw new Error("The AI gave an empty answer.");
      const h = summaryHash(ctx.items);
      setData((d) => ({ ...d, summaries: { ...d.summaries, [key]: { h, text, by, at: new Date().toISOString() } } }));
      setStatus(`Summary by ${by}.`);
      void updateCanvasData(store, dataKey, (d) => ({ ...d, summaries: { ...d.summaries, [key]: { h, text, by, at: new Date().toISOString() } } }), by).catch(() => {});
    } catch (e) {
      setStatus(`Couldn't summarize: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };
  const listen = () => {
    if (reading) {
      stopReading();
      return;
    }
    const text = summary?.text || ctx.items.map((it) => it.text).join(".\n");
    if (!text.trim()) return;
    readingMine.current = true;
    readAloud(text);
    setStatus(summary ? "Reading the summary." : "Reading the lines (no summary yet).");
  };
  const sortTopics = async (all: boolean) => {
    if (busy) return;
    setBusy("topics");
    const todo = all ? items : items.filter((it) => !data.topics?.[it.key]);
    setStatus(`Sorting ${todo.length} lines into topics…`);
    try {
      const { topics, by } = await sortIntoTopics(store, title, todo, all ? {} : (data.topics ?? {}), (done, total, who) =>
        setStatus(total > 1 ? `Sorting into topics with ${who}… ${done} of ${total}` : `Sorted with ${who}.`),
      );
      // Lines no longer in the note drop out of the saved topics.
      const live = new Set(items.map((it) => it.key));
      const kept = Object.fromEntries(Object.entries(topics).filter(([k]) => live.has(k)));
      const next = await updateCanvasData(store, source.key, (d) => ({ ...d, topics: kept, topicsBy: by, topicsAt: new Date().toISOString() }), by);
      setData(next);
      setGroup("topics");
      setStatus(`Sorted into ${new Set(Object.values(kept)).size} topics by ${by}.`);
    } catch (e) {
      setStatus(`Couldn't sort into topics: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };

  // ── Graphs ──
  const setGraph = (g: string) => {
    setGraphState(g);
    ls.set(`${GRAPH_KEY}:${source.key}`, g);
    setPlaying(false);
    setCur(Infinity);
    setFreshAt(null);
    setSel({ kind: "root" });
    setFocusBranch(null);
    setQuery("");
    setStatus("");
  };
  /** A graph from a file (the prompt map's .html, or its .json): saved as a page, so the phone has it too. */
  const importGraph = async (file: File) => {
    try {
      const d = parseLoadout(await file.text());
      if (!d) return setStatus(`No graph found in ${file.name}.`);
      const name = (d.title || file.name.replace(/\.(html?|json)$/i, "").replace(/[_-]+/g, " ")).trim().slice(0, 60) || "Graph";
      const pageTitle = `${GRAPH_PREFIX}${name}`;
      const page = await store.ensurePage(pageTitle);
      await store.savePage({ id: page.id, content: loadoutPageContent(d), plainText: `Graph: ${name} (${d.segs.length} nodes)` });
      setGraphs((g) => [...new Set([...g, pageTitle])].sort());
      setGraph(pageTitle);
      setStatus(`Added "${name}": ${d.segs.length} nodes on ${d.features.length} branches.`);
    } catch (e) {
      setStatus(`Couldn't add the graph: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Selecting ──
  const pick = useCallback(
    (s: Sel, focus = true) => {
      setSel(s);
      setPanel(true);
      if (!focus) return;
      if (s.kind === "item") {
        const it = byKey.get(s.key);
        if (it) focusOn(it.x, it.y);
      } else if (s.kind === "branch") {
        const b = L.branches.find((x) => x.name === s.name);
        if (b) focusOn(L.pillX, b.y + b.h / 2 - 17, PILL_W, 34);
      }
    },
    [byKey, L.branches, L.pillX, focusOn],
  );
  const openInNote = (it: CanvasItem) => {
    if (isGraph) return;
    if (full && !phone) setFull(false);
    if (it.day && it.day !== day) source.onOpenDay?.(it.day, it.text.split("\n")[0]);
    else onJump(it);
  };

  // Esc (and the phone's Back) in full screen: the details first, then full screen (on the phone, Canvas).
  useEscapeToClose(() => (panelRef.current ? setPanel(false) : phone ? onClose() : setFull(false)), full);

  // Keys on the map (not while typing in the search).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const r = stageSize();
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === " ") play();
    else if (e.key === "f") fit();
    else if (e.key === "+" || e.key === "=") zoomAt(1.25, r.width / 2, r.height / 2);
    else if (e.key === "-") zoomAt(0.8, r.width / 2, r.height / 2);
    else if (e.key === "Escape" && !full && panel) setPanel(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // ── Drawing ──
  const branchByName = useMemo(() => new Map(L.branches.map((b) => [b.name, b])), [L.branches]);
  const dot = useMemo(() => new Map(L.items.map((it) => [it.key, skyAt(it.ms).bg])), [L.items]);
  const edges = useMemo(() => {
    const out: { d: string; ms: number; hue: number; main?: boolean; branch: string }[] = [];
    const rx = L.root.x + ROOT_W;
    for (const b of L.branches) {
      const py = b.y + b.h / 2;
      out.push({ d: `M${rx},${L.root.y} C${rx + 40},${L.root.y} ${L.pillX - 40},${py} ${L.pillX},${py}`, ms: b.ms, hue: b.hue, main: true, branch: b.name });
      b.items.forEach((it, k) => {
        const ey = it.y + NODE_H / 2;
        if (k === 0) {
          const sx = L.pillX + PILL_W;
          const mid = Math.max(sx + 16, it.x - 40);
          out.push({ d: `M${sx},${py} H${mid} C${mid + 22},${py} ${it.x - 18},${ey} ${it.x},${ey}`, ms: it.ms, hue: b.hue, branch: b.name });
          return;
        }
        const p = b.items[k - 1];
        const sy = p.y + NODE_H / 2;
        if (it.x > p.x + 4) {
          const sx = p.x + NODE_W;
          const mid = Math.max(sx + 10, it.x - 28);
          out.push({ d: `M${sx},${sy} H${mid} C${mid + 16},${sy} ${it.x - 12},${ey} ${it.x},${ey}`, ms: it.ms, hue: b.hue, branch: b.name });
        } else out.push({ d: `M${p.x},${sy} C${p.x - 16},${sy} ${it.x - 16},${ey} ${it.x},${ey}`, ms: it.ms, hue: b.hue, branch: b.name });
      });
    }
    return out;
  }, [L]);

  const shownCount = L.items.filter((it) => it.ms <= shownCur).length;
  const shownBranches = L.branches.filter((b) => b.ms <= shownCur).length;
  const ticks = useMemo(() => sliderTicks(tMin, tMax, L.unit, 5), [tMin, tMax, L.unit]);
  const selItem = sel.kind === "item" ? byKey.get(sel.key) : undefined;
  // While playing (or stepping), what just appeared: a line at the bottom instead of the whole card.
  const caption = freshAt != null ? L.items.find((it) => it.ms === freshAt) : undefined;
  const selInfo = selItem && isGraph ? loadout!.info.get(selItem.key) : undefined;
  const selBranch = sel.kind === "branch" ? branchByName.get(sel.name) : selItem ? branchByName.get(selItem.branch) : undefined;
  const dim = (it: PlacedItem) => (hits ? !hits.has(it.key) : focusBranch ? it.branch !== focusBranch : false);

  if (!items.length) {
    return (
      <div className="note-canvas nc-empty">
        {phone && (
          <button type="button" onClick={onClose}>‹ Back to the note</button>
        )}
        <p>Nothing to map yet. Write a few lines (or link days to this note with [[{title}]]) and they'll grow here as a mind map.</p>
      </div>
    );
  }

  const body = (
    <div className={`note-canvas${full ? " nc-is-full" : ""}`} onKeyDown={onKeyDown}>
      <div className="nc-bar">
        <div className="nc-row">
          {phone && (
            <button type="button" className="nc-close" onClick={onClose} aria-label="Back to the note">‹</button>
          )}
          <button type="button" className="nc-play" onClick={play} aria-label={playing ? "Pause" : "Play how this note grew"}>
            {playing ? "❚❚" : "▶"} <span className="nc-l">{playing ? "Pause" : "Play"}</span>
          </button>
          <button type="button" className="nc-speed" onClick={() => setSpeed((s) => (s >= 4 ? 1 : s * 2))} title="Playing speed">{speed}×</button>
          <button type="button" className="nc-step" onClick={() => (setPlaying(false), step(-1))} aria-label="Earlier line" disabled={shownCur <= tMin}>◀</button>
          <div className="nc-slider">
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.round((tMax - tMin) / 60_000))}
              step={1}
              value={Math.round((shownCur - tMin) / 60_000)}
              aria-label="Show the map as it was at this time"
              onChange={(e) => {
                setPlaying(false);
                const ms = tMin + Number(e.target.value) * 60_000;
                // One redraw a frame, however fast the thumb moves.
                slide.current = ms >= tMax ? Infinity : ms;
                if (!slideFrame.current)
                  slideFrame.current = requestAnimationFrame(() => {
                    slideFrame.current = 0;
                    setCur(slide.current);
                    setFreshAt(null);
                  });
              }}
            />
            <div className="nc-ticks" aria-hidden>
              {ticks.map((t, i) => (
                <span key={i} style={{ left: `${t.at * 100}%` }} className={i === 0 ? "first" : i === ticks.length - 1 ? "last" : ""}>{t.label}</span>
              ))}
            </div>
          </div>
          <button type="button" className="nc-step" onClick={() => (setPlaying(false), step(1))} aria-label="Later line" disabled={atEnd}>▶</button>
          {phone && (
            <button type="button" className={`nc-more${more ? " active" : ""}`} onClick={() => setMore((m) => !m)} aria-expanded={more} aria-label="More: graph, find, branches by">⋯</button>
          )}
        </div>
        <div className="nc-row nc-row2">
          {(!phone || more) && (
            <>
              <select
                className="nc-graph"
                value={isGraph ? graph : ""}
                aria-label="Which graph"
                onChange={(e) => {
                  if (e.target.value === "+") {
                    e.target.value = isGraph ? graph : "";
                    fileRef.current?.click();
                    return;
                  }
                  setGraph(e.target.value);
                }}
              >
                <option value="">🗺️ {noteTitle}</option>
                {graphs.map((g) => (
                  <option key={g} value={g}>🧩 {g.slice(GRAPH_PREFIX.length)}</option>
                ))}
                <option value="+">＋ Add a graph from a file…</option>
              </select>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept=".html,.htm,.json,text/html,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void importGraph(f);
                }}
              />
            </>
          )}
          <span className="nc-now" title="Shown up to">{formatTimestamp(new Date(shownCur))}</span>
          <span className="nc-stats">{shownCount} of {L.items.length} {isGraph ? "nodes" : "lines"} · {shownBranches} branches</span>
          {(!phone || more) && (
            <input className="nc-find" type="search" placeholder="Find…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find words on the map" />
          )}
          {!isGraph && (!phone || more) && (
            <div className="nc-groups" role="radiogroup" aria-label="Branches by">
              {GROUPS.map((g) => (
                <button
                  key={g.mode}
                  type="button"
                  role="radio"
                  aria-checked={mode === g.mode}
                  className={mode === g.mode ? "active" : ""}
                  title={g.title}
                  disabled={g.mode === "topics" && !!busy}
                  onClick={() => {
                    if (g.mode === "topics" && !hasTopics) {
                      if (!aiOn) return setStatus("Turn AI on in Settings → AI to sort lines into topics.");
                      void sortTopics(false);
                      return;
                    }
                    setGroup(g.mode);
                    setFocusBranch(null);
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          )}
          {!phone && (
            <button type="button" className="nc-fullbtn" onClick={() => setFull((f) => !f)} aria-label={full ? "Leave full screen" : "Full screen"} title={full ? "Leave full screen (Esc)" : "Full screen"}>
              {full ? "⤡" : "⛶"}
            </button>
          )}
        </div>
        <div className="nc-chips" role="list" aria-label="Branches">
          {L.branches.map((b) => (
            <button
              key={b.name}
              type="button"
              role="listitem"
              className={`nc-chip${focusBranch === b.name ? " active" : ""}${b.ms > shownCur ? " later" : ""}`}
              style={{ ["--hue" as string]: hueColor(b.hue) }}
              onClick={() => {
                const on = focusBranch === b.name ? null : b.name;
                setFocusBranch(on);
                if (on) pick({ kind: "branch", name: b.name });
              }}
            >
              <i aria-hidden /> {b.name} <small>{b.items.length}</small>
            </button>
          ))}
        </div>
        {(status || busy || unsorted > 0) && (
          <div className="nc-status" role="status">
            {busy === "topics" && <span className="nc-spin" aria-hidden />}
            <span>{status}</span>
            {!busy && unsorted > 0 && (
              <button type="button" onClick={() => void sortTopics(false)}>✨ Sort {unsorted} new line{unsorted > 1 ? "s" : ""}</button>
            )}
          </div>
        )}
      </div>

      <div
        className="nc-stage"
        ref={stageRef}
        tabIndex={0}
        aria-label="Mind map. Arrow keys step through time, space plays, F fits, plus and minus zoom."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(e) => {
          if (gesture.current.moved > (phone ? 10 : 6)) e.stopPropagation();
        }}
      >
        <div className="nc-world" ref={worldRef} style={{ width: L.width, height: L.height }}>
          {L.columns.map((c, i) => (
            <div key={c.bucket} className={`nc-col${i % 2 ? " alt" : ""}${c.gap ? " gap" : ""}`} style={{ left: c.x, width: c.w, height: L.height }}>
              {(c.count > 0 || c.gap || L.unit === "hour") && (
                <div className="nc-col-label">
                  <b>{c.label}</b>
                  {c.sub && <small>{c.sub}</small>}
                </div>
              )}
            </div>
          ))}
          {L.cells.map((c) => {
            const color = L.unit === "day" ? dayColor(c.bucket.slice(0, 10)) : skyAt(c.ms).bg;
            return (
              <div
                key={`${c.branch}|${c.bucket}`}
                className={`nc-cell${c.ms <= shownCur ? " on" : ""}${focusBranch && focusBranch !== c.branch ? " dim" : ""}`}
                style={{ left: c.x, top: c.y, width: c.w, height: c.h, ["--c" as string]: color }}
              />
            );
          })}
          <svg className="nc-edges" width={L.width} height={L.height} aria-hidden>
            {edges.map((e, i) => (
              <path
                key={i}
                d={e.d}
                pathLength={1}
                className={`nc-edge${e.main ? " main" : ""}${e.ms <= shownCur ? " on" : ""}${focusBranch && focusBranch !== e.branch ? " dim" : ""}`}
                style={{ stroke: hueColor(e.hue, 0.75) }}
              />
            ))}
          </svg>
          <button
            type="button"
            className={`nc-root${sel.kind === "root" ? " sel" : ""}`}
            style={{ left: L.root.x, top: L.root.y - 22, width: ROOT_W }}
            onClick={() => pick({ kind: "root" }, false)}
          >
            {title}
          </button>
          {L.branches.map((b) => (
            <button
              key={b.name}
              type="button"
              className={`nc-pill${b.ms <= shownCur ? " on" : ""}${sel.kind === "branch" && sel.name === b.name ? " sel" : ""}${focusBranch && focusBranch !== b.name ? " dim" : ""}`}
              style={{ left: L.pillX, top: b.y + b.h / 2 - 17, width: PILL_W, ["--hue" as string]: hueColor(b.hue) }}
              onClick={() => pick({ kind: "branch", name: b.name }, false)}
              title={b.name}
            >
              <span>{b.name}</span>
              <small>{b.items.length}</small>
            </button>
          ))}
          {L.items.map((it) => (
            <Node
              key={it.key}
              it={it}
              on={it.ms <= shownCur}
              fresh={freshAt === it.ms}
              sel={sel.kind === "item" && sel.key === it.key}
              hit={!!hits?.has(it.key)}
              dim={dim(it)}
              dot={dot.get(it.key)!}
              hue={hueColor(branchByName.get(it.branch)?.hue ?? -1)}
              // On a phone the details cover the lower half: the tapped line moves up into view.
              onPick={() => pick({ kind: "item", key: it.key }, phone)}
              onOpen={() => openInNote(it)}
            />
          ))}
        </div>

        {caption && !panel && (
          <button type="button" className="nc-caption" onClick={() => pick({ kind: "item", key: caption.key }, false)} style={{ ["--hue" as string]: hueColor(branchByName.get(caption.branch)?.hue ?? -1) }}>
            <i aria-hidden />
            <time>{shortWhen(caption.ms)}</time>
            <span>{caption.label}</span>
            <small>{caption.branch}</small>
          </button>
        )}
        <div className="nc-zoom">
          <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.3, stageSize().width / 2, stageSize().height / 2)}>＋</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.3, stageSize().width / 2, stageSize().height / 2)}>－</button>
          <button type="button" aria-label="Fit the whole map" onClick={() => fit()}>⤢</button>
          {!panel && (
            <button type="button" aria-label="Show details" onClick={() => setPanel(true)}>ⓘ</button>
          )}
        </div>

        {panel && (
          <aside className="nc-panel" aria-label="Details">
            <header>
              <div className="nc-panel-title">
                {sel.kind === "root" && (
                  <>
                    <h3>{title}</h3>
                    <p className="nc-meta">
                      {L.items.length} lines · {L.branches.length} branches · {shortWhen(tMin)} → {shortWhen(tMax)}
                    </p>
                  </>
                )}
                {sel.kind === "branch" && selBranch && (
                  <>
                    <h3 style={{ ["--hue" as string]: hueColor(selBranch.hue) }} className="nc-branch-h">{selBranch.name}</h3>
                    <p className="nc-meta">
                      Born {formatTimestamp(new Date(selBranch.ms))}
                      <br />
                      {selBranch.items.length} line{selBranch.items.length > 1 ? "s" : ""} · last {shortWhen(selBranch.items[selBranch.items.length - 1].ms)}
                    </p>
                  </>
                )}
                {selItem && (
                  <>
                    <h3>{selItem.label}</h3>
                    <p className="nc-meta">
                      {formatTimestamp(new Date(selItem.ms))}
                      {selItem.when === "near" ? " (about)" : selItem.when === "guess" ? " (time not written)" : ""}
                      <br />
                      {selInfo ? (
                        <>
                          Prompt {selInfo.prompt + 1} of {selInfo.promptCount}
                          {selInfo.parts.length > 1 ? ` · part ${selInfo.parts.indexOf(selItem.key) + 1} of ${selInfo.parts.length}` : ""}
                          {selInfo.thread ? ` · ${selInfo.thread}` : ""}
                        </>
                      ) : (
                        <>
                          {selItem.day ? `In the note of ${shortWhen(noonOf(selItem.day)).split(",")[0]}` : "In this note"}
                          {selItem.section ? ` · under ${selItem.section}` : ""}
                        </>
                      )}
                    </p>
                  </>
                )}
              </div>
              <button type="button" className="nc-x" aria-label="Close details" onClick={() => setPanel(false)}>✕</button>
            </header>
            <div className="nc-ai">
              <button type="button" onClick={() => void doSummarize()} disabled={!!busy || !aiOn} title={aiOn ? "Summarize with your AI (the local model on the Mac)" : "AI is off in Settings"}>
                {busy.startsWith("sum:") ? <span className="nc-spin" aria-hidden /> : "✨"} {summary ? "Summarize again" : "Summarize"}
              </button>
              <button type="button" onClick={listen} className={reading ? "active" : ""}>
                {reading ? "■ Stop" : "🔊 Listen"}
              </button>
              {selItem && !isGraph && (
                <button type="button" onClick={() => openInNote(selItem)} title="Open this line in its note">↗ Open</button>
              )}
            </div>
            {(summary || stale) && (
              <p className="nc-summary">
                {(summary ?? saved)!.text}
                <small>{stale ? "Written before the latest changes" : `By ${summary!.by}`}</small>
              </p>
            )}
            <div className="nc-panel-body">
              {sel.kind === "root" && (
                <>
                  <p className="nc-hint">
                    Each branch is a {mode === "topics" ? "topic" : mode === "keywords" ? "word that lines share" : mode === "sections" ? "section of the note" : "tag or link"}. Lines sit in the column of the {L.unit} they were written, oldest on the left. Drag the slider or press ▶ to watch the note grow.
                  </p>
                  <div className="nc-list-chips">
                    {L.branches.map((b) => (
                      <button key={b.name} type="button" className="nc-chip" style={{ ["--hue" as string]: hueColor(b.hue) }} onClick={() => pick({ kind: "branch", name: b.name })}>
                        <i aria-hidden /> {b.name} <small>{b.items.length}</small>
                      </button>
                    ))}
                  </div>
                  {hasTopics && !busy && (
                    <button type="button" className="nc-resort" onClick={() => void sortTopics(true)}>↻ Sort all lines into topics again</button>
                  )}
                </>
              )}
              {sel.kind === "branch" && selBranch && (
                <ol className="nc-lines">
                  {selBranch.items.map((it) => (
                    <li key={it.key} className={it.ms > shownCur ? "later" : ""}>
                      <button type="button" onClick={() => pick({ kind: "item", key: it.key })}>
                        <time>{shortWhen(it.ms)}</time>
                        <span>{it.label}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              {selItem && (
                <>
                  {selInfo && selInfo.parts.length > 1 && (
                    <>
                      <div className="nc-label">This prompt was split across</div>
                      <div className="nc-list-chips">
                        {selInfo.parts.map((k) => {
                          const part = byKey.get(k);
                          if (!part) return null;
                          return (
                            <button key={k} type="button" className={`nc-chip${k === selItem.key ? " active" : ""}`} style={{ ["--hue" as string]: hueColor(branchByName.get(part.branch)?.hue ?? -1) }} onClick={() => pick({ kind: "item", key: k })}>
                              <i aria-hidden /> {part.branch}
                            </button>
                          );
                        })}
                      </div>
                      <div className="nc-label">This part, word for word</div>
                    </>
                  )}
                  <div className="nc-text">{highlight(selItem.text, q)}</div>
                  {selInfo && selInfo.parts.length > 1 && (
                    <details className="nc-full-prompt">
                      <summary>The whole prompt (this part marked)</summary>
                      <div className="nc-text">
                        {selInfo.full.slice(0, selInfo.start)}
                        <mark>{selInfo.full.slice(selInfo.start, selInfo.end)}</mark>
                        {selInfo.full.slice(selInfo.end)}
                      </div>
                    </details>
                  )}
                  <div className="nc-nav">
                    {(() => {
                      const b = branchByName.get(selItem.branch);
                      const prev = b?.items[selItem.k - 1];
                      const next = b?.items[selItem.k + 1];
                      return (
                        <>
                          <button type="button" disabled={!prev} onClick={() => prev && pick({ kind: "item", key: prev.key })}>◀ Earlier</button>
                          <button type="button" className="nc-chip" style={{ ["--hue" as string]: hueColor(b?.hue ?? -1) }} onClick={() => pick({ kind: "branch", name: selItem.branch })}>
                            <i aria-hidden /> {selItem.branch} · {selItem.k + 1}/{b?.items.length}
                          </button>
                          <button type="button" disabled={!next} onClick={() => next && pick({ kind: "item", key: next.key })}>Later ▶</button>
                        </>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
  return full ? createPortal(<div className="nc-full-host">{body}</div>, document.body) : body;
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const out: React.ReactNode[] = [];
  const low = text.toLowerCase();
  let i = 0;
  for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) {
    out.push(text.slice(i, at), <mark key={at}>{text.slice(at, at + q.length)}</mark>);
    i = at + q.length;
  }
  out.push(text.slice(i));
  return out;
}

const KIND_ICON: Record<CanvasItem["kind"], string> = { line: "", task: "☐", done: "✓", code: "▣", media: "" };

const Node = memo(function Node({
  it, on, fresh, sel, hit, dim, dot, hue, onPick, onOpen,
}: {
  it: PlacedItem;
  on: boolean;
  fresh: boolean;
  sel: boolean;
  hit: boolean;
  dim: boolean;
  dot: string;
  hue: string;
  onPick: () => void;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`nc-node${on ? " on" : ""}${fresh ? " fresh" : ""}${sel ? " sel" : ""}${hit ? " hit" : ""}${dim ? " dim" : ""} k-${it.kind}`}
      style={{ left: it.x, top: it.y, width: NODE_W, height: NODE_H, ["--hue" as string]: hue }}
      onClick={onPick}
      onDoubleClick={onOpen}
      tabIndex={on ? 0 : -1}
      aria-hidden={!on}
      title={`${shortWhen(it.ms)} · ${it.label}`}
    >
      <i className="nc-dot" style={{ background: dot }} aria-hidden />
      <time>{hhmm(it.ms)}</time>
      {KIND_ICON[it.kind] && <b className="nc-kind" aria-hidden>{KIND_ICON[it.kind]}</b>}
      <span>{it.label}</span>
    </button>
  );
});

