import { describe, expect, it } from "vitest";
import { pickRecorderType, qrContent } from "./capture";

describe("capture", () => {
  it("prefers MP4, then WebM", () => {
    expect(pickRecorderType(() => true)).toBe("video/mp4;codecs=avc1,mp4a");
    expect(pickRecorderType((t) => t.startsWith("video/webm"))).toBe("video/webm;codecs=vp9,opus");
    expect(pickRecorderType(() => false)).toBe("");
  });

  it("turns scanned links into links and keeps other codes as text", () => {
    expect(qrContent(" https://example.com/x ")).toEqual({ text: "https://example.com/x", href: "https://example.com/x" });
    expect(qrContent("WIFI:S:home;;")).toEqual({ text: "WIFI:S:home;;", href: null });
  });
});
