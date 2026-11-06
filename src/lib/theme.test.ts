// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, currentTheme, DEFAULT_THEME, setTheme } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("defaults to liquid glass", () => {
    expect(currentTheme()).toBe("glass");
    expect(DEFAULT_THEME).toBe("glass");
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe("glass");
  });

  it("keeps the chosen theme and sets it on <html>", () => {
    setTheme("neu");
    expect(currentTheme()).toBe("neu");
    expect(document.documentElement.dataset.theme).toBe("neu");
  });

  it("ignores an unknown stored value", () => {
    localStorage.setItem("journal.theme", "bogus");
    expect(currentTheme()).toBe("glass");
  });
});
