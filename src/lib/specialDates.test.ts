import { describe, expect, it } from "vitest";
import { festivalsOn, parseSpecialLine, parseSpecialPage, specialsOn } from "./specialDates";

describe("special dates", () => {
  it("festivals from the table", () => {
    expect(festivalsOn("2026-11-08").map((f) => f.kind)).toEqual(["diwali"]);
    expect(festivalsOn("2027-03-22").map((f) => f.kind)).toEqual(["holi"]);
    expect(festivalsOn("2027-01-14").map((f) => f.kind)).toEqual(["uttarayan"]);
    expect(festivalsOn("2030-01-01").map((f) => f.kind)).toEqual(["newyear"]);
    expect(festivalsOn("2026-11-09")).toEqual([]);
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
