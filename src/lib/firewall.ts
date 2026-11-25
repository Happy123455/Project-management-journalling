// 🧯 The rhetoric firewall: strips the delivery (confidence, urgency, jargon, flags, prestige) off
// what someone says and shows the bare argument underneath: each claim as a plain premise, what it
// rests on, the named trick if there is one, where it contradicts itself or the speaker's earlier
// words, who gains if you believe it, and one plain sentence of what is really going on. It also
// says what holds up and the strongest fair version of their case, so it trains judgement instead of
// swapping one persuasion for another (cynicism is just another way to be steered).
//
// Pure part: records, the fallacy guide, prompts, schemas, normalising, speaker memory, the lines
// written in the journal. src/firewall/firewall.ts runs it.

// ───── Fallacies (shown when a badge is tapped; no AI needed) ─────

export const FALLACIES: Record<string, string> = {
  "Straw man": "Answers a weaker, exaggerated version of the other side instead of what was actually said.",
  "False equivalence": "Treats two things as the same because they share one surface feature.",
  "False dilemma": "Offers two options as the only ones when there are more.",
  "Ad hominem": "Attacks the person (their intelligence, motives, background) instead of their point.",
  "Appeal to authority": "It's true because an important or confident person says so.",
  "Appeal to emotion": "Uses fear, pride, anger or pity to carry a point the evidence doesn't.",
  "Appeal to patriotism": "Wraps the claim in the flag: disagreeing is made to look disloyal.",
  "Whataboutism": "Deflects a criticism by pointing at someone else's fault.",
  "Gish gallop": "Fires many quick claims or questions so none can be checked or answered.",
  "Red herring": "Changes the subject to something that sounds related but isn't the question.",
  "Moving the goalposts": "Changes what would count as proof once the first bar is met.",
  "Circular reasoning": "The conclusion is hidden in the premise: it's true because it's true.",
  "Conflicting conditions": "Holds two claims that can't both be true at once.",
  "Slippery slope": "Claims one step leads to an extreme without showing the chain.",
  "Hasty generalisation": "Draws a big rule from a few cases.",
  "Cherry picking": "Shows only the facts that help and leaves out the ones that don't.",
  "Bandwagon": "It's right because everyone (or the winners) is doing it.",
  "Loaded language": "Words chosen to make you feel the conclusion before it's argued.",
  "Vague claim": "Says nothing checkable: no numbers, no who, no when.",
  "Condescension": "Treats doubt as stupidity so questioning feels embarrassing.",
  "Unfalsifiable claim": "No outcome could ever show it wrong.",
  "Begging the question": "Assumes the very thing being argued about.",
};
export const FALLACY_NAMES = Object.keys(FALLACIES);

/** The guide's name for whatever the model wrote ("strawman", "ad-hominem attack"…), or the text as it came. */
export function fallacyName(raw: string): string {
  const k = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return "";
  for (const name of FALLACY_NAMES) {
    const n = name.toLowerCase().replace(/[^a-z]/g, "");
    if (k === n || k.startsWith(n) || (n.length > 6 && k.includes(n))) return name;
  }
  const alias: [RegExp, string][] = [
    [/doublethink|contradict/, "Conflicting conditions"],
    [/fear|pity|emotional/, "Appeal to emotion"],
    [/nationalis|flag/, "Appeal to patriotism"],
    [/tuquoque|whatabout/, "Whataboutism"],
    [/falsedichotomy|blackandwhite|eitheror/, "False dilemma"],
    [/falseanalogy|weakanalogy/, "False equivalence"],
    [/personalattack|insult/, "Ad hominem"],
    [/goalpost/, "Moving the goalposts"],
    [/buzzword|jargon|weasel/, "Vague claim"],
    [/circular/, "Circular reasoning"],
  ];
  return alias.find(([re]) => re.test(k))?.[1] ?? raw.trim().slice(0, 40);
}

// ───── Records ─────

export type Basis = "evidence" | "reasoning" | "assertion" | "emotion";

