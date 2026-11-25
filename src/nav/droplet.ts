// 💧 The AI drop (25 Nov, Hapi: "it's about the AI bubble… from Home, the AI bubble separating,
// like water surface tension physics, not the Home button going out").
//
// Hold Home and draw it up: at first it's the joystick (Home under the thumb). Higher up, Home lets
// go and springs back to its place, but a drop of it stays on the thumb, joined to Home by a liquid
// neck. The higher the thumb, the longer and thinner the neck (its volume stays about the same),
// until, in the top third, it pinches off: the neck breaks near the drop, both ends snap back into
// their bodies, a tiny satellite drop is swallowed, and drop and Home both wobble round again
// (damped springs). Let go there and the drop is the new agent. Back down, or let go too low, and
// the drop runs back into Home.
//
// Drawn as one SVG over the page, only while it's moving (one frame loop, stopped the moment it's
// still). Bodies are ellipses that squash and stretch along the neck; the neck is a smooth path
// whose waist follows the pull.

export interface Pt {
  x: number;
  y: number;
}

/** A damped spring for a body's squash and stretch (a > 0: long along the neck). */
interface Wobble {
  a: number;
  v: number;
}
const W = 2 * Math.PI * 3.6;
const ZETA = 0.22;
function stepWobble(w: Wobble, dt: number) {
  const acc = -W * W * w.a - 2 * ZETA * W * w.v;
  w.v += acc * dt;
  w.a += w.v * dt;
}

/**
 * The neck's half-width at its waist: a thread of about the same volume gets thinner as it's
 * drawn longer (width ~ 1/√length), and thinner still as the pull `p` (0..1) nears the break.
 */
export function waistFor(p: number, homeR: number, length = 90): number {
  const q = Math.min(1, Math.max(0, p));
  const vol = Math.min(homeR * 0.5, Math.sqrt(((homeR * 0.45) ** 2 * 90) / Math.max(40, length)));
  return Math.max(0.7, vol * (1 - 0.88 * q ** 1.3));
}

/**
 * The outline of a liquid neck between two circles, as an SVG path: it leaves each body over a
 * wide foot and thins to `waist` at `at` (0..1 along the way). Local frame: x along the neck.
 */
export function neckPath(a: Pt, ra: number, b: Pt, rb: number, waist: number, at = 0.62): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1) return "";
  const ux = dx / L;
  const uy = dy / L;
  const P = (x: number, y: number) => `${(a.x + ux * x - uy * y).toFixed(1)},${(a.y + uy * x + ux * y).toFixed(1)}`;
  // Where the neck meets each body: a foot that narrows as the neck thins.
  const footA = Math.min(ra * 0.8, waist * 1.6 + ra * 0.3);
  const footB = Math.min(rb * 0.8, waist * 1.6 + rb * 0.25);
  const xa = Math.sqrt(Math.max(0, ra * ra - footA * footA));
  const xb = L - Math.sqrt(Math.max(0, rb * rb - footB * footB));
  if (xb <= xa) return "";
  const xw = xa + (xb - xa) * at;
  // Each side flares out only close to its body (surface tension), then runs as an even thread.
  const fa = Math.min((xw - xa) * 0.8, ra * 0.9 + footA);
  const fb = Math.min((xb - xw) * 0.8, rb * 0.9 + footB);
  const mid = (f: number) => f * 0.5 + waist * 0.5;
  return [
    `M${P(xa, footA)}`,
    `C${P(xa + fa * 0.3, mid(footA))} ${P(xa + fa, waist)} ${P(xw, waist)}`,
    `C${P(xb - fb, waist)} ${P(xb - fb * 0.3, mid(footB))} ${P(xb, footB)}`,
    `L${P(xb, -footB)}`,
    `C${P(xb - fb * 0.3, -mid(footB))} ${P(xb - fb, -waist)} ${P(xw, -waist)}`,
    `C${P(xa + fa, -waist)} ${P(xa + fa * 0.3, -mid(footA))} ${P(xa, -footA)}`,
    "Z",
  ].join(" ");
}

