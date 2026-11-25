import { ARROW, node, swarmOff } from "./run";
import { haptic } from "../../lib/haptic";
import { addDays, dayKey } from "../../lib/timestamp";

/**
 * The agent opens a day the way a person would (Hapi, 18 Nov), with its arrow doing the taps:
 *  - today: it taps Home;
 *  - a day in the week strip: it taps that day on the week;
 *  - a day within about two months: it opens the month, steps ‹ › to the right month, taps the day;
 *  - further back: it opens the Year, steps to the year, and taps the day there.
 * Everything it taps is the real button (so the app does exactly what a tap does); the arrow, its
 * label and the ripples are throwaway nodes animated with Web Animations. Resolves true once the
 * day is open, false when it couldn't be shown this way (the caller then just opens it).
 */

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const shows = (el: Element | null): boolean => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
};
const visible = (el: Element | null): el is HTMLElement => shows(el);
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

/** Waits (a few frames at a time, not a loop) until `find` gives something, or gives up. */
async function until<T>(find: () => T | null | undefined | false, ms = 1600): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = find();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(70);
  }
}

const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

let busy = false;

export type NavRoute = "home" | "week" | "month" | "year";

/** Which way the agent goes to a day, from where the calendar is now. */
export function navRoute(day: string, today: string, shownMonth: string | null, inWeekStrip: boolean): NavRoute {
  if (day === today) return "home";
  if (inWeekStrip) return "week";
  if (shownMonth && Math.abs(monthsBetween(shownMonth, day.slice(0, 7))) <= 2) return "month";
  return "year";
}

