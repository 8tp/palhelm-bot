import { describe, expect, it } from "vitest";
import {
  historyControlError,
  historyNavigationRow,
  historyPageRange,
  safePublicEventMessage,
} from "../src/commands/history.js";
import type { PanelEvent } from "../src/types.js";

const event = (kind: PanelEvent["kind"], message: string): PanelEvent => ({
  at: "2026-07-11T12:00:00Z",
  kind,
  message,
});

describe("public history projection", () => {
  it("allows only structurally known public player, backup, and system messages", () => {
    expect(safePublicEventMessage(event("join", "Hunter joined"), false)).toBe("Hunter joined");
    expect(safePublicEventMessage(event("leave", "Hunter left"), false)).toBe("Hunter left");
    expect(safePublicEventMessage(event("backup", "/private/path/world.tar.zst"), false)).toBe("Backup completed");
    expect(safePublicEventMessage(event("system", "Palworld REST API is reachable"), false)).toBe("Palworld REST API is reachable");
  });

  it("drops admin, malformed, unknown-system, and suppressed drift text", () => {
    expect(safePublicEventMessage(event("panel", "admin logged in from 10.0.0.1"), false)).toBeNull();
    expect(safePublicEventMessage(event("config", "password changed"), false)).toBeNull();
    expect(safePublicEventMessage(event("join", "unstructured message"), false)).toBeNull();
    expect(safePublicEventMessage(event("system", "secret operational detail"), false)).toBeNull();
    expect(safePublicEventMessage(event("system", "world save format drift detected"), true)).toBeNull();
  });

  it("paginates only after public projection and clamps page boundaries", () => {
    expect(historyPageRange(23, 1)).toEqual({ page: 1, pageCount: 3, start: 0, end: 10 });
    expect(historyPageRange(23, 2)).toEqual({ page: 2, pageCount: 3, start: 10, end: 20 });
    expect(historyPageRange(23, 99)).toEqual({ page: 3, pageCount: 3, start: 20, end: 23 });
  });

  it("rejects stale and foreign paging controls", () => {
    const ids = { previous: "history_prev:i1", next: "history_next:i1" };
    expect(historyControlError(ids, ids.next, "requester", "requester")).toBeNull();
    expect(historyControlError(ids, "history_next:old", "requester", "requester")).toContain("no longer valid");
    expect(historyControlError(ids, ids.previous, "requester", "other")).toContain("Only the person");
  });

  it("disables boundaries and every expired control", () => {
    expect(historyNavigationRow("i1", 1, 3).toJSON().components.map((button) => button.disabled)).toEqual([true, true, false]);
    expect(historyNavigationRow("i1", 3, 3).toJSON().components.map((button) => button.disabled)).toEqual([false, true, true]);
    expect(historyNavigationRow("i1", 2, 3, true).toJSON().components.every((button) => button.disabled)).toBe(true);
  });
});
