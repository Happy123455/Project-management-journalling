import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { importRecords, MemoryFolder, memoryOnly, syncOnce } from "./engine";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const at = (iso: string) => vi.setSystemTime(new Date(iso));

describe("sync between two devices through one folder", () => {
  afterEach(() => vi.useRealTimers());

  it("brings pages, edits, reminders and files across, and settles on the same text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");

    at("2026-10-28T09:00:00Z");
    await phone.saveDay({ day: "2026-10-28", content: doc("from phone [[Ravi]]"), plainText: "from phone [[Ravi]]" });
    const photo = await phone.saveFile({ name: "p.png", mime: "image/png", bytes: new Uint8Array([7, 7]) });
    await syncOnce(phone, folder);
    const first = await syncOnce(mac, folder);
    expect(first.imported).toBeGreaterThan(0);
    expect((await mac.getDay("2026-10-28"))?.content).toEqual(doc("from phone [[Ravi]]"));
    expect(await mac.fileBytes(photo.id)).toEqual(new Uint8Array([7, 7]));
    expect((await mac.references("wikilink", "ravi")).length).toBe(1);

    // Both edit the same day without seeing each other: nothing is lost, both end with both texts.
    at("2026-10-28T10:00:00Z");
    await phone.saveDay({ day: "2026-10-28", content: doc("phone edit"), plainText: "" });
    at("2026-10-28T10:05:00Z");
    await mac.saveDay({ day: "2026-10-28", content: doc("mac edit"), plainText: "" });
    await syncOnce(mac, folder);
    await syncOnce(phone, folder);
    await syncOnce(mac, folder);
    const both = { type: "doc", content: [doc("phone edit").content[0], doc("mac edit").content[0]] };
    expect((await phone.getDay("2026-10-28"))?.content).toEqual(both);
    expect((await mac.getDay("2026-10-28"))?.content).toEqual(both);
    // Both edits stay in both histories.
    const ops = async (s: MemoryStore) => (await s.eventsFor("day:2026-10-28")).map((e) => e.deviceId + ":" + e.op).sort();
    // Each device recorded its kept-both version as its own edit; one more round shares them.
    await syncOnce(phone, folder);
    await syncOnce(mac, folder);
    await syncOnce(phone, folder);
    expect(await ops(phone)).toEqual(await ops(mac));
    expect(await ops(phone)).toEqual(["mac:update", "mac:update", "phone:create", "phone:update", "phone:update"]);

    // Then the Mac continues the merged text (deleting a line): that edit is taken as it is.
    at("2026-10-28T11:00:00Z");
    await mac.saveDay({ day: "2026-10-28", content: doc("mac edit"), plainText: "" });
    await syncOnce(mac, folder);
    await syncOnce(phone, folder);
    expect((await phone.getDay("2026-10-28"))?.content).toEqual(doc("mac edit"));

    // Syncing again changes nothing.
    expect(await syncOnce(phone, folder)).toEqual({ exported: 0, imported: 0, files: 0 });
    expect(await syncOnce(mac, folder)).toEqual({ exported: 0, imported: 0, files: 0 });
  });

  it("fetches a photo whose bytes reached the folder after its event, and skips a half-written copy", async () => {
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");
    const photo = await phone.saveFile({ name: "p.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) });
    await syncOnce(phone, folder);
    const path = `files/${photo.hash}`;
    const whole = folder.files.get(path)!;
    // The Mac sees the event while the bytes are still on their way (missing, then cut short).
    folder.files.delete(path);
    await syncOnce(mac, folder);
    expect(await mac.fileBytes(photo.id)).toBeNull();
    expect((await mac.missingFiles()).map((f) => f.id)).toEqual([photo.id]);
    folder.files.set(path, whole.slice(0, 2));
    await syncOnce(mac, folder);
    expect(await mac.fileBytes(photo.id)).toBeNull();
    folder.files.set(path, whole);
    expect((await syncOnce(mac, folder)).files).toBe(1);
    expect(await mac.fileBytes(photo.id)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await mac.missingFiles()).toEqual([]);
  });

  it("each device writes only its own files", async () => {
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    await phone.saveDay({ day: "2026-10-28", content: doc("x"), plainText: "x" });
    await syncOnce(phone, folder);
    expect([...folder.files.keys()].every((p) => p.startsWith("events/phone/") || p.startsWith("files/"))).toBe(true);
  });

  it("treats pages both devices made for the same day before syncing as one page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");
    at("2026-10-28T08:00:00Z");
    await mac.saveDay({ day: "2026-10-28", content: doc("mac first"), plainText: "" });
    at("2026-10-28T09:00:00Z");
    await phone.saveDay({ day: "2026-10-28", content: doc("phone later"), plainText: "" });
    await syncOnce(phone, folder);
    await syncOnce(mac, folder);
    // Neither saw the other's text, so both stay.
    expect((await mac.getDay("2026-10-28"))?.content).toEqual({ type: "doc", content: [doc("mac first").content[0], doc("phone later").content[0]] });
    expect(await mac.listDays()).toEqual(["2026-10-28"]);
  });

  it("carries project status across devices", async () => {
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");
    const p = await phone.ensurePage("Project X");
    await phone.setPageProps(p.id, { project: { status: "paused" } });
    await syncOnce(phone, folder);
    await syncOnce(mac, folder);
    expect((await mac.projects()).map((x) => [x.title, x.props.project?.status])).toEqual([["Project X", "paused"]]);
  });
});