export async function showNavTo(day: string): Promise<boolean> {
  if (busy || swarmOff() || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  busy = true;
  const today = dayKey(new Date());
  const root = node("swarm swarm-nav", document.body);
  root.setAttribute("aria-hidden", "true");
  const stage = node("swarm-stage", root);
  const me = node("swarm-agent nav-agent", stage, `${ARROW}<span class="swarm-tag"><b>🧭</b><span class="nav-say">Navigator</span></span>`);
  me.style.setProperty("--h", "200");
  const say = me.querySelector<HTMLElement>(".nav-say")!;
  let at = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.42 };
  me.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
  // 25 Nov (Hapi): the agent's three arrows flow together like liquid into the one that navigates.
  const from = [...document.querySelectorAll<HTMLElement>(".agent-cursors .ac-run, .agent-bubble.live, .agent-bubble")].slice(0, 3).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  while (from.length < 3) from.push({ x: at.x + [-120, 120, 0][from.length], y: at.y + [90, 90, 150][from.length] });
  me.style.opacity = "0";
  await Promise.all(
    from.map((p, i) => {
      const ghost = node("swarm-agent nav-agent nav-ghost", stage, ARROW);
      ghost.style.setProperty("--h", String(200 + (i - 1) * 40));
      const ang = (Math.atan2(at.y - p.y, at.x - p.x) * 180) / Math.PI;
      return ghost
        .animate(
          [
            { transform: `translate3d(${p.x}px, ${p.y}px, 0) scale(1)`, opacity: 0.9, filter: "blur(0px)" },
            { transform: `translate3d(${(p.x + at.x) / 2}px, ${(p.y + at.y) / 2}px, 0) rotate(${ang - 90}deg) scale(0.8, 1.7)`, opacity: 0.85, filter: "blur(1.5px)", offset: 0.55 },
            { transform: `translate3d(${at.x}px, ${at.y}px, 0) scale(0.4)`, opacity: 0, filter: "blur(3px)" },
          ],
          { duration: 520 + i * 60, easing: "cubic-bezier(0.55, 0, 0.25, 1)", fill: "forwards" },
        )
        .finished.catch(() => undefined)
        .then(() => ghost.remove());
    }),
  );
  me.style.opacity = "";
  const blob = node("swarm-ripple", stage);
  blob.style.setProperty("--h", "200");
  Object.assign(blob.style, { left: `${at.x}px`, top: `${at.y}px` });
  blob.animate([{ transform: "scale(0.3)", opacity: 0.8 }, { transform: "scale(1.8)", opacity: 0 }], { duration: 420, easing: "ease-out", fill: "forwards" }).finished.then(() => blob.remove(), () => blob.remove());
  // Squash and stretch as the drops become one arrow.
  me.animate(
    [
      { opacity: 0.6, transform: `translate3d(${at.x}px, ${at.y}px, 0) scale(1.45, 0.65)` },
      { opacity: 1, transform: `translate3d(${at.x}px, ${at.y}px, 0) scale(0.85, 1.15)`, offset: 0.45 },
      { opacity: 1, transform: `translate3d(${at.x}px, ${at.y}px, 0) scale(1)` },
    ],
    { duration: 380, easing: "cubic-bezier(0.2, 1.4, 0.4, 1)" },
  );
  document.documentElement.classList.add("nav-showing");
  const tell = (s: string) => {
    say.textContent = s;
    say.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200 });
  };
  const moveTo = async (x: number, y: number, ms = 520) => {
    const from = at;
    at = { x, y };
    await me.animate([{ transform: `translate3d(${from.x}px, ${from.y}px, 0)` }, { transform: `translate3d(${x}px, ${y}px, 0)` }], { duration: ms, easing: "cubic-bezier(0.45, 0, 0.2, 1)", fill: "forwards" }).finished.catch(() => undefined);
  };
  /** Glides to the element, presses it (ripple, a small dip) and taps it for real. */
  const tap = async (el: HTMLElement, label?: string, ms = 520) => {
    if (label) tell(label);
    let r = el.getBoundingClientRect();
    if (!shows(el)) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      await wait(380);
      r = el.getBoundingClientRect();
    }
    await moveTo(r.left + r.width / 2 - 2, r.top + r.height / 2 - 2, ms);
    const rp = node("swarm-ripple", stage);
    rp.style.setProperty("--h", "200");
    Object.assign(rp.style, { left: `${r.left + r.width / 2}px`, top: `${r.top + r.height / 2}px` });
    rp.animate([{ transform: "scale(0.2)", opacity: 0.9 }, { transform: "scale(2.6)", opacity: 0 }], { duration: 560, easing: "ease-out", fill: "forwards" });
    me.animate([{ transform: `translate3d(${at.x}px, ${at.y}px, 0) scale(1)` }, { transform: `translate3d(${at.x}px, ${at.y + 2}px, 0) scale(0.82)` }, { transform: `translate3d(${at.x}px, ${at.y}px, 0) scale(1)` }], { duration: 240, easing: "ease-in-out" });
    if (typeof el.animate === "function") el.animate([{ transform: "scale(1)" }, { transform: "scale(0.9)" }, { transform: "scale(1)" }], { duration: 240, easing: "ease-in-out", composite: "add" } as KeyframeAnimationOptions);
    haptic("tick", 0.6);
    await wait(130);
    el.click();
    await wait(260);
    window.setTimeout(() => rp.remove(), 500);
  };
  const tile = (scope: string) => q(`${scope} .cal-day[data-day="${day}"]`);
  const short = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  let ok = false;
  try {
    await wait(260);
    const home = q(".nav-island:not(.away) .nav-home");
    const cal = () => q(".month-calendar");
    // Today: Home. (Also the way back to the calendar from a page.)
    if (day === today && visible(home)) {
      await tap(home, "Home → today", 600);
      ok = true;
      return ok;
    }
    if (!cal() && visible(home)) {
      await tap(home, "Home first", 560);
      await until(cal, 1500);
    }
    const section = cal();
    if (!section) return false;
    // The calendar sits at the top of the note: bring it into sight.
    if (!visible(section.querySelector(".cal-bar"))) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      await until(() => visible(section.querySelector(".cal-bar")), 900);
    }
    const collapsed = section.classList.contains("collapsed");
    const inStrip = collapsed && visible(tile(".month-calendar"));
    const route = navRoute(day, today, section.dataset.month ?? null, inStrip);
    if (route === "home") {
      if (!visible(home)) return false;
      await tap(home, "Home → today", 600);
      return (ok = true);
    }
    if (route === "week") {
      await tap(tile(".month-calendar")!, `Week · ${short}`, 620);
      return (ok = true);
    }
    if (route === "month") {
      if (collapsed) {
        const title = section.querySelector<HTMLElement>(".cal-title");
        if (!title) return false;
        await tap(title, "Month view", 560);
        await until(() => !cal()?.classList.contains("collapsed") && cal(), 900);
        await wait(240);
      }
      // Step to the right month with ‹ ›, one tap a month.
      for (let n = 0; n < 4; n++) {
        const s = cal();
        const shown = s?.dataset.month;
        if (!s || !shown) return false;
        const by = monthsBetween(shown, day.slice(0, 7));
        if (!by) break;
        const btn = s.querySelectorAll<HTMLElement>(".cal-month-step")[by < 0 ? 0 : 1];
        if (!btn) return false;
        const name = new Date(`${addDays(`${shown}-15`, by < 0 ? -30 : 30).slice(0, 7)}-15T12:00:00`).toLocaleDateString(undefined, { month: "long" });
        await tap(btn, `${by < 0 ? "‹" : "›"} ${name}`, n ? 380 : 520);
        await until(() => cal()?.dataset.month !== shown, 900);
        await wait(160);
      }
      const t = await until(() => tile(".month-calendar"), 900);
      if (!t) return false;
      await tap(t, `Month · ${short}`, 600);
      // Back to the week strip, as it was.
      if (collapsed) {
        await wait(260);
        const s = cal();
        const title = s && !s.classList.contains("collapsed") ? s.querySelector<HTMLElement>(".cal-title") : null;
        if (title) await tap(title, "Fold to week", 420);
      }
      return (ok = true);
    }
    // Year.
    const yearBtn = section.querySelector<HTMLElement>(".cal-year");
    if (!yearBtn) return false;
    await tap(yearBtn, "Year view", 560);
    const panel = await until(() => q(".year-panel.open .year-grid"), 1600);
    if (!panel) return false;
    await wait(360);
    const want = Number(day.slice(0, 4));
    for (let n = 0; n < 30; n++) {
      const shown = Number(q(".year-panel.open .year-header h2")?.textContent ?? "0");
      if (!shown || shown === want) break;
      const btn = q(`.year-panel.open .year-header button[aria-label="${shown > want ? "Previous" : "Next"} year"]`);
      if (!btn) return false;
      await tap(btn, `${shown > want ? "‹" : "›"} ${shown > want ? shown - 1 : shown + 1}`, n ? (Math.abs(shown - want) > 3 ? 220 : 340) : 480);
      await until(() => Number(q(".year-panel.open .year-header h2")?.textContent ?? "0") !== shown, 700);
    }
    const t = await until(() => tile(".year-panel.open"), 1200);
    if (!t) return false;
    await tap(t, `Year · ${short}`, 700);
    return (ok = true);
  } catch {
    return ok;
  } finally {
    // Off it goes.
    void me.animate([{ opacity: 1 }, { opacity: 0, transform: `translate3d(${at.x + 40}px, ${at.y - 50}px, 0) scale(0.8)` }], { duration: 420, easing: "ease-in", fill: "forwards" }).finished.catch(() => undefined).then(() => root.remove());
    window.setTimeout(() => root.remove(), 900);
    document.documentElement.classList.remove("nav-showing");
    busy = false;
  }
}
