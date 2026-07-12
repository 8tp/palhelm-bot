import { describe, expect, it, vi } from "vitest";
import { progressCommand } from "../src/commands/progress.js";

function harness(player: Record<string, unknown>) {
  const editReply = vi.fn();
  return {
    editReply,
    interaction: {
      deferReply: vi.fn(),
      editReply,
      options: { getString: () => "player-1" },
    },
    ctx: { integration: { players: vi.fn().mockResolvedValue({ data: [player] }) } },
  };
}

describe("/progress", () => {
  it("renders authoritative lifetime counters and distinguishes Paldeck unlocks", async () => {
    const h = harness({
      uid: "player-1", name: "Hunter", level: 42, playtimeSec: 7_200,
      captureTotal: 123, uniquePalsCaptured: 37, paldeckUnlocked: 51,
    });
    await progressCommand.execute(h.interaction as never, h.ctx as never);
    const embed = h.editReply.mock.calls[0]![0].embeds[0].toJSON();
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Lifetime captures", value: "123" }),
      expect.objectContaining({ name: "Species caught", value: "37" }),
      expect.objectContaining({ name: "Paldeck unlocked", value: "51" }),
    ]));
    expect(embed.footer.text).toContain("not the same as species caught");
  });

  it("says unavailable instead of inventing zero for an older panel", async () => {
    const h = harness({ uid: "player-1", name: "Hunter", level: 42, playtimeSec: 0 });
    await progressCommand.execute(h.interaction as never, h.ctx as never);
    const embed = h.editReply.mock.calls[0]![0].embeds[0].toJSON();
    expect(embed.description).toContain("unavailable");
    expect(embed.fields.filter((field: { value: string }) => field.value === "Unavailable")).toHaveLength(3);
  });
});
