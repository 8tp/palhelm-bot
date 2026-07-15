import { describe, expect, it } from "vitest";
import { presenceText } from "../src/history/runtime.js";

describe("rich presence", () => {
  it("uses the configured server identity, population, and current world day", () => {
    const snapshot = {
      players: [],
      metricsCurrent: { players: 3, maxPlayers: 16, day: 254, uptimeSec: 600 },
      server: { state: "running" },
    };
    expect(presenceText(snapshot as never, "Example Pals")).toBe("Example Pals · 3/16 online · Day 254");
  });

  it("shows a clear offline state", () => {
    const snapshot = { players: [], metricsCurrent: null, server: { state: "unreachable" } };
    expect(presenceText(snapshot as never, "Example Pals")).toBe("Example Pals · server offline");
  });
});
