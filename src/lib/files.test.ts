import { describe, expect, it } from "vitest";
import { fileKind, formatSize, safeFileName, sha256 } from "./files";

describe("files", () => {
  it("makes names safe for disk", () => {
    expect(safeFileName("My Photo (1).JPG")).toBe("My_Photo_1_.JPG");
    expect(safeFileName("../../etc/passwd")).toBe("etc_passwd");
    expect(safeFileName("")).toBe("file");
  });

  it("formats sizes", () => {
    expect(formatSize(500)).toBe("500 B");
    expect(formatSize(12 * 1024)).toBe("12 KB");
    expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });

  it("sorts files by kind", () => {
    expect(fileKind("image/png")).toBe("image");
    expect(fileKind("video/mp4")).toBe("video");
    expect(fileKind("application/pdf")).toBe("pdf");
    expect(fileKind("text/plain")).toBe("file");
  });

  it("hashes bytes", async () => {
    expect(await sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