export interface Claim {
  /** 1, 2, 3… in the order said. */
  n: number;
  /** When in the video or recording (m:ss), if known. */
  t: string;
  /** Their words, short. */
  quote: string;
  /** What they want you to believe. */
  claim: string;
  /** The bare logic: "If A, then B", no adjectives or buzzwords. */
  premise: string;
  basis: Basis;
  fallacies: string[];
  /** Earlier claims (their n) this one can't both be true with. */
  contradicts: number[];
  /** Who gains if you believe it (money, power, image, legal cover), or "". */
  incentive: string;
  /** One plain sentence: what is actually happening here. */
  plain: string;
  /** How much of its pull is emotional (0 – pure logic, 100 – pure pressure). */
  heat: number;
}

export interface SourceInfo {
  kind: "youtube" | "link" | "text" | "live";
  url?: string;
  title?: string;
}

export interface CheckRec {
  kind: "check";
  id: string;
  at: string;
  by: string;
  model: string;
  source: SourceInfo;
  speaker: string;
  topic: string;
  claims: Claim[];
  contradictions: { a: number; b: number; why: string }[];
  /** Clashes with what this speaker said in earlier checks. */
  past: { n: number; prior: string; day: string; why: string }[];
  /** Emotion vs logic for the whole thing, 0–100. */
  heat: number;
  /** One brutal, exact sentence. */
  verdict: string;
  /** The strongest honest version of their case. */
  steelman: string;
  /** Points that do hold up. */
  holds: string[];
  /** Questions that would settle it. */
  ask: string[];
  /** How convinced Hapi was before and after (0–10), when given. */
  before?: number;
  after?: number;
  /** Live listening: the words heard (kept short). */
  transcript?: string;
}

export const FIREWALL_PAGE = "Rhetoric firewall";
/** Checks kept on the page (the oldest go first). */
export const KEEP_CHECKS = 60;

// ───── Speaker memory ─────

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/** A speaker from earlier checks named in these hints (a title, a channel, the words), longest name first. */
export function knownSpeaker(records: CheckRec[], hints: string): string {
  const h = ` ${norm(hints)} `;
  const names = [...new Set(records.map((r) => r.speaker).filter((s) => s && norm(s).length >= 3))].sort((a, b) => b.length - a.length);
  const last = (n: string) => norm(n).split(" ").pop() ?? "";
  return names.find((n) => h.includes(` ${norm(n)} `) || (last(n).length >= 5 && h.includes(` ${last(n)} `))) ?? "";
}

/** What this speaker claimed before (bare premises, newest first), for the contradiction check across checks. */
export function priorPremises(records: CheckRec[], speaker: string, max = 40): { day: string; premise: string }[] {
  if (!speaker) return [];
  const s = norm(speaker);
  return records
    .filter((r) => norm(r.speaker) === s)
    .sort((a, b) => b.at.localeCompare(a.at))
    .flatMap((r) => r.claims.map((c) => ({ day: r.at.slice(0, 10), premise: c.premise || c.claim })))
    .filter((x) => x.premise)
    .slice(0, max);
}

// ───── Prompts ─────

export const FIREWALL_SYSTEM = `You are the rhetoric firewall in Hapi's journal: a ruthless but fair epistemic auditor. Hapi noticed that confident, emotional speakers can steer people before the logic is ever checked. Your job is to strip the delivery and show the bare argument.

Ignore the speaker's prestige, confidence, tone, urgency, jargon, flags and applause. For every real argument (skip greetings and filler; merge repeats), in the order said:
- t: when it's said (m:ss) if you can tell, else "".
- quote: their words, short.
- claim: what they want the audience to believe.
- premise: the bare logical form, "If A, then B" or "A, therefore B", with no adjectives, metaphors or buzzwords.
- basis: evidence (checkable facts or data given), reasoning (follows from stated premises), assertion (just stated), or emotion (carried by feeling).
- fallacies: exact names from this list when they clearly apply, else []: ${FALLACY_NAMES.join(", ")}.
- contradicts: numbers of EARLIER claims that cannot be true at the same time as this one.
- incentive: how believing it benefits the speaker (money, power, image, legal cover), or "" if none is visible. Say only what is plausible from who they are and what is at stake; never invent facts about them.
- plain: one blunt sentence in plain English of what is actually going on.
- heat: 0–100, how much of its pull is emotional rather than logical.

Be brutal by being exact, not cynical. A sound point is sound even from someone with an interest: say so. Don't take a side on the topic itself; judge the structure, not the conclusion. Name a fallacy only when it really is one. Then: heat for the whole (0–100), verdict (one exact sentence), steelman (the strongest honest version of their case), holds (points that stand up), ask (2–3 questions that would settle it if answered), and contradictions as pairs of claim numbers with why. If earlier claims by the same speaker are given, list in past any that a new claim contradicts. Write in the language of the source.

Short and concise (25 Nov, Hapi): think it through fully, but write little. Keep only the arguments that carry the case (at most 8; merge small ones into them). quote at most 12 words; claim, premise, incentive and plain one short sentence each; verdict one sentence; steelman at most two sentences; holds and ask at most 3 items each.`;

