import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { KEEP_NEWEST, THIN_SQL, thinCutoff, thinnable, type ThinRow } from "./thin";
import { MemoryStore } from "./memoryStore";

function rand(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** A made-up log: a few notes, two devices, mostly "me", over ~90 days. */
function makeLog(n: number, seed = 3): ThinRow[] {
  const r = rand(seed);
  const now = Date.parse("2026-11-10T12:00:00Z");
  const rows: ThinRow[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(now - Math.floor(r() * 90 * 86_400_000)).toISOString();
    const op = r() < 0.85 ? "update" : (["create", "props", "restore"] as const)[Math.floor(r() * 3)];
    const actor = r() < 0.9 ? "me" : r() < 0.5 ? "sync" : "Claude";
    // Several edits in the same minute, like typing.
    rows.push({ id: `e${i}`, blockId: `b${Math.floor(r() * 6)}`, deviceId: r() < 0.5 ? "mac" : "phone", actor, op, createdAt: i && r() < 0.4 ? rows[i - 1].createdAt : t, seq: i + 1 });
  }
  return rows;
}

describe("thinning old edit history", () => {
  const cutoff = thinCutoff(Date.parse("2026-11-10T12:00:00Z"));

  it("keeps recent edits, the newest of each note, one per hour, and everything not typed by me", () => {
    const rows = makeLog(3000);
    const gone = thinnable(rows, cutoff);
    expect(gone.size).toBeGreaterThan(300);
    const kept = rows.filter((r) => !gone.has(r.id));
    for (const r of rows.filter((x) => gone.has(x.id))) {
      expect(r.op).toBe("update");
      expect(r.actor).toBe("me");
      expect(r.createdAt < cutoff).toBe(true);
      // Its hour still has a kept edit for that note, device and actor.
      expect(kept.some((k) => k.blockId === r.blockId && k.deviceId === r.deviceId && k.actor === r.actor && k.op === "update" && k.createdAt.slice(0, 13) === r.createdAt.slice(0, 13))).toBe(true);
    }
    for (const b of new Set(rows.map((r) => r.blockId))) {
      const newest = rows.filter((r) => r.blockId === b && r.op === "update").sort((a, z) => (a.createdAt < z.createdAt ? 1 : a.createdAt > z.createdAt ? -1 : z.seq - a.seq)).slice(0, KEEP_NEWEST);
      for (const r of newest) expect(gone.has(r.id)).toBe(false);
    }
  });

  it("the SQL picks exactly the same edits", () => {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = createRequire(import.meta.url)("node:sqlite");
    } catch {
      console.warn("node:sqlite missing: SQL not checked");
      return; // Node without SQLite: the rule above is still checked.
    }
    const rows = makeLog(2500, 11);
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("CREATE TABLE events (id TEXT PRIMARY KEY, device_id TEXT, actor TEXT, block_id TEXT, op TEXT, created_at TEXT)");
    const ins = db.prepare("INSERT INTO events (rowid, id, device_id, actor, block_id, op, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(r.seq, r.id, r.deviceId, r.actor, r.blockId, r.op, r.createdAt);
    const ids = (db.prepare(THIN_SQL.replace("$1", "?")).all(cutoff) as { id: string }[]).map((x) => x.id);
    expect(new Set(ids)).toEqual(thinnable(rows, cutoff));
  });

  it("the memory store thins its log and keeps the note", async () => {
    const store = new MemoryStore();
    const doc = (t: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
    for (let i = 0; i < 30; i++) await store.saveDay({ day: "2026-01-05", content: doc(`v${i}`), plainText: `v${i}` });
    // All of them typed long ago, in one hour.
    const data = (store as unknown as { data: { events: { createdAt: string }[] } }).data;
    for (const e of data.events) e.createdAt = "2026-01-05T10:00:00.000Z";
    const before = data.events.length;
    const gone = await store.thinHistory(cutoff);
    expect(gone).toBe(before - 1 - KEEP_NEWEST); // the create and the newest 8 stay
    expect((await store.getDay("2026-01-05"))?.content).toEqual(doc("v29"));
  });
});
