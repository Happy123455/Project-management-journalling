/**
 * The agent swarm's script (Hapi, 18 Nov): when the assistant makes or changes a block, a few
 * labelled cursor "agents" fly in together, click and type over the block's parts, and the block
 * builds itself up; then it settles into the real block. Purely a show: the real agent has already
 * done the work. This file only decides who comes and what each does (no DOM), from the task:
 * the tool that ran, the words, and the parts the finished block is made of.
 */

export type SwarmKind = "math" | "chart" | "table" | "text" | "list" | "code" | "media" | "time" | "link" | "generic";

/** What a part of the finished block is, as found on screen. */
export type PieceHint = "head" | "line" | "cell" | "check" | "formula" | "result" | "plot" | "media" | "box";

export type SwarmAct = "click" | "type" | "draw" | "drag";

export interface SwarmTask {
  /** The tool that ran (math_add, add_table, put_under…), if any. */
  tool?: string;
  /** Words it wrote. */
  text?: string;
  /** Force a kind (otherwise from the tool, then from the block's class). */
  kind?: SwarmKind;
  /** The block's class names / tag (math-block, sheet-wrap, UL…). */
  shape?: string;
}

export interface SwarmAgent {
  id: number;
  role: string;
  icon: string;
  hue: number;
  /** Where it flies in from, as a fraction of the screen (an edge). */
  from: { x: number; y: number };
}

export interface SwarmStep {
  agent: number;
  piece: number;
  /** ms from the start. */
  at: number;
  dur: number;
  act: SwarmAct;
}

export interface SwarmPlan {
  kind: SwarmKind;
  agents: SwarmAgent[];
  steps: SwarmStep[];
  /** Arrivals done by then. */
  enterMs: number;
  /** Building ends, the morph into the real block starts. */
  buildMs: number;
  morphMs: number;
  totalMs: number;
}

interface Role {
  role: string;
  icon: string;
  hue: number;
  likes: PieceHint[];
  act: SwarmAct;
}

const R = (role: string, icon: string, hue: number, likes: PieceHint[], act: SwarmAct): Role => ({ role, icon, hue, likes, act });

/** Who can work on each kind, most needed first. */
const ROSTER: Record<SwarmKind, Role[]> = {
  math: [R("Parser", "⌁", 222, ["formula"], "type"), R("Solver", "∑", 152, ["line", "result"], "type"), R("Plotter", "📈", 32, ["plot"], "draw"), R("Checker", "✓", 280, ["result", "box"], "click")],
  chart: [R("Data", "▦", 200, ["box", "cell"], "click"), R("Axes", "┼", 260, ["line", "head"], "draw"), R("Painter", "🎨", 28, ["plot", "media"], "draw"), R("Labels", "Aa", 140, ["head", "line"], "type")],
  table: [R("Grid", "▦", 210, ["box"], "drag"), R("Header", "H", 270, ["head"], "type"), R("Filler", "✎", 150, ["cell"], "type"), R("Filler 2", "✎", 40, ["cell"], "type")],
  text: [R("Writer", "✎", 220, ["line", "head"], "type"), R("Editor", "¶", 150, ["line"], "type"), R("Styler", "Aa", 300, ["head", "box"], "click")],
  list: [R("Planner", "☰", 210, ["line", "head"], "type"), R("Writer", "✎", 150, ["line"], "type"), R("Ticker", "☑", 40, ["check"], "click")],
  code: [R("Coder", "</>", 200, ["line"], "type"), R("Linter", "✓", 140, ["line", "box"], "click"), R("Formatter", "{}", 290, ["box"], "drag")],
  media: [R("Fetcher", "⤓", 200, ["media", "box"], "drag"), R("Framer", "▣", 30, ["media", "box"], "click"), R("Captioner", "Aa", 150, ["line", "head"], "type")],
  time: [R("Scheduler", "⏰", 30, ["line", "head"], "type"), R("Timer", "⏳", 200, ["box", "plot"], "draw"), R("Checker", "✓", 150, ["check", "box"], "click")],
  link: [R("Fetcher", "🔗", 210, ["media", "box"], "drag"), R("Reader", "Aa", 150, ["line", "head"], "type")],
  generic: [R("Builder", "▣", 215, ["box", "line"], "drag"), R("Writer", "✎", 150, ["line", "head"], "type"), R("Styler", "◐", 300, ["box"], "click")],
};

