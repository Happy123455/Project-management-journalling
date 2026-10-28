import Database from "@tauri-apps/plugin-sql";
import { extractLinks } from "../lib/links";
import { deviceId, newId } from "./ids";
import type { DayPage, JournalEvent, JournalStore, SaveDayInput } from "./types";

interface BlockRow {
  id: string;
  day: string;
  content: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  device_id: string;
  actor: string;
  block_id: string;
  op: JournalEvent["op"];
  before: string | null;
  after: string;
  parent_event_ids: string;
  created_at: string;
}

const toPage = (row: BlockRow): DayPage => ({
  id: row.id,
  day: row.day,
  content: JSON.parse(row.content),
  updatedAt: row.updated_at,
});

/** The app's real store: journal.db in the app data folder (schema in src-tauri/src/lib.rs). */
export class SqliteStore implements JournalStore {
  private constructor(private db: Database, private device: string) {}

  static async open(): Promise<SqliteStore> {
    return new SqliteStore(await Database.load("sqlite:journal.db"), deviceId());
  }

  async getDay(day: string) {
    const rows = await this.db.select<BlockRow[]>(
      "SELECT id, day, content, updated_at FROM blocks WHERE type = 'day' AND day = $1",
      [day],
    );
    return rows[0] ? toPage(rows[0]) : null;
  }

  async saveDay({ day, content, plainText, actor = "me" }: SaveDayInput) {
    const now = new Date().toISOString();
    const after = JSON.stringify(content);
    const existing = await this.getDay(day);
    if (existing && JSON.stringify(existing.content) === after) return existing;
    const id = existing?.id ?? newId();

    if (existing) {
      await this.db.execute("UPDATE blocks SET content = $1, updated_at = $2 WHERE id = $3", [after, now, id]);
    } else {
      await this.db.execute(
        `INSERT INTO blocks (id, parent_id, sort_order, type, type_version, day, content, props, created_at, updated_at)
         VALUES ($1, NULL, 0, 'day', 1, $2, $3, '{}', $4, $4)`,
        [id, day, after, now],
      );
    }

    const last = await this.db.select<{ id: string }[]>(
      "SELECT id FROM events WHERE block_id = $1 ORDER BY created_at DESC LIMIT 1",
      [id],
    );
    await this.db.execute(
      `INSERT INTO events (id, device_id, actor, block_id, op, before, after, parent_event_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newId(), this.device, actor, id, existing ? "update" : "create",
        existing ? JSON.stringify(existing.content) : null, after,
        JSON.stringify(last.map((e) => e.id)), now,
      ],
    );

    const { wikilinks, tags } = extractLinks(plainText);
    await this.db.execute("DELETE FROM links WHERE from_block = $1", [id]);
    for (const [kind, targets] of [["wikilink", wikilinks], ["tag", tags]] as const) {
      for (const target of targets) {
        await this.db.execute(
          "INSERT OR IGNORE INTO links (from_block, target, kind, created_at) VALUES ($1, $2, $3, $4)",
          [id, target, kind, now],
        );
      }
    }

    return { id, day, content, updatedAt: now };
  }

  async listDays() {
    const rows = await this.db.select<{ day: string }[]>(
      "SELECT day FROM blocks WHERE type = 'day' ORDER BY day DESC",
    );
    return rows.map((r) => r.day);
  }

  async eventsFor(blockId: string) {
    const rows = await this.db.select<EventRow[]>(
      "SELECT * FROM events WHERE block_id = $1 ORDER BY created_at",
      [blockId],
    );
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      actor: r.actor,
      blockId: r.block_id,
      op: r.op,
      before: r.before,
      after: r.after,
      parentEventIds: JSON.parse(r.parent_event_ids),
      createdAt: r.created_at,
    }));
  }
}
