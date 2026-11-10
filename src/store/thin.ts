/**
 * Thinning old edit history (Hapi chose it, 2026-11-10).
 *
 * Every save while typing logs the whole page twice (before and after), so the log grew far faster
 * than the notes: on the Mac 555 MB of history for under 1 MB of notes, 50–90 MB on a busy day.
 * Edits older than THIN_AFTER_DAYS are thinned to the last one in each hour, per note, device and
 * actor. Nothing typed is lost: every kept edit still holds its whole page, and today's text is in
 * the note itself. Always kept:
 * - the newest KEEP_NEWEST edits of each note (sync may still point at those),
 * - creates, props changes, restores and merges ("sync"), and anything an AI or a tool did
 *   (shown and undone by name),
 * - everything from the last THIN_AFTER_DAYS days.
 * Sync files only point at edits from the last REF_MAX_DAYS days (engine.ts), well inside that.
 */

export const THIN_AFTER_DAYS = 30;
export const KEEP_NEWEST = 8;

export interface ThinRow {
  id: string;
  blockId: string;
  deviceId: string;
  actor: string;
  op: string;
  createdAt: string;
  /** Order between rows with the same time (SQLite rowid; log position in the memory store). */
  seq: number;
}

/** The cut-off time for a run at `now`. */
export const thinCutoff = (now = Date.now()) => new Date(now - THIN_AFTER_DAYS * 86_400_000).toISOString();

const newestFirst = (a: ThinRow, b: ThinRow) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.seq - a.seq);

/** Ids of the events the rule thins away (the same rule as THIN_SQL). */
export function thinnable(rows: ThinRow[], cutoff: string): Set<string> {
  const updates = rows.filter((r) => r.op === "update").sort(newestFirst);
  const perBlock = new Map<string, number>();
  const perHour = new Set<string>();
  const out = new Set<string>();
  for (const r of updates) {
    const recent = (perBlock.get(r.blockId) ?? 0) + 1;
    perBlock.set(r.blockId, recent);
    const hour = `${r.blockId}\u0000${r.deviceId}\u0000${r.actor}\u0000${r.createdAt.slice(0, 13)}`;
    const firstInHour = !perHour.has(hour);
    perHour.add(hour);
    if (recent > KEEP_NEWEST && !firstInHour && r.actor === "me" && r.createdAt < cutoff) out.add(r.id);
  }
  return out;
}

/** THIN rule in SQL ($1 = cut-off). Selects the ids to delete. */
export const THIN_SQL = `SELECT id FROM (
  SELECT id, actor, created_at,
    ROW_NUMBER() OVER (PARTITION BY block_id ORDER BY created_at DESC, rowid DESC) AS recent,
    ROW_NUMBER() OVER (PARTITION BY block_id, device_id, actor, substr(created_at, 1, 13) ORDER BY created_at DESC, rowid DESC) AS in_hour
  FROM events WHERE op = 'update'
) WHERE recent > ${KEEP_NEWEST} AND in_hour > 1 AND actor = 'me' AND created_at < $1`;