describe("phone notes survive syncing with the Mac", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a long phone page when the Mac later wrote a little on the same day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");
    const lines = (...t: string[]) => ({ type: "doc", content: t.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
    at("2026-10-29T08:00:00Z");
    await phone.saveDay({ day: "2026-10-29", content: lines("one"), plainText: "" });
    at("2026-10-29T09:00:00Z");
    await phone.saveDay({ day: "2026-10-29", content: lines("one", "two", "three"), plainText: "" });
    at("2026-10-29T10:00:00Z");
    await mac.saveDay({ day: "2026-10-29", content: lines("mac note"), plainText: "" });
    for (const s of [mac, phone, mac, phone]) await syncOnce(s, folder);
    const want = lines("one", "two", "three", "mac note");
    for (const s of [phone, mac]) {
      const got = (await s.getDay("2026-10-29"))?.content as { content: unknown[] };
      expect(new Set(got.content.map((n) => JSON.stringify(n)))).toEqual(new Set(want.content.map((n) => JSON.stringify(n))));
    }
    expect((await phone.getDay("2026-10-29"))?.content).toEqual((await mac.getDay("2026-10-29"))?.content);
  });
});

describe("sync on mobile data", () => {
  afterEach(() => vi.useRealTimers());

  it("downloads only what's new after the first round", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-10-30T08:00:00Z");
    const folder = new MemoryFolder();
    const reads: string[] = [];
    const read = folder.read.bind(folder);
    folder.read = async (path) => (reads.push(path), read(path));
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");
    const phoneMemory = memoryOnly();
    await mac.saveDay({ day: "2026-10-30", content: doc("mac"), plainText: "" });
    await syncOnce(mac, folder);
    await syncOnce(phone, folder, phoneMemory);
    expect((await phone.getDay("2026-10-30"))?.content).toEqual(doc("mac"));

    reads.length = 0;
    await phone.saveDay({ day: "2026-10-31", content: doc("phone"), plainText: "" });
    expect((await syncOnce(phone, folder, phoneMemory)).imported).toBe(0);
    expect(reads).toEqual([]);

    // The Mac's next edit is one new small file; the phone reads just that.
    at("2026-10-30T09:00:00Z");
    await mac.saveDay({ day: "2026-10-30", content: doc("mac again"), plainText: "" });
    await syncOnce(mac, folder);
    reads.length = 0;
    await syncOnce(phone, folder, phoneMemory);
    expect(reads).toHaveLength(1);
    expect((await phone.getDay("2026-10-30"))?.content).toEqual(doc("mac again"));
  });
});

describe("direct Wi-Fi link and Drive together", () => {
  it("an edit that arrives by Wi-Fi and then again by Drive is applied once", async () => {
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");
    await phone.saveDay({ day: "2026-11-01", content: doc("typed on the phone"), plainText: "" });
    // The Wi-Fi link sends what the phone hasn't sent yet...
    const sent = new Set<string>();
    const records = await phone.syncRecords(sent);
    expect((await importRecords(mac, records)).events.length).toBe(records.length);
    expect((await mac.getDay("2026-11-01"))?.content).toEqual(doc("typed on the phone"));
    const events = (await mac.eventsFor("day:2026-11-01")).length;
    // ...then the same edit comes by Drive, and once more by Wi-Fi: nothing changes.
    await syncOnce(phone, folder);
    expect((await syncOnce(mac, folder)).imported).toBe(0);
    expect((await importRecords(mac, records)).events.length).toBe(0);
    expect((await mac.eventsFor("day:2026-11-01")).length).toBe(events);
    expect((await mac.getDay("2026-11-01"))?.content).toEqual(doc("typed on the phone"));
    expect(await phone.ownEventIds()).toEqual(records.map((r) => r.event.id));
  });
});
