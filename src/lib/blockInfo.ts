/** Properties on one block, e.g. { Mood: "happy", Place: "home" }. */
export type BlockInfo = Record<string, string>;

const DEFAULTS_KEY = "dynamic-journal.block-info-defaults";

/** Info that new blocks get from now on (this device). Past blocks keep what they have. */
export function loadInfoDefaults(): BlockInfo {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveInfoDefaults(info: BlockInfo) {
  try {
    if (Object.keys(info).length) localStorage.setItem(DEFAULTS_KEY, JSON.stringify(info));
    else localStorage.removeItem(DEFAULTS_KEY);
  } catch {
    // Not critical.
  }
}

/** Info without empty keys or values, keys trimmed; null when nothing is left. */
export function cleanInfo(info: BlockInfo | null | undefined): BlockInfo | null {
  const out: BlockInfo = {};
  for (const [k, v] of Object.entries(info ?? {})) if (k.trim() && v.trim()) out[k.trim()] = v.trim();
  return Object.keys(out).length ? out : null;
}

/** "Mood: happy · Place: home". */
export const infoLabel = (info: BlockInfo) =>
  Object.entries(info)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