export const LIVE_SYSTEM = `${FIREWALL_SYSTEM}

This is a piece of a live conversation, transcribed as it's heard (words may be slightly wrong). Analyse only the claims in the NEW piece; earlier claims are given with their numbers for the contradiction check. Number the new claims from the number given. t = "".`;

const str = { type: "string" };
const arr = (items: unknown) => ({ type: "array", items });
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties) });
const CLAIM = obj({
  n: { type: "integer" },
  t: str,
  quote: str,
  claim: str,
  premise: str,
  basis: { type: "string", enum: ["evidence", "reasoning", "assertion", "emotion"] },
  fallacies: arr(str),
  contradicts: arr({ type: "integer" }),
  incentive: str,
  plain: str,
  heat: { type: "integer" },
});
const PAIR = obj({ a: { type: "integer" }, b: { type: "integer" }, why: str });
const PAST = obj({ n: { type: "integer" }, prior: str, day: str, why: str });

export const CHECK_SCHEMA = obj({
  speaker: str,
  topic: str,
  claims: arr(CLAIM),
  contradictions: arr(PAIR),
  past: arr(PAST),
  heat: { type: "integer" },
  verdict: str,
  steelman: str,
  holds: arr(str),
  ask: arr(str),
});
export const CHECK_SHAPE = `Answer with only one JSON object, no other text:
{"speaker": "...", "topic": "...", "claims": [{"n": 1, "t": "m:ss", "quote": "...", "claim": "...", "premise": "If A, then B", "basis": "evidence|reasoning|assertion|emotion", "fallacies": ["..."], "contradicts": [0], "incentive": "...", "plain": "...", "heat": 0-100}], "contradictions": [{"a": 1, "b": 2, "why": "..."}], "past": [{"n": 1, "prior": "...", "day": "YYYY-MM-DD", "why": "..."}], "heat": 0-100, "verdict": "...", "steelman": "...", "holds": ["..."], "ask": ["..."]}`;

export const CHUNK_SCHEMA = obj({ speaker: str, claims: arr(CLAIM) });
export const CHUNK_SHAPE = `Answer with only one JSON object: {"speaker": "...", "claims": [{"n": 1, "t": "", "quote": "...", "claim": "...", "premise": "...", "basis": "evidence|reasoning|assertion|emotion", "fallacies": ["..."], "contradicts": [0], "incentive": "...", "plain": "...", "heat": 0-100}]}`;

export const SUM_SYSTEM = `You finish a rhetoric-firewall check of a live conversation. You get the claims already pulled out (numbered, with their bare premises and tricks). Give the topic, heat for the whole (0–100, emotion vs logic), a one-sentence exact verdict, the steelman (strongest honest version of their case), holds (points that stand up), ask (2–3 questions that would settle it), and contradictions as pairs of claim numbers with why. Fair, exact, not cynical.`;
export const SUM_SCHEMA = obj({ topic: str, heat: { type: "integer" }, verdict: str, steelman: str, holds: arr(str), ask: arr(str), contradictions: arr(PAIR) });
export const SUM_SHAPE = `Answer with only one JSON object: {"topic": "...", "heat": 0-100, "verdict": "...", "steelman": "...", "holds": ["..."], "ask": ["..."], "contradictions": [{"a": 1, "b": 2, "why": "..."}]}`;

