import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeCorpus, type KnowledgeCorpusFile } from "../src/knowledge/corpus.js";

async function corpusWith(documents: KnowledgeCorpusFile["documents"]): Promise<KnowledgeCorpus> {
  const directory = await mkdtemp(join(tmpdir(), "palhelm-corpus-"));
  const path = join(directory, "corpus.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-07-12T00:00:00Z", documents }));
  return new KnowledgeCorpus(path);
}

function document(id: string, title: string, section: string, text: string) {
  return {
    id,
    title,
    section,
    text,
    url: `https://example.test/wiki/${id}`,
    sourceLabel: "Test Wiki",
    license: "CC BY-SA 4.0",
    revisionId: 123,
    retrievedAt: "2026-07-12T00:00:00Z",
    versionTags: [] as string[],
  };
}

describe("KnowledgeCorpus", () => {
  it("ranks a matching section and preserves its provenance", async () => {
    const corpus = await corpusWith([
      document("refined", "Refined Ingot", "Production", "Use ore and coal in an Improved Furnace with a Kindling Pal."),
      document("cake", "Cake", "Cooking", "Cake is cooked at a cooking station."),
    ]);
    const matches = await corpus.search("how do I automate refined ingots");
    expect(matches[0]).toMatchObject({ id: "refined", title: "Refined Ingot", revisionId: 123 });
    expect(matches[0]!.url).toContain("/refined");
  });

  it("degrades safely when the optional corpus is absent", async () => {
    const corpus = new KnowledgeCorpus(join(tmpdir(), `missing-${Date.now()}.json`));
    await expect(corpus.search("meteorite")).resolves.toEqual([]);
    expect(corpus.status()).toMatchObject({ available: false, documentCount: 0 });
  });

  it("bounds results and orders ties deterministically", async () => {
    const corpus = await corpusWith(Array.from({ length: 10 }, (_, index) =>
      document(String(index), `Guide ${String(index).padStart(2, "0")}`, "Ore", "ore mining location")));
    const matches = await corpus.search("ore", 3);
    expect(matches).toHaveLength(3);
    expect(matches.map((match) => match.title)).toEqual(["Guide 00", "Guide 01", "Guide 02"]);
  });

  it("keeps history searchable without letting it dominate current answers", async () => {
    const corpus = await corpusWith([
      document("old", "Refined Ingot", "History", "Refined ingot refined ingot old removed recipe."),
      document("current", "Refined Ingot", "Overview", "Refined ingots use ore and coal in an Improved Furnace."),
    ]);
    expect((await corpus.search("refined ingot recipe"))[0]?.id).toBe("current");
    expect((await corpus.search("refined ingot history"))[0]?.id).toBe("old");
  });

  it("prefers a title match over prose that merely mentions every query term", async () => {
    const corpus = await corpusWith([
      document("ranch", "Ranch", "Function", "Compatible Pals graze and periodically drop items."),
      document("other", "Pal Condensation", "Farming", "Some Pals produce more items at a Ranch after condensation."),
    ]);
    expect((await corpus.search("Which Pals produce items at a Ranch?"))[0]?.id).toBe("ranch");
  });
});
