import { niceStep } from "../lib/mathSmart";

/**
 * Favourite formulas (⭐ on a math block): kept on this device and sent to the watch, where each
 * variable is turned with the rotating bezel. `expr` is plain calculator maths ("pi*r^2").
 */
export interface FavFormula {
  name: string;
  expr: string;
  lhs: string;
  vars: { name: string; value: number; step: number; label?: string }[];
}

const KEY = "journal.favFormulas";
export const FAV_EVENT = "journal:fav-formulas";

export function favouriteFormulas(): FavFormula[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const save = (list: FavFormula[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    // Only a convenience.
  }
  window.dispatchEvent(new Event(FAV_EVENT));
};

export const isFavourite = (expr: string) => favouriteFormulas().some((f) => f.expr === expr.trim());

/** Stars or unstars a formula; returns whether it's a favourite now. */
export function toggleFavourite(f: { name: string; expr: string; lhs: string | null; vars: { name: string; value: number; label?: string }[] }): boolean {
  const expr = f.expr.trim();
  const list = favouriteFormulas();
  if (list.some((x) => x.expr === expr)) {
    save(list.filter((x) => x.expr !== expr));
    return false;
  }
  const vars = f.vars.map((v) => ({ ...v, step: niceStep(v.value) }));
  save([{ name: f.name, expr, lhs: f.lhs ?? "", vars }, ...list]);
  return true;
}
