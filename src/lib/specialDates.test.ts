import { describe, expect, it } from "vitest";
import { easter, festivalsOn, parseSpecialLine, parseSpecialPage, specialsOn } from "./specialDates";

describe("special dates", () => {
  it("festivals from the table", () => {
    expect(festivalsOn("2026-11-08").map((f) => f.kind)).toEqual(["diwali"]);
    expect(festivalsOn("2027-03-22").map((f) => f.kind)).toEqual(["holi"]);
    expect(festivalsOn("2027-01-14").map((f) => f.title)).toEqual(["Uttarayan", "Lohri"]);
    expect(festivalsOn("2030-01-01").map((f) => f.kind)).toEqual(["newyear"]);
    expect(festivalsOn("2026-11-09")).toEqual([]);
  });

  it("the bigger list: fixed days, moon tables, worked-out days", () => {
    const titles = (d: string) => festivalsOn(d).map((f) => f.title);
    expect(titles("2026-12-25")).toEqual(["Christmas"]);
    expect(festivalsOn("2026-12-25")[0]).toMatchObject({ kind: "christmas", short: "Xmas", school: true, group: "world" });
    expect(titles("2026-12-24")).toEqual(["Christmas Eve"]);
    expect(titles("2027-01-26")).toEqual(["Republic Day"]);
    expect(titles("2026-11-10")).toEqual(["Bestu Varas"]);
    expect(titles("2026-11-24")).toEqual(["Dev Diwali", "Guru Nanak Jayanti"]);
    expect(titles("2027-08-15")).toEqual(["Independence Day", "Parsi New Year", "Milad-un-Nabi"]);
    expect(titles("2027-09-04")).toEqual(["Ganesh Chaturthi"]);
    expect(titles("2028-01-26")).toEqual(["Republic Day", "Lunar New Year"]);
    expect(festivalsOn("2026-03-21")[0]).toMatchObject({ title: "Eid ul-Fitr", approx: true, kind: "moon" });
    // Navratri: every night up to Dussehra.
    expect(titles("2026-10-11")).toContain("Navratri");
    expect(titles("2026-10-19")).toContain("Navratri");
    expect(titles("2026-10-20")).toEqual(["Dussehra"]);
    // Easter by computus; Good Friday two days before; Thanksgiving, Mother's and Father's Day by weekday.
    expect([2026, 2027, 2028].map(easter)).toEqual(["04-05", "03-28", "04-16"]);
    expect(titles("2027-03-26")).toEqual(["Good Friday"]);
    expect(titles("2026-11-26")).toEqual(["Thanksgiving (US)"]);
    expect(titles("2027-05-09")).toEqual(["Akshaya Tritiya", "Mother's Day"]);
    expect(titles("2028-06-18")).toEqual(["Father's Day"]);
  });

  it("groups switched off leave their festivals out", () => {
    expect(festivalsOn("2026-12-25", { world: false })).toEqual([]);
    expect(festivalsOn("2026-10-31", { fun: false })).toEqual([]);
    expect(festivalsOn("2026-10-31", { india: false }).map((f) => f.title)).toEqual(["Halloween"]);
  });

  it("an own festival keeps its emoji", () => {
    const list = parseSpecialPage({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "8 Sep · Ganpati at home 🐘" }] }] });
    expect(specialsOn("2027-09-08", list)[0]).toMatchObject({ kind: "special", emoji: "🐘", short: "Ganpati" });
  });

  it("reads lines in the usual ways of writing a date", () => {
    expect(parseSpecialLine("14 Mar · Mom's birthday 🎂")).toEqual({ md: "03-14", year: undefined, kind: "birthday", title: "Mom's birthday 🎂" });
    expect(parseSpecialLine("1998-03-14 Riya bday")).toMatchObject({ md: "03-14", year: 1998, kind: "birthday" });
    expect(parseSpecialLine("Dec 2, 2020: Our anniversary")).toMatchObject({ md: "12-02", year: 2020, kind: "anniversary" });
    expect(parseSpecialLine("- 05/08 Papa birthday")).toMatchObject({ md: "08-05", kind: "birthday" });
    expect(parseSpecialLine("2 September Graduation day")).toMatchObject({ md: "09-02", kind: "special" });
    expect(parseSpecialLine("14 Marriage anniversary")).toBeNull();
    expect(parseSpecialLine("30 Feb nope")).toBeNull();
    expect(parseSpecialLine("Groceries")).toBeNull();
    expect(parseSpecialLine("14 Mar")).toBeNull();
  });

  it("personal dates every year, with years when known; 29 Feb on 28 Feb", () => {
    const list = parseSpecialPage({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "1998-03-14 Riya birthday" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "2 Dec 2020 Our anniversary" }] }] }] },
      { type: "paragraph", content: [{ type: "text", text: "29 Feb Leap friend birthday" }] },
    ] });
    expect(list).toHaveLength(3);
    expect(specialsOn("2026-03-14", list)[0]).toMatchObject({ kind: "birthday", years: 28, greeting: "Happy 28th birthday!" });
    expect(specialsOn("2026-12-02", list)[0].greeting).toBe("6 years together. Happy anniversary!");
    expect(specialsOn("2026-02-28", list)[0].kind).toBe("birthday");
    expect(specialsOn("2028-02-28", list)).toEqual([]);
    expect(specialsOn("1990-03-14", list)).toEqual([]);
  });
});