/** The request text: the source (or a note that the video is attached), the speaker hint, and their earlier claims. */
export function checkRequest(o: { source: SourceInfo; text?: string; speaker?: string; prior: { day: string; premise: string }[] }): string {
  return [
    o.source.kind === "youtube" ? `Watch the attached video${o.source.title ? ` ("${o.source.title}")` : ""} and audit what is said in it.` : `Audit this${o.source.title ? ` ("${o.source.title}")` : ""}${o.source.url ? ` from ${o.source.url}` : ""}:`,
    o.text ? `\n"""\n${o.text}\n"""` : "",
    o.speaker ? `\nThe speaker is probably ${o.speaker}.` : "",
    o.prior.length ? `\nWhat ${o.speaker} claimed in earlier checks (bare premises):\n${o.prior.map((p) => `- (${p.day}) ${p.premise}`).join("\n")}` : "",
  ].join("\n");
}

export function chunkRequest(o: { piece: string; from: number; earlier: Claim[]; speaker: string }): string {
  return [
    o.speaker ? `Speaker: ${o.speaker}` : "",
    o.earlier.length ? `Earlier claims:\n${o.earlier.map((c) => `${c.n}. ${c.premise || c.claim}`).join("\n")}` : "No earlier claims.",
    `\nNumber new claims from ${o.from}.`,
    `\nNEW piece:\n"""\n${o.piece}\n"""`,
  ].join("\n");
}

// ───── Normalising ─────

const text = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clamp = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : 0);
const list = (v: unknown, max: number, len = 400) => (Array.isArray(v) ? v.map((x) => text(x, len)).filter(Boolean).slice(0, max) : []);
const BASES: Basis[] = ["evidence", "reasoning", "assertion", "emotion"];

/** Claims made tidy: numbered from `from` in order, contradictions only pointing back at claims that exist. */
export function normalizeClaims(raw: unknown, from = 1, earlier: number[] = []): Claim[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: Claim[] = [];
  const renum = new Map<number, number>();
  for (const r of rows) {
    const c = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const claim = text(c.claim, 500);
    const premise = text(c.premise, 500);
    if (!claim && !premise) continue;
    const n = from + out.length;
    if (Number.isFinite(Number(c.n))) renum.set(Number(c.n), n);
    out.push({
      n,
      t: /^\d{1,2}:\d{2}(:\d{2})?$/.test(text(c.t, 8)) ? text(c.t, 8) : "",
      quote: text(c.quote, 400),
      claim,
      premise,
      basis: BASES.includes(c.basis as Basis) ? (c.basis as Basis) : "assertion",
      fallacies: [...new Set(list(c.fallacies, 4, 60).map(fallacyName).filter(Boolean))],
      contradicts: (Array.isArray(c.contradicts) ? c.contradicts : []).map(Number).filter(Number.isFinite) as number[],
      incentive: text(c.incentive, 300),
      plain: text(c.plain, 300),
      heat: clamp(c.heat),
    });
  }
  const valid = new Set([...earlier, ...out.map((c) => c.n)]);
  for (const c of out) c.contradicts = [...new Set(c.contradicts.map((x) => renum.get(x) ?? x))].filter((x) => x !== c.n && valid.has(x) && x < c.n);
  return out;
}

export function normalizePairs(raw: unknown, claims: Claim[]): { a: number; b: number; why: string }[] {
  const ns = new Set(claims.map((c) => c.n));
  const pairs = (Array.isArray(raw) ? raw : [])
    .map((p) => p as Record<string, unknown>)
    .map((p) => ({ a: Number(p?.a), b: Number(p?.b), why: text(p?.why, 400) }))
    .filter((p) => ns.has(p.a) && ns.has(p.b) && p.a !== p.b);
  // A claim that says it contradicts an earlier one is a pair too.
  for (const c of claims) for (const x of c.contradicts) if (!pairs.some((p) => (p.a === x && p.b === c.n) || (p.a === c.n && p.b === x))) pairs.push({ a: x, b: c.n, why: "" });
  return pairs.slice(0, 12);
}

/** Whole-thing heat when the model gives none: the claims' average. */
const avgHeat = (claims: Claim[]) => (claims.length ? Math.round(claims.reduce((s, c) => s + c.heat, 0) / claims.length) : 0);

