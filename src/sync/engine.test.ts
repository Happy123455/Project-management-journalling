import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { MemoryFolder, syncOnce } from "./engine";

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

    // Both edit the same day; the Mac's edit is later, so both end on it.
    at("2026-10-28T10:00:00Z");
    await phone.saveDay({ day: "2026-10-28", content: doc("phone edit"), plainText: "" });
    at("2026-10-28T10:05:00Z");
    await mac.saveDay({ day: "2026-10-28", content: doc("mac edit"), plainText: "" });
    await syncOnce(mac, folder);
    await syncOnce(phone, folder);
    await syncOnce(mac, folder);
    expect((await phone.getDay("2026-10-28"))?.content).toEqual(doc("mac edit"));
    expect((await mac.getDay("2026-10-28"))?.content).toEqual(doc("mac edit"));
    // Both edits stay in both histories.
    const ops = async (s: MemoryStore) => (await s.eventsFor("day:2026-10-28")).map((e) => e.deviceId + ":" + e.op).sort();
    expect(await ops(phone)).toEqual(await ops(mac));
    expect(await ops(phone)).toEqual(["mac:update", "phone:create", "phone:update"]);

    // Syncing again changes nothing.
    expect(await syncOnce(phone, folder)).toEqual({ exported: 0, imported: 0, files: 0 });
    expect(await syncOnce(mac, folder)).toEqual({ exported: 0, imported: 0, files: 0 });
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
    expect((await mac.getDay("2026-10-28"))?.content).toEqual(doc("phone later"));
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
