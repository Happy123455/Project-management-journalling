import { describe, expect, it } from "vitest";
import { inspirationItems } from "./inspiration";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const from = (where: string) => ({ type: "paragraph", attrs: { info: { From: where } }, content: [] });

describe("inspirationItems", () => {
  it("makes one card per saved item, split by the From lines", () => {
    const doc = { type: "doc", content: [p("quote one"), from("28 Oct"), p("idea"), p("more"), from("29 Oct"), { type: "paragraph" }, p("loose")] };
    expect(inspirationItems(doc).map((item) => item.length)).toEqual([1, 2, 1]);
  });
});
