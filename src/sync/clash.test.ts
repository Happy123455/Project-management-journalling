import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store/memoryStore";
import { MemoryFolder, syncOnce } from "./engine";
import { clashOf, mergeDocs, setSideNames, takeMergeNotes } from "./merge";

const line = (lid: string, text: string, clash?: string) => ({ type: "paragraph", attrs: { lid, ...(clash ? { clash } : {}) }, content: [{ type: "text", text }] });
const doc = (...content: object[]) => ({ type: "doc", content });

describe("sync clashes", () => {
  afterEach(() => {
    vi.useRealTimers();
    setSideNames("This device", "Other device");
  });

  it("the same line changed on both devices: both kept, marked by device, the same on both devices", () => {
    const base = doc(line("a", "The movie was"));
    const phone = doc(line("a", "This Movie is So Good"));
    const mac = doc(line("a", "Watched it twice already"));
    // On the phone, the Mac's version arrives (newer = theirs).
    setSideNames("Phone", "Mac");
    const onPhone = mergeDocs(mac, phone, base, false);
    expect(takeMergeNotes().map((n) => n.kind)).toEqual(["clash"]);
    // On the Mac, the phone's version arrives.
    setSideNames("Mac", "Phone");
    const onMac = mergeDocs(phone, mac, base, false);
    expect(onPhone).toEqual(onMac);
    expect(onMac.content!.map((n) => clashOf(n)?.side)).toEqual(["Mac", "Phone"]);
    expect(onMac.content!.map((n) => n.attrs!.lid)).toEqual(["a", "a~Phone"]);
    // Merging the result again (the other device's copy) adds nothing.
    expect(mergeDocs(onMac, mac, base, false)).toEqual(onMac);
    expect(mergeDocs(onPhone, onMac, base, true)).toEqual(onMac);
  });

  it("further typing on one side of a clash stays one line", () => {
    setSideNames("Mac", "Phone");
    const base = doc(line("a", "x"));
    const first = mergeDocs(doc(line("a", "phone text")), doc(line("a", "mac text")), base, false);
    // The phone keeps typing in its line (it now has the id a~Phone after the merge on its side).
    const phoneLater = doc(line("a", "mac text", "a|Mac"), line("a~Phone", "phone text more", "a|Phone"));
    const merged = mergeDocs(phoneLater, first, first, false);
    expect(merged.content!.map((n) => n.content![0].text)).toEqual(["mac text", "phone text more"]);
  });

  it("choosing a side removes the other line on both devices", () => {
    setSideNames("Mac", "Phone");
    const pair = mergeDocs(doc(line("a", "phone text")), doc(line("a", "mac text")), doc(line("a", "x")), false);
    // Hapi keeps the phone's line on the Mac.
    const chosen = doc(line("a~Phone", "phone text"));
    expect(mergeDocs(chosen, pair, pair, true)).toEqual(chosen);
    expect(mergeDocs(pair, chosen, pair, false)).toEqual(chosen);
  });
});

describe("small changes over the cloud", () => {
  afterEach(() => vi.useRealTimers());

  it("a later file points at the note sent before instead of carrying it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const folder = new MemoryFolder();
    const phone = new MemoryStore(undefined, "phone");
    const mac = new MemoryStore(undefined, "mac");
    const long = Array.from({ length: 60 }, (_, i) => line(`l${i}`, `a fairly long line of journal text number ${i}`));
    vi.setSystemTime(new Date("2026-11-09T08:00:00Z"));
    await phone.saveDay({ day: "2026-11-09", content: doc(...long), plainText: "" });
    await syncOnce(phone, folder);
    await syncOnce(mac, folder);
    vi.setSystemTime(new Date("2026-11-09T08:01:00Z"));
    await phone.saveDay({ day: "2026-11-09", content: doc(...long, line("new", "This Movie is So Good")), plainText: "" });
    await syncOnce(phone, folder);
    const files = [...folder.files.keys()].filter((k) => k.startsWith("events/phone/")).sort();
    const second = folder.files.get(files[files.length - 1])!;
    expect(second.length).toBeLessThan(1500);
    await syncOnce(mac, folder);
    expect((await mac.getDay("2026-11-09"))?.content.content).toHaveLength(61);
  });
});
