import { describe, expect, it } from "vitest";
import { FENCE_RE } from "./codeBlock";

describe("FENCE_RE", () => {
  it("matches a bare fence or a fence with a language", () => {
    expect("```".match(FENCE_RE)?.[1]).toBe("");
    expect("```ts".match(FENCE_RE)?.[1]).toBe("ts");
    expect("```c++".match(FENCE_RE)?.[1]).toBe("c++");
  });

  it("ignores fences with other text on the line", () => {
    expect(FENCE_RE.test("see ```")).toBe(false);
    expect(FENCE_RE.test("```js and more")).toBe(false);
  });
});