/** A tail left on a body when the neck breaks: a cone from the body toward `to`, `len` past its rim. */
export function tailPath(c: Pt, r: number, to: Pt, len: number, foot: number): string {
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  if (len < 0.6) return "";
  const f = Math.min(r * 0.8, foot);
  const x0 = Math.sqrt(Math.max(0, r * r - f * f));
  const tip = r + len;
  const P = (x: number, y: number) => `${(c.x + ux * x - uy * y).toFixed(1)},${(c.y + uy * x + ux * y).toFixed(1)}`;
  const tw = Math.max(0.5, f * 0.18);
  return `M${P(x0, f)} C${P(x0 + (tip - x0) * 0.35, f * 0.45)} ${P(tip - tw * 2, tw)} ${P(tip, 0)} C${P(tip - tw * 2, -tw)} ${P(x0 + (tip - x0) * 0.35, -f * 0.45)} ${P(x0, -f)} Z`;
}

const SVG = "http://www.w3.org/2000/svg";

export class DropletFx {
  private svg: SVGSVGElement;
  private neck: SVGPathElement;
  private tailA: SVGPathElement;
  private tailB: SVGPathElement;
  private home: SVGEllipseElement;
  private drop: SVGEllipseElement;
  private sat: SVGCircleElement;
  private star: SVGTextElement;
  private gloss: SVGEllipseElement;
  private frame = 0;
  private last = 0;
  /** Where Home rests, and its radius. */
  private H: Pt;
  private hr: number;
  /** The drop: where it is, how fast it moves, its size. */
  private D: Pt;
  private V: Pt = { x: 0, y: 0 };
  private dr: number;
  private target: Pt;
  private pull = 0;
  private attached = true;
  private wHome: Wobble = { a: 0, v: 0 };
  private wDrop: Wobble = { a: 0, v: 0 };
  /** After the break: the two tails (shrinking) and the satellite drop. */
  private tails: { a: number; b: number; foot: number; at: Pt } | null = null;
  private satellite: { p: Pt; r: number } | null = null;
  private going: "stay" | "home" | "agent" = "stay";
  private goneAt = 0;
  private onDone: (() => void) | null = null;
  /** The drop has broken free (the agent is ready to be let go). */
  free = false;

  /** host: where the drawing goes (beside the island, so the island and Home stay on top of it). */
  constructor(dock: Pt, homeR: number, thumb: Pt, private onBreak?: () => void, host: HTMLElement = document.body) {
    this.H = dock;
    this.hr = homeR;
    this.D = { ...dock };
    this.target = thumb;
    this.dr = homeR * 0.55;
    const el = <K extends keyof SVGElementTagNameMap>(k: K, cls: string) => {
      const n = document.createElementNS(SVG, k);
      n.setAttribute("class", cls);
      return n;
    };
    this.svg = el("svg", "nav-drop") as SVGSVGElement;
    this.svg.setAttribute("aria-hidden", "true");
    const defs = el("defs", "");
    // One gradient in page space from Home's colour to the agent's, so the neck blends between them.
    defs.innerHTML = '<linearGradient id="nav-drop-fill" gradientUnits="userSpaceOnUse"><stop offset="0" class="nav-drop-c0"/><stop offset="1" class="nav-drop-c1"/></linearGradient>';
    this.svg.append(defs);
    const g = el("g", "nav-drop-body");
    this.neck = el("path", "");
    this.tailA = el("path", "");
    this.tailB = el("path", "");
    this.home = el("ellipse", "");
    this.drop = el("ellipse", "");
    this.sat = el("circle", "");
    g.append(this.neck, this.tailA, this.tailB, this.home, this.drop, this.sat);
    this.gloss = el("ellipse", "nav-drop-gloss");
    this.star = el("text", "nav-drop-star");
    this.star.textContent = "✦";
    this.svg.append(g, this.gloss, this.star);
    host.append(this.svg);
    this.kick();
  }