export function kindOf(task: SwarmTask, hints: PieceHint[] = []): SwarmKind {
  if (task.kind) return task.kind;
  const t = task.tool ?? "";
  if (/^math_/.test(t)) return "math";
  if (/^(add_table|set_cells|add_sheet|add_rule)$/.test(t)) return "table";
  if (/^(add_deadline|add_reminder|log_routine|start_timer)$/.test(t)) return "time";
  if (/^(plan_blocks|copy_task|tick_task)$/.test(t)) return "list";
  if (t === "add_media") return "media";
  const s = (task.shape ?? "").toLowerCase();
  if (/math-block|katex/.test(s)) return "math";
  if (/chart|plot|graph/.test(s)) return "chart";
  if (/sheet|table/.test(s)) return "table";
  if (/code-block|\bpre\b/.test(s)) return "code";
  if (/attach-file|\bimg\b|video/.test(s)) return "media";
  if (/link-card/.test(s)) return "link";
  if (/(^|\s)dl(\s|$)|deadline|reminder/.test(s)) return "time";
  if (/\b(ul|ol)\b|task/.test(s)) return "list";
  const plots = hints.filter((h) => h === "plot").length;
  if (plots && plots >= hints.length / 2) return "chart";
  if (/^\s*(- \[|⏰|\d+[.)] |[-*•] )/m.test(task.text ?? "")) return "list";
  if (hints.length) return "text";
  return "generic";
}

/** A small seeded random, so a run can be replayed in tests; real runs seed from the clock. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const EDGES = [
  { x: -0.08, y: 0.3 },
  { x: 1.08, y: 0.25 },
  { x: 0.5, y: 1.08 },
  { x: -0.08, y: 0.85 },
  { x: 1.08, y: 0.8 },
  { x: 0.3, y: -0.08 },
];

/**
 * The script for one run: which agents come (by the kind of block and how many parts it has),
 * which parts each builds and when, with a little randomness so no two runs look the same.
 * Lasts about 2–3 s in all.
 */
export function planSwarm(task: SwarmTask, hints: PieceHint[], rand: () => number = Math.random): SwarmPlan {
  const kind = kindOf(task, hints);
  const n = Math.max(1, hints.length);
  const roster = ROSTER[kind];
  // Who is needed: everyone whose kind of part is there, the first two always, more for bigger blocks.
  const want = Math.min(4, roster.length, 2 + (n > 4 ? 1 : 0) + (n > 9 || (task.text ?? "").length > 160 ? 1 : 0) + (rand() < 0.25 ? 1 : 0));
  const picked = roster.filter((r, i) => i < 2 || r.likes.some((h) => hints.includes(h)));
  const roles = (picked.length >= want ? picked : [...picked, ...roster.filter((r) => !picked.includes(r))]).slice(0, Math.max(2, want));
  const edges = [...EDGES].sort(() => rand() - 0.5);
  const agents: SwarmAgent[] = roles.map((r, i) => ({ id: i, role: r.role, icon: r.icon, hue: (r.hue + Math.round((rand() - 0.5) * 24) + 360) % 360, from: edges[i % edges.length] }));

  // Each part goes to the agent that likes it (least busy first), else to whoever has least to do.
  const load = agents.map(() => 0);
  const owner = hints.map((h) => {
    const fits = agents.filter((a) => roles[a.id].likes.includes(h));
    const pool = fits.length ? fits : agents;
    const best = pool.reduce((b, a) => (load[a.id] < load[b.id] ? a : b), pool[0]);
    load[best.id]++;
    return best.id;
  });
  // Nobody stands around: an idle agent takes a part from the busiest one.
  for (const a of agents) {
    if (load[a.id] || hints.length <= agents.length - 1) continue;
    const busiest = load.indexOf(Math.max(...load));
    const take = owner.lastIndexOf(busiest);
    if (take >= 0 && load[busiest] > 1) {
      owner[take] = a.id;
      load[busiest]--;
      load[a.id]++;
    }
  }

  const enterMs = 320 + Math.round(rand() * 120);
  const buildMs = Math.min(2500, Math.round(1750 + rand() * 450 + Math.min(n, 12) * 22));
  const morphMs = 480 + Math.round(rand() * 120);
  const work = buildMs - 220 - enterMs;
  const steps: SwarmStep[] = [];
  for (const a of agents) {
    const mine = owner.map((o, i) => (o === a.id ? i : -1)).filter((i) => i >= 0);
    if (!mine.length) continue;
    const slot = work / mine.length;
    mine.forEach((piece, k) => {
      const jitter = (rand() - 0.5) * slot * 0.3;
      const at = Math.round(enterMs + k * slot + Math.max(0, jitter) + rand() * 60);
      const base = roles[a.id].act;
      const act: SwarmAct = hints[piece] === "check" ? "click" : hints[piece] === "plot" ? "draw" : hints[piece] === "media" ? "drag" : base;
      const dur = Math.round(Math.min(slot * 0.85, act === "click" ? 260 : act === "type" ? 420 : 380) * (0.85 + rand() * 0.3));
      const d = Math.max(140, dur);
      steps.push({ agent: a.id, piece, at: Math.max(enterMs, Math.min(at, buildMs - 140 - d)), dur: d, act });
    });
  }
  steps.sort((x, y) => x.at - y.at);
  return { kind, agents, steps, enterMs, buildMs, morphMs, totalMs: buildMs + morphMs };
}