export function normalizeCheck(raw: unknown): Omit<CheckRec, "kind" | "id" | "at" | "by" | "model" | "source"> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const claims = normalizeClaims(r.claims);
  const ns = new Set(claims.map((c) => c.n));
  return {
    speaker: text(r.speaker, 80),
    topic: text(r.topic, 160),
    claims,
    contradictions: normalizePairs(r.contradictions, claims),
    past: (Array.isArray(r.past) ? r.past : [])
      .map((p) => p as Record<string, unknown>)
      .map((p) => ({ n: Number(p?.n), prior: text(p?.prior, 400), day: text(p?.day, 10), why: text(p?.why, 400) }))
      .filter((p) => ns.has(p.n) && p.prior)
      .slice(0, 8),
    heat: r.heat === undefined ? avgHeat(claims) : clamp(r.heat),
    verdict: text(r.verdict, 400),
    steelman: text(r.steelman, 800),
    holds: list(r.holds, 6),
    ask: list(r.ask, 4),
  };
}

export function normalizeSummary(raw: unknown, claims: Claim[]) {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    topic: text(r.topic, 160),
    heat: r.heat === undefined ? avgHeat(claims) : clamp(r.heat),
    verdict: text(r.verdict, 400),
    steelman: text(r.steelman, 800),
    holds: list(r.holds, 6),
    ask: list(r.ask, 4),
    contradictions: normalizePairs(r.contradictions, claims),
  };
}

// ───── Showing and writing ─────

export interface Tally {
  claims: number;
  tricks: number;
  contradictions: number;
  bare: number;
  top: [string, number][];
}

/** Counts for the header: claims, tricks found, contradictions, claims with nothing behind them. */
export function tally(r: Pick<CheckRec, "claims" | "contradictions" | "past">): Tally {
  const counts = new Map<string, number>();
  for (const c of r.claims) for (const f of c.fallacies) counts.set(f, (counts.get(f) ?? 0) + 1);
  return {
    claims: r.claims.length,
    tricks: [...counts.values()].reduce((a, b) => a + b, 0),
    contradictions: r.contradictions.length + r.past.length,
    bare: r.claims.filter((c) => c.basis === "assertion" || c.basis === "emotion").length,
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

/** Hapi's conviction shift over the checks that have both numbers (negative: less convinced after). */
export function convictionShift(records: CheckRec[]): { n: number; avg: number } {
  const both = records.filter((r) => typeof r.before === "number" && typeof r.after === "number");
  return { n: both.length, avg: both.length ? Math.round((both.reduce((s, r) => s + (r.after! - r.before!), 0) / both.length) * 10) / 10 : 0 };
}

/** The YouTube address Gemini watches (shorts and youtu.be links as a normal watch link). */
export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** A web page's readable text: the article (or main, or body) without scripts, menus and footers. */
export function pageText(html: string, max = 60_000): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,nav,footer,header,aside,form,svg,iframe").forEach((n) => n.remove());
  const root = doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body;
  // Block ends become line ends (textContent alone runs paragraphs together).
  root?.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,div,br,tr,blockquote,section,pre").forEach((el) => el.after("\n"));
  const lines = (root?.textContent ?? "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1);
  return { title: (doc.querySelector("meta[property='og:title']")?.getAttribute("content") || doc.title || "").trim(), text: lines.join("\n").slice(0, max) };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The lines "＋ Today" adds: a heading, the verdict, each claim stripped, and what holds up. */
export function todayLines(r: CheckRec): string[] {
  const t = tally(r);
  const who = r.speaker ? `[[${r.speaker}]]` : "someone";
  const src = r.source.title || r.source.url || (r.source.kind === "live" ? "live listening" : "pasted text");
  return [
    `🧯 Firewall · ${who} · ${clip(src, 120)}${r.source.url && r.source.title ? ` (${r.source.url})` : ""}`,
    `🧯 ${t.claims} claims, ${t.tricks} tricks, ${t.contradictions} contradictions · ${100 - r.heat}% logic / ${r.heat}% emotion${typeof r.before === "number" && typeof r.after === "number" ? ` · me: ${r.before} → ${r.after}/10` : ""}`,
    `🧯 Verdict: ${r.verdict}`,
    ...r.claims.map((c) => `🧯 ${c.n}. ${c.premise || c.claim}${c.fallacies.length ? ` [${c.fallacies.join(", ")}]` : ""} → ${c.plain}`),
    ...(r.holds.length ? [`🧯 Holds up: ${r.holds.join("; ")}`] : []),
  ];
}
