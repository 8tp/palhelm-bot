import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  truncate,
} from "../src/discord/embeds.js";

describe("embed helpers", () => {
  it.each([
    [0, "<1m"],
    [59, "<1m"],
    [90_061, "1d 1h 1m"],
  ])("formats duration %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(10 * 1024 ** 3)).toBe("10.0 GiB");
  });

  it("truncates only strings over the limit", () => {
    expect(truncate("pal", 3)).toBe("pal");
    expect(truncate("palhelm", 4)).toBe("pal…");
  });
});
