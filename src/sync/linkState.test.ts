// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { linkReason, linkState, setLink } from "./linkState";
import { anomalies, clearAnomalies } from "./anomalies";

describe("Wi-Fi link state", () => {
  it("says why the link is down, in words", () => {
    expect(linkReason(new Error("HTTP 403"), "Mac")).toMatch(/didn't accept this device's key/);
    expect(linkReason(new DOMException("signal timed out", "TimeoutError"), "Mac", "192.168.1.5")).toMatch(/didn't answer in time at 192.168.1.5/);
    expect(linkReason(new Error("error sending request: connection refused"), "Mac", "192.168.1.5")).toMatch(/can't reach your Mac at 192.168.1.5/);
  });

  it("logs each change once, with the reason, and not every retry", () => {
    clearAnomalies();
    setLink({ state: "trying", reason: "looking" });
    setLink({ state: "down", reason: "timed out", ip: "10.0.0.2" });
    setLink({ state: "down", reason: "timed out", ip: "10.0.0.2" });
    setLink({ state: "up", ip: "10.0.0.2", rttMs: 41 });
    const log = anomalies().filter((a) => a.kind === "link");
    expect(log.map((a) => a.text)).toEqual(["Wi-Fi link up (10.0.0.2), answered in 41 ms", "Wi-Fi link down: timed out"]);
    expect(linkState().state).toBe("up");
  });
});
