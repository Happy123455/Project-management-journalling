/** A copy of `props` with `patch` applied; keys set to undefined are removed. */
export function withPatch<T extends object>(props: T, patch: Partial<T>): T {
  const next = { ...props } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
}
