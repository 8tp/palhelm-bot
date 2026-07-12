import { describe, expect, it } from "vitest";
import { searchGeneralKnowledge } from "../src/knowledge/general.js";
import { executeAiTool } from "../src/ai/tools.js";

describe("general Palworld knowledge corpus", () => {
  it("matches common phrasing without requiring a web request", () => {
    expect(searchGeneralKnowledge("what do I do with meteorite?")[0]?.id).toBe("meteorite-fragment");
    expect(searchGeneralKnowledge("where can I spend dog coins")[0]?.id).toBe("dog-coin");
    expect(searchGeneralKnowledge("how do I automate refined ingots?")[0]?.id).toBe("refined-ingot-automation");
    expect(searchGeneralKnowledge("unrelated sentence about a castle")).toEqual([]);
  });

  it("exposes version, attribution, source URLs, and facts through a deterministic tool", async () => {
    const result = await executeAiTool("search_general_palworld_knowledge", { query: "ancient core" }, {} as never);
    expect(result).toMatchObject({
      ok: true,
      data: {
        version: "palworld-1.0-2026-07-11",
        license: "CC BY-SA 4.0",
      },
    });
    expect((result.data as { entries: Array<{ id: string }> }).entries[0]?.id).toBe("ancient-civilization-core");
    expect(JSON.stringify(result)).toContain("https://palworld.wiki.gg/");
  });
});