  /** The thumb moved; `pull` 0..1 is how far between "drawn out" and "breaks". */
  thumb(p: Pt, pull: number) {
    this.target = p;
    this.pull = pull;
    if (this.attached && pull >= 1) this.snap();
    this.kick();
  }

  private snap() {
    this.attached = false;
    this.free = true;
    const L = Math.hypot(this.D.x - this.H.x, this.D.y - this.H.y);
    const foot = waistFor(0.85, this.hr, L) + 3;
    // It breaks near the drop (the thinnest part); the ends spring back into each body.
    this.tails = { a: Math.max(0, L * 0.62 - this.hr), b: Math.max(0, L * 0.38 - this.dr), foot, at: { x: this.H.x + (this.D.x - this.H.x) * 0.62, y: this.H.y + (this.D.y - this.H.y) * 0.62 } };
    this.satellite = { p: { ...this.tails.at }, r: 2.6 };
    // The drop recoils: long along the neck first, then round, then a little flat…
    this.wDrop.v += 3.2;
    this.wHome.v -= 2.4;
    this.onBreak?.();
    this.kick();
  }

  /** Let go. "agent": the drop stays (and fades into the new bubble); "home": it runs back into Home. */
  release(as: "agent" | "home"): Promise<void> {
    this.going = as === "agent" && this.free ? "agent" : "home";
    this.goneAt = performance.now();
    if (this.going === "home") this.target = { ...this.H };
    this.kick();
    return new Promise((r) => (this.onDone = r));
  }

