import { describe, expect, it } from "vitest";
import { filterSlashItems, SLASH_ITEMS } from "./slashItems";

const ids = (query: string) => filterSlashItems(query).map((i) => i.id);

describe("filterSlashItems", () => {
  it("shows every tile before anything is typed", () => {
    expect(filterSlashItems("")).toEqual(SLASH_ITEMS);
  });

  it("matches labels anywhere, ignoring case", () => {
    expect(ids("QUO")).toEqual(["quote"]);
    expect(ids("stamp")).toEqual(["timestamp"]);
  });

  it("finds tiles by keyword, after label matches", () => {
    expect(ids("todo")).toEqual(["task", "project"]);
    expect(ids("list")).toEqual(["bullet", "numbered"]);
    expect(ids("t")[0]).toBe("task");
  });

  it("returns nothing when no tile matches", () => {
    expect(ids("zzz")).toEqual([]);
  });

  it("does not offer bold, italic or highlight", () => {
    expect(ids("bold")).toEqual([]);
    expect(ids("highlight")).toEqual([]);
  });
});
