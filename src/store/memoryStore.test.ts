import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memoryStore";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("MemoryStore", () => {
  it("creates a day page and logs a create event", async () => {
    const store = new MemoryStore(undefined, "laptop");
    const page = await store.saveDay({ day: "2026-10-28", content: doc("hi"), plainText: "hi" });
    expect(await store.getDay("2026-10-28")).toEqual(page);
    const events = await store.eventsFor(page.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "create", deviceId: "laptop", parentEventIds: [] });
  });

  it("chains update events and skips saves with no change", async () => {
    const store = new MemoryStore(undefined, "laptop");
    const page = await store.saveDay({ day: "2026-10-28", content: doc("a"), plainText: "a" });
    await store.saveDay({ day: "2026-10-28", content: doc("b"), plainText: "b" });
    await store.saveDay({ day: "2026-10-28", content: doc("b"), plainText: "b" });
    const [first, second] = await store.eventsFor(page.id);
    expect(await store.eventsFor(page.id)).toHaveLength(2);
    expect(second.parentEventIds).toEqual([first.id]);
  });

  it("handles overlapping saves of a new day as one page (no duplicate create)", async () => {
    const store = new MemoryStore(undefined, "phone");
    const [a, b] = await Promise.all([
      store.saveDay({ day: "2026-10-28", content: doc("a"), plainText: "a" }),
      store.saveDay({ day: "2026-10-28", content: doc("ab"), plainText: "ab" }),
    ]);
    expect(b.id).toBe(a.id);
    expect((await store.eventsFor(a.id)).map((e) => e.op)).toEqual(["create", "update"]);
    expect((await store.getDay("2026-10-28"))?.content).toEqual(doc("ab"));
  });

  it("persists through storage", async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    await new MemoryStore(storage, "phone").saveDay({ day: "2026-10-27", content: doc("x"), plainText: "x" });
    expect(await new MemoryStore(storage, "phone").listDays()).toEqual(["2026-10-27"]);
  });

  it("counts words per day within a range", async () => {
    const store = new MemoryStore(undefined, "laptop");
    await store.saveDay({ day: "2026-10-01", content: doc("one two"), plainText: "one two" });
    await store.saveDay({ day: "2026-11-01", content: doc("three"), plainText: "three" });
    expect(await store.wordCounts("2026-10-01", "2026-10-31")).toEqual({ "2026-10-01": 2 });
  });

  describe("reminders", () => {
    afterEach(() => vi.useRealTimers());

    it("turns a page written for a future day into a reminder", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 28, 10) });
      const store = new MemoryStore(undefined, "phone");
      await store.saveDay({ day: "2026-10-27", content: doc("yesterday"), plainText: "yesterday" });
      const page = await store.saveDay({ day: "2026-11-02", content: doc("call bank"), plainText: "call bank" });
      expect(page.props).toEqual({ reminder: true });
      expect((await store.openReminders()).map((p) => p.day)).toEqual(["2026-11-02"]);
      expect((await store.eventsFor(page.id)).map((e) => e.op)).toEqual(["create", "props"]);
    });

    it("stays a reminder after its day comes, until marked done with an event", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 28, 10) });
      const store = new MemoryStore(undefined, "phone");
      const page = await store.saveDay({ day: "2026-10-30", content: doc("pay rent"), plainText: "pay rent" });

      vi.setSystemTime(new Date(2026, 10, 1, 9));
      await store.saveDay({ day: "2026-10-30", content: doc("pay rent today"), plainText: "pay rent today" });
      expect((await store.openReminders()).map((p) => p.day)).toEqual(["2026-10-30"]);

      await store.completeReminder("2026-10-30");
      expect(await store.openReminders()).toEqual([]);
      const events = await store.eventsFor(page.id);
      expect(events.map((e) => e.op)).toEqual(["create", "props", "update", "props"]);
      expect(JSON.parse(events[3].after)).toEqual({ reminder: true, reminderDone: true });
      expect(events[3].parentEventIds).toEqual([events[2].id]);
    });

    it("leaves out reminder pages whose text was deleted", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 28, 10) });
      const store = new MemoryStore(undefined, "phone");
      await store.saveDay({ day: "2026-10-29", content: doc("x"), plainText: "x" });
      await store.saveDay({ day: "2026-10-29", content: { type: "doc", content: [{ type: "paragraph" }] }, plainText: "" });
      expect(await store.openReminders()).toEqual([]);
    });

    it("ignores done on a page that is not a reminder", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 28, 10) });
      const store = new MemoryStore(undefined, "phone");
      const page = await store.saveDay({ day: "2026-10-28", content: doc("today"), plainText: "today" });
      await store.completeReminder("2026-10-28");
      expect(await store.eventsFor(page.id)).toHaveLength(1);
    });
  });

  describe("pages, links and tags", () => {
    it("creates a named page once, with an event, whatever the letter case", async () => {
      const store = new MemoryStore(undefined, "phone");
      const page = await store.ensurePage("Ravi");
      expect(await store.ensurePage("ravi")).toEqual(page);
      expect((await store.eventsFor(page.id)).map((e) => e.op)).toEqual(["create"]);
    });

    it("finds every day and page that links to a page, newest day first", async () => {
      const store = new MemoryStore(undefined, "phone");
      await store.saveDay({ day: "2026-10-20", content: doc("met [[Ravi]]"), plainText: "met [[Ravi]]" });
      await store.saveDay({ day: "2026-10-25", content: doc("call [[ravi]] #work"), plainText: "call [[ravi]] #work" });
      await store.saveDay({ day: "2026-10-26", content: doc("nothing"), plainText: "nothing" });
      const project = await store.ensurePage("Project X");
      await store.savePage({ id: project.id, content: doc("lead: [[Ravi]]"), plainText: "lead: [[Ravi]]" });

      const refs = await store.references("wikilink", "RAVI");
      expect(refs.map((r) => r.day ?? r.title)).toEqual(["2026-10-25", "2026-10-20", "Project X"]);
      expect((await store.references("tag", "work")).map((r) => r.day)).toEqual(["2026-10-25"]);
      expect(await store.pageNames()).toEqual(["Project X", "Ravi"]);
    });

    it("logs page edits as update events and refreshes its links", async () => {
      const store = new MemoryStore(undefined, "phone");
      const page = await store.ensurePage("Ideas");
      await store.savePage({ id: page.id, content: doc("#later"), plainText: "#later" });
      await store.savePage({ id: page.id, content: doc("#now"), plainText: "#now" });
      expect((await store.eventsFor(page.id)).map((e) => e.op)).toEqual(["create", "update", "update"]);
      expect(await store.references("tag", "later")).toEqual([]);
      expect((await store.references("tag", "now"))[0].title).toBe("Ideas");
    });
  });

  describe("attachments", () => {
    it("stores a file with a create event and gives the bytes back", async () => {
      const store = new MemoryStore(undefined, "phone");
      const bytes = new TextEncoder().encode("hello");
      const file = await store.saveFile({ name: "My Note.txt", mime: "text/plain", bytes });
      expect(file).toMatchObject({ name: "My_Note.txt", mime: "text/plain", size: 5, path: `attachments/${file.id}/My_Note.txt` });
      expect(await store.fileBytes(file.id)).toEqual(bytes);
      expect(await store.getFile(file.id)).toEqual(file);
      const [event] = await store.eventsFor(file.id);
      expect(event).toMatchObject({ op: "create", before: null });
      expect(JSON.parse(event.after)).toMatchObject({ name: "My_Note.txt", size: 5 });
    });

    it("exports the journal and every attachment", async () => {
      const store = new MemoryStore(undefined, "phone");
      await store.saveDay({ day: "2026-10-28", content: doc("hi"), plainText: "hi" });
      const file = await store.saveFile({ name: "a.txt", mime: "text/plain", bytes: new Uint8Array([7]) });
      const files = await store.exportFiles();
      expect(files.map((f) => f.name)).toEqual(["journal.json", file.path]);
      const journal = JSON.parse(new TextDecoder().decode(files[0].bytes));
      expect(journal.pages["2026-10-28"].content).toEqual(doc("hi"));
      expect(journal.files[file.id]).not.toHaveProperty("data");
      expect(files[1].bytes).toEqual(new Uint8Array([7]));
    });

    it("finds a file from an embed: by stored path or by name", async () => {
      const store = new MemoryStore(undefined, "phone");
      const file = await store.saveFile({ name: "Invoice October.pdf", mime: "application/pdf", bytes: new Uint8Array([1]) });
      expect(await store.findFile(file.path)).toEqual(file);
      expect(await store.findFile("invoice october.pdf")).toEqual(file);
      expect(await store.findFile("attachments/nope/x.pdf")).toBeNull();
      expect(await store.findFile("other.pdf")).toBeNull();
    });

    it("lists every file, newest first", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 1) });
      const store = new MemoryStore(undefined, "phone");
      const a = await store.saveFile({ name: "a.png", mime: "image/png", bytes: new Uint8Array([1]) });
      vi.setSystemTime(new Date(2026, 9, 2));
      const b = await store.saveFile({ name: "b.pdf", mime: "application/pdf", bytes: new Uint8Array([2]) });
      vi.useRealTimers();
      expect((await store.listFiles()).map((f) => f.id)).toEqual([b.id, a.id]);
    });

    it("restores a backup over the current journal and logs it", async () => {
      const store = new MemoryStore(undefined, "phone");
      await store.saveDay({ day: "2026-10-28", content: doc("kept"), plainText: "kept" });
      const file = await store.saveFile({ name: "a.png", mime: "image/png", bytes: new Uint8Array([9, 9]) });
      const backup = await store.exportFiles();

      await store.saveDay({ day: "2026-10-28", content: doc("changed later"), plainText: "" });
      await store.saveDay({ day: "2026-10-29", content: doc("new day"), plainText: "" });
      await store.restore(backup, "dynamic-journal-2026-10-28.zip");

      expect((await store.getDay("2026-10-28"))?.content).toEqual(doc("kept"));
      expect(await store.getDay("2026-10-29")).toBeNull();
      expect(await store.fileBytes(file.id)).toEqual(new Uint8Array([9, 9]));
      const [event] = await store.eventsFor("journal");
      expect(event.op).toBe("restore");
      expect(JSON.parse(event.after)).toEqual({ source: "dynamic-journal-2026-10-28.zip", days: 1, files: 1 });
    });

    it("refuses a backup made by the app (SQLite) in the browser store", async () => {
      const store = new MemoryStore(undefined, "phone");
      await expect(store.restore([{ name: "journal.db", bytes: new Uint8Array([1]) }], "x.zip")).rejects.toThrow(/app/);
    });

    it("keeps one copy of identical files", async () => {
      const store = new MemoryStore(undefined, "phone");
      const bytes = new Uint8Array([1, 2, 3]);
      const a = await store.saveFile({ name: "a.bin", mime: "", bytes });
      const b = await store.saveFile({ name: "b.bin", mime: "", bytes });
      expect(b.id).toBe(a.id);
      expect(await store.eventsFor(a.id)).toHaveLength(1);
    });
  });

  it("searches days, pages and file names for every word", async () => {
    const store = new MemoryStore(undefined, "phone");
    await store.saveDay({ day: "2026-10-20", content: doc("met Ravi about the plan"), plainText: "" });
    await store.saveDay({ day: "2026-10-25", content: doc("RAVI called, plan is done"), plainText: "" });
    await store.saveDay({ day: "2026-10-26", content: doc("only Ravi"), plainText: "" });
    const page = await store.ensurePage("Plan B");
    await store.savePage({ id: page.id, content: doc("ask ravi"), plainText: "" });
    await store.saveFile({ name: "ravi plan.pdf", mime: "application/pdf", bytes: new Uint8Array([1]) });

    const hits = await store.search("ravi plan");
    expect(hits.map((h) => (h.kind === "file" ? h.file.name : (h.day ?? h.title)))).toEqual(["2026-10-25", "2026-10-20", "Plan B", "ravi_plan.pdf"]);
    expect(await store.search("   ")).toEqual([]);
  });

  it("lists every link and tag with where it is, for the graph", async () => {
    const store = new MemoryStore(undefined, "phone");
    await store.saveDay({ day: "2026-10-20", content: doc("x"), plainText: "met [[Ravi]] #work" });
    const p = await store.ensurePage("Ravi");
    await store.savePage({ id: p.id, content: doc("y"), plainText: "see [[Project X]]" });
    expect((await store.graphLinks()).sort((a, b) => a.target.localeCompare(b.target))).toEqual([
      { day: null, title: "Ravi", target: "Project X", kind: "wikilink" },
      { day: "2026-10-20", title: null, target: "Ravi", kind: "wikilink" },
      { day: "2026-10-20", title: null, target: "work", kind: "tag" },
    ]);
  });

  it("marks a page as a project, logs it, and lists projects", async () => {
    const store = new MemoryStore(undefined, "phone");
    const p = await store.ensurePage("Project X");
    await store.ensurePage("Ravi");
    const updated = await store.setPageProps(p.id, { project: { status: "active" } });
    expect(updated.props).toEqual({ project: { status: "active" } });
    expect((await store.projects()).map((x) => x.title)).toEqual(["Project X"]);
    await store.setPageProps(p.id, { project: undefined });
    expect(await store.projects()).toEqual([]);
    expect((await store.eventsFor(p.id)).map((e) => e.op)).toEqual(["create", "props", "props"]);
  });

  it("lists AI edits and undoes one when nothing changed since", async () => {
    const store = new MemoryStore(undefined, "phone");
    await store.saveDay({ day: "2026-10-28", content: doc("teh cat"), plainText: "teh cat" });
    await store.saveDay({ day: "2026-10-28", content: doc("the cat"), plainText: "the cat", actor: "Gemini" });
    const [change] = await store.aiChanges();
    expect(change).toMatchObject({ day: "2026-10-28", undoable: true, event: { actor: "Gemini", op: "update" } });

    expect(await store.undoAiChange(change.event.id)).toBe(true);
    expect((await store.getDay("2026-10-28"))?.content).toEqual(doc("teh cat"));
    const ops = (await store.eventsFor(change.event.blockId)).map((e) => `${e.actor}:${e.op}`);
    expect(ops).toEqual(["me:create", "Gemini:update", "me:update"]);
    // Already undone (the note changed since): can't undo again.
    expect((await store.aiChanges())[0].undoable).toBe(false);
    expect(await store.undoAiChange(change.event.id)).toBe(false);
  });
});