  /** Gone at once (cancelled). */
  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.svg.remove();
    this.onDone?.();
    this.onDone = null;
  }

  private kick() {
    if (this.frame) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number) {
    this.frame = 0;
    const dt = Math.min(1 / 30, (now - this.last) / 1000);
    this.last = now;
    // The drop follows the thumb on a spring (a little behind, a little overshoot).
    const k = this.going === "home" ? 260 : this.attached ? 420 : 600;
    const c = 2 * Math.sqrt(k) * (this.going === "home" ? 0.75 : 0.62);
    // The neck pulls back against the thumb a little: the drop lags further the longer it is.
    const pullBack = this.attached ? 0.06 + 0.1 * this.pull : 0;
    const tx = this.target.x + (this.H.x - this.target.x) * pullBack;
    const ty = this.target.y + (this.H.y - this.target.y) * pullBack;
    this.V.x += (k * (tx - this.D.x) - c * this.V.x) * dt;
    this.V.y += (k * (ty - this.D.y) - c * this.V.y) * dt;
    this.D.x += this.V.x * dt;
    this.D.y += this.V.y * dt;
    // The drop fills out as it's drawn (to the bubble's size), and shrinks running home.
    const want = this.going === "home" ? this.hr * 0.4 : this.hr * 0.86;
    this.dr += (want - this.dr) * Math.min(1, dt * (this.going === "home" ? 6 : 9));
    // Speed stretches it along its way (a moving drop is a little long).
    const speed = Math.hypot(this.V.x, this.V.y);
    stepWobble(this.wDrop, dt);
    stepWobble(this.wHome, dt);
    if (this.tails) {
      this.tails.a *= Math.exp(-dt * 16);
      this.tails.b *= Math.exp(-dt * 20);
      if (this.tails.a + this.tails.b < 0.8) this.tails = null;
    }
    if (this.satellite) {
      const s = this.satellite;
      s.p.x += (this.D.x - s.p.x) * Math.min(1, dt * 9);
      s.p.y += (this.D.y - s.p.y) * Math.min(1, dt * 9);
      if (Math.hypot(this.D.x - s.p.x, this.D.y - s.p.y) < this.dr * 0.7) (this.satellite = null), (this.wDrop.v += 0.8);
    }
    const homeDist = Math.hypot(this.D.x - this.H.x, this.D.y - this.H.y);
    if (this.going === "home" && homeDist < this.hr * 0.6) {
      // Back in: one gulp of a wobble on Home, then gone.
      this.wHome.v += 2.2;
      this.going = "stay";
      this.D = { ...this.H };
      this.dr = 0;
      this.goneAt = now;
      this.settleThenEnd(now, 420);
    }
    this.draw(speed);
    const still = Math.abs(this.wDrop.a) + Math.abs(this.wDrop.v) * 0.05 + Math.abs(this.wHome.a) + Math.abs(this.wHome.v) * 0.05 < 0.004 && speed < 2 && !this.tails && !this.satellite;
    if (this.going === "agent") {
      // The real bubble appears where the drop is; the drop fades into it.
      const t = (now - this.goneAt) / 260;
      this.svg.style.opacity = String(Math.max(0, 1 - t));
      if (t >= 1) return this.destroy();
    }
    if (this.endAt && now >= this.endAt) return this.destroy();
    if (!still || this.going !== "stay" || this.endAt) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private endAt = 0;
  private settleThenEnd(now: number, ms: number) {
    this.endAt = now + ms;
  }

  private draw(speed: number) {
    const { H, D } = this;
    const ang = (Math.atan2(D.y - H.y, D.x - H.x) * 180) / Math.PI;
    const ell = (e: SVGEllipseElement, c: Pt, r: number, w: Wobble, extra = 0) => {
      const a = Math.max(-0.35, Math.min(0.45, w.a + extra));
      e.setAttribute("cx", c.x.toFixed(1));
      e.setAttribute("cy", c.y.toFixed(1));
      e.setAttribute("rx", Math.max(0, r * (1 + a)).toFixed(1));
      e.setAttribute("ry", Math.max(0, r * (1 - a * 0.6)).toFixed(1));
      e.setAttribute("transform", `rotate(${ang.toFixed(1)} ${c.x.toFixed(1)} ${c.y.toFixed(1)})`);
    };
    const showHome = this.attached || this.tails || Math.abs(this.wHome.a) > 0.004 || this.endAt;
    ell(this.home, H, showHome ? this.hr : 0, this.wHome);
    ell(this.drop, D, this.dr, this.wDrop, Math.min(0.18, speed / 4000));
    const L = Math.hypot(D.x - H.x, D.y - H.y);
    this.neck.setAttribute("d", this.attached ? neckPath(H, this.hr, D, this.dr, waistFor(this.going === "home" ? 0.2 : this.pull, this.hr, L)) : "");
    if (this.tails) {
      this.tailA.setAttribute("d", tailPath(H, this.hr, D, this.tails.a, this.tails.foot));
      this.tailB.setAttribute("d", tailPath(D, this.dr, H, this.tails.b, this.tails.foot));
    } else {
      this.tailA.setAttribute("d", "");
      this.tailB.setAttribute("d", "");
    }
    if (this.satellite) {
      this.sat.setAttribute("cx", this.satellite.p.x.toFixed(1));
      this.sat.setAttribute("cy", this.satellite.p.y.toFixed(1));
      this.sat.setAttribute("r", String(this.satellite.r));
    } else this.sat.setAttribute("r", "0");
    // Light on the drop, and the ✦ once it's its own drop.
    this.gloss.setAttribute("cx", (D.x - this.dr * 0.32).toFixed(1));
    this.gloss.setAttribute("cy", (D.y - this.dr * 0.38).toFixed(1));
    this.gloss.setAttribute("rx", (this.dr * 0.32).toFixed(1));
    this.gloss.setAttribute("ry", (this.dr * 0.2).toFixed(1));
    this.star.setAttribute("x", D.x.toFixed(1));
    this.star.setAttribute("y", (D.y + this.dr * 0.36).toFixed(1));
    this.star.style.opacity = this.free ? "1" : String(Math.max(0, this.pull - 0.3));
    this.star.style.fontSize = `${Math.round(this.dr * 1.05)}px`;
    const grad = this.svg.querySelector("linearGradient");
    grad?.setAttribute("x1", H.x.toFixed(0));
    grad?.setAttribute("y1", H.y.toFixed(0));
    grad?.setAttribute("x2", D.x.toFixed(0));
    grad?.setAttribute("y2", D.y.toFixed(0));
  }
}
