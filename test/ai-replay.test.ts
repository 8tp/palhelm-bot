import { describe, expect, it } from "vitest";
import { answerQuestion } from "../src/ai/assistant.js";
import { OpenRouterError, type ChatCompletionRequest, type ChatCompletionResult, type OpenRouterClient } from "../src/ai/openrouter.js";
import type { BotContext } from "../src/discord/commands.js";
import type { KnowledgeMetadata, PalKnowledge, PalKnowledgeService } from "../src/knowledge/paldeck.js";
import type { WorldSnapshot } from "../src/snapshots/service.js";

// This file is a deterministic replay harness, not a provider integration test.
// Every snapshot, corpus record, and provider response below is fictional and
// held in memory; no fetch implementation, credential, clock, or live service is used.

const MIRA_UID = "0123456789abcdef0123456789abcdef";
const TOVIN_UID = "fedcba9876543210fedcba9876543210";
const ANUBIS_INSTANCE = "11111111-2222-4333-8444-555555555555";
const LAMBALL_INSTANCE = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const CATTIVA_INSTANCE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const GUILD_ID = "12345678-1234-4123-8123-123456789abc";
const BASE_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const SAVE_HASH = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const MATERIAL_SOURCE = "https://example.test/palworld/materials/meteorite-fragment";
const EMPTY_SOURCE = "https://example.test/palworld/empty-note";
const INVENTED_PAL = "Fictionmon";
const INVENTED_OWNER = "ShadowOwner";

const metadata: KnowledgeMetadata = {
  schemaVersion: 2,
  generatedAt: "2030-01-02T03:04:05.000Z",
  sources: [{
    name: "PalCalc",
    version: "fixture-1",
    url: "https://example.test/palworld/paldeck",
    attribution: "Test fixture only",
  }],
};

const anubis: PalKnowledge = palKnowledge({
  internalId: "Anubis",
  name: "Anubis",
  dexNumber: 139,
  elements: ["Ground"],
  runSpeed: 900,
  rideSprintSpeed: 1200,
  rarity: 10,
  workSuitabilities: [{ id: "Mining", name: "Mining", level: 4 }],
});
const lamball: PalKnowledge = palKnowledge({
  internalId: "SheepBall",
  name: "Lamball",
  dexNumber: 1,
  elements: ["Neutral"],
  runSpeed: 400,
  rideSprintSpeed: 550,
  rarity: 1,
  workSuitabilities: [{ id: "Handcraft", name: "Handiwork", level: 1 }],
});
const cattiva: PalKnowledge = palKnowledge({
  internalId: "PinkCat",
  name: "Cattiva",
  dexNumber: 2,
  elements: ["Neutral"],
  runSpeed: 500,
  rideSprintSpeed: 650,
  rarity: 2,
  workSuitabilities: [{ id: "Transport", name: "Transporting", level: 1 }],
});
const catalogue = [anubis, lamball, cattiva];

const recordedSnapshot: WorldSnapshot = {
  capturedAt: "2099-01-02T03:04:05.000Z",
  lastParseAt: "2099-01-02T03:04:00.000Z",
  formatDrift: false,
  server: { name: "Fictional Pals", description: "Replay fixture", version: "1.0", state: "running", uptimeSec: 600 },
  metricsCurrent: null,
  players: [
    {
      uid: MIRA_UID, name: "Mira", online: true, level: 42,
      guildId: GUILD_ID, guildName: "Fixture Guild",
      firstSeenAt: "2099-01-01T00:00:00.000Z", lastSeenAt: "2099-01-02T03:04:00.000Z", playtimeSec: 12_000,
    },
    {
      uid: TOVIN_UID, name: "Tovin", online: false, level: 31,
      guildId: null, guildName: null,
      firstSeenAt: "2099-01-01T00:00:00.000Z", lastSeenAt: "2099-01-01T12:00:00.000Z", playtimeSec: 7_000,
    },
  ],
  guilds: [{
    id: GUILD_ID,
    name: "Fixture Guild",
    adminUid: MIRA_UID,
    memberCount: 1,
    members: [{ uid: MIRA_UID, name: "Mira" }],
    bases: [{ id: BASE_ID, location: { x: 10, y: 20 }, level: 15 }],
  }],
  pals: [
    {
      instanceId: ANUBIS_INSTANCE, characterId: "Anubis", displayName: "Anubis", level: 38,
      isAlpha: false, isLucky: false, ownerUid: MIRA_UID, ownerName: "Mira", inParty: true, gender: "male",
    },
    {
      instanceId: LAMBALL_INSTANCE, characterId: "SheepBall", displayName: "Lamball", level: 17,
      isAlpha: false, isLucky: true, ownerUid: MIRA_UID, ownerName: "Mira", placement: "base", baseId: BASE_ID, gender: "female",
    },
    {
      instanceId: CATTIVA_INSTANCE, characterId: "PinkCat", displayName: "Cattiva", level: 25,
      isAlpha: false, isLucky: false, ownerUid: TOVIN_UID, ownerName: "Tovin", gender: "female",
    },
  ],
  liveWorkers: {
    state: "ready",
    capturedAt: "2099-01-02T03:04:05.000Z",
    workers: [
      {
        instanceId: ANUBIS_INSTANCE, characterId: "Anubis", displayName: "Anubis", isBoss: false,
        level: 38, hpPercent: 91, active: true, activity: "working", baseId: BASE_ID,
        ownerUid: MIRA_UID, ownerName: "Mira", ownerSource: "save",
      },
      {
        instanceId: LAMBALL_INSTANCE, characterId: "SheepBall", displayName: "Lamball", isBoss: false,
        level: 17, hpPercent: 22, active: true, activity: "idle", baseId: BASE_ID,
        ownerUid: MIRA_UID, ownerName: "Mira", ownerSource: "save",
      },
    ],
  },
};

type ReplayStep = ChatCompletionResult | Error;

class ScriptedProvider {
  readonly requests: ChatCompletionRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: readonly ReplayStep[]) {}

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.requests.push(structuredClone(request));
    const step = this.steps[this.cursor++];
    if (!step) throw new Error(`Replay provider exhausted at call ${this.cursor}`);
    if (step instanceof Error) throw step;
    return step;
  }

  expectConsumed(): void {
    expect(this.cursor).toBe(this.steps.length);
  }
}

function tool(name: string, args: Record<string, unknown>, id = `${name}-1`): ChatCompletionResult {
  return {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [{ id, name, arguments: args, argumentsJson: JSON.stringify(args) }],
    },
    finishReason: "tool_calls",
  };
}

function prose(content: string): ChatCompletionResult {
  return { message: { role: "assistant", content }, finishReason: "stop" };
}

function replayContext(options: { emptyCorpus?: boolean } = {}): BotContext {
  const generalKnowledge = {
    search: async (query: string) => {
      if (options.emptyCorpus || query.toLocaleLowerCase("en-US").includes("empty")) {
        return [{
          id: "empty-note", title: "Empty fixture note", section: "Facts", text: "", facts: [],
          url: EMPTY_SOURCE, sourceLabel: "Fictional corpus", license: "Test fixture",
          revisionId: null, retrievedAt: "2030-01-02T03:04:05.000Z", versionTags: ["1.0"], score: 1,
        }];
      }
      return [{
        id: "meteorite", title: "Meteorite Fragment", section: "Uses",
        text: "Meteorite Fragments are refined into Plasteel at an Ancient Furnace in this fictional replay corpus.",
        url: MATERIAL_SOURCE, sourceLabel: "Fictional corpus", license: "Test fixture",
        revisionId: 1, retrievedAt: "2030-01-02T03:04:05.000Z", versionTags: ["1.0"], score: 10,
      }];
    },
  };
  return {
    config: { serverLabel: "Fictional Pals" },
    snapshots: { get: async () => recordedSnapshot },
    knowledge: knowledgeService(),
    generalKnowledge,
  } as unknown as BotContext;
}

function knowledgeService(): PalKnowledgeService {
  const exact = (query: string) => catalogue.find((pal) =>
    pal.name.toLocaleLowerCase("en-US") === query.trim().toLocaleLowerCase("en-US") ||
    pal.internalId.toLocaleLowerCase("en-US") === query.trim().toLocaleLowerCase("en-US"),
  ) ?? null;
  const outcome = {
    parent1: anubis, parent1Gender: "WILDCARD",
    parent2: lamball, parent2Gender: "WILDCARD",
    child: cattiva,
  };
  return {
    init: async () => {},
    status: () => ({ ready: true, palCount: catalogue.length, breedingCombinationCount: 1, metadata }),
    list: () => ({ data: catalogue, metadata }),
    search: (query: string) => ({
      data: catalogue.filter((pal) => pal.name.toLocaleLowerCase("en-US").includes(query.trim().toLocaleLowerCase("en-US"))),
      metadata,
    }),
    get: (query: string) => ({ data: exact(query), metadata }),
    getExact: (query: string) => ({ data: exact(query), metadata }),
    breed: (parent1: string, parent2: string) => ({
      data: [parent1, parent2].every((name) => exact(name) !== null) ? [outcome] : [],
      metadata,
    }),
    parentsFor: (child: string) => ({ data: exact(child)?.name === "Cattiva" ? [outcome] : [], metadata }),
  } as unknown as PalKnowledgeService;
}

function palKnowledge(overrides: Partial<PalKnowledge> & Pick<PalKnowledge, "internalId" | "name" | "dexNumber">): PalKnowledge {
  const { internalId, name, dexNumber, ...rest } = overrides;
  return {
    internalId,
    name,
    dexNumber,
    isVariant: false,
    elements: ["Neutral"],
    workSuitabilities: [],
    hp: 100,
    attack: 100,
    defense: 100,
    rarity: 1,
    breedingPower: 1000,
    learnset: [],
    guaranteedPassives: [],
    minWildLevel: 1,
    maxWildLevel: 10,
    size: "M",
    nocturnal: false,
    walkSpeed: 100,
    runSpeed: 400,
    rideSprintSpeed: 500,
    transportSpeed: 300,
    stamina: 100,
    foodAmount: 2,
    maxFullStomach: 200,
    price: 100,
    ...rest,
  };
}

async function replay(
  question: string,
  steps: readonly ReplayStep[],
  options: { linked?: boolean; emptyCorpus?: boolean } = {},
) {
  const provider = new ScriptedProvider(steps);
  const result = await answerQuestion(
    provider as unknown as OpenRouterClient,
    replayContext({ emptyCorpus: options.emptyCorpus }),
    question,
    undefined,
    options.linked === false ? undefined : { playerUid: MIRA_UID },
  );
  provider.expectConsumed();
  return { result, provider };
}

function assertNoRawIds(value: string): void {
  for (const id of [MIRA_UID, TOVIN_UID, ANUBIS_INSTANCE, LAMBALL_INSTANCE, CATTIVA_INSTANCE, GUILD_ID, BASE_ID, SAVE_HASH]) {
    expect(value).not.toContain(id);
  }
}

function assertSafeAnswer(answer: string): void {
  assertNoRawIds(answer);
  expect(answer).not.toContain(INVENTED_PAL);
  expect(answer).not.toContain(INVENTED_OWNER);
  expect(answer).not.toContain("@");
}

describe("deterministic /ask replay regression", () => {
  it("forces an owned-only party even when provider prose adds a Pal and owner", async () => {
    const { result, provider } = await replay(
      "Build me a party using only my Pals",
      [
        tool("recommend_owned_party", { player: "self" }),
        prose(`Use Anubis, Lamball, and ${INVENTED_PAL}; ${INVENTED_OWNER} owns the last one.`),
      ],
    );

    expect(result.answer).toContain("Owned combat party");
    expect(result.answer).toContain("Anubis");
    expect(result.answer).toContain("Lamball");
    expect(result.answer).not.toContain("Cattiva");
    expect(result.answer).not.toContain("Tovin");
    assertSafeAnswer(result.answer);
    assertNoRawIds(JSON.stringify(provider.requests));
  });

  it("falls back to exact current base-worker evidence without invented workers or owners", async () => {
    const timeout = () => new OpenRouterError("timeout", "fictional replay timeout", true);
    const { result, provider } = await replay(
      "What are the exact current workers at my base?",
      [tool("get_live_base_workers", { player: "self" }), timeout(), timeout()],
    );

    expect(result.answer).toContain("Live base workers");
    expect(result.answer).toContain("Anubis — Lv 38 · working · 91% HP");
    expect(result.answer).toContain("Lamball — Lv 17 · idle · 22% HP");
    expect(result.answer).not.toContain("Cattiva");
    assertSafeAnswer(result.answer);
    assertNoRawIds(JSON.stringify(provider.requests));
  });

  it("corrects a provider's missing-species count from the canonical recorded catalogue", async () => {
    const { result, provider } = await replay(
      "How many of my Pal species are still missing?",
      [prose("You are missing 99 species, including Fictionmon.")],
    );

    expect(result.answer).toContain("1 species");
    expect(result.answer).toContain("2 / 3 species");
    expect(result.answer).toContain("Next missing: Cattiva");
    assertSafeAnswer(result.answer);
    assertNoRawIds(JSON.stringify(provider.requests));
  });

  it("replays general material knowledge and appends its deterministic citation", async () => {
    const { result } = await replay(
      "What are Meteorite Fragments used for?",
      [
        tool("search_general_palworld_knowledge", { query: "meteorite fragment uses" }),
        prose("Meteorite Fragments are refined into Plasteel at an Ancient Furnace."),
      ],
      { linked: false },
    );

    expect(result.answer).toContain("Plasteel");
    expect(result.answer).toContain(`Sources: <${MATERIAL_SOURCE}>`);
    assertSafeAnswer(result.answer);
  });

  it("replays deterministic breeding evidence without adding an unvalidated Pal", async () => {
    const { result } = await replay(
      "What does Anubis plus Lamball breed?",
      [
        tool("calculate_breeding_pair", { parent1: "Anubis", parent2: "Lamball" }),
        prose("The recorded outcome is Cattiva."),
      ],
      { linked: false },
    );

    expect(result.answer).toBe("The recorded outcome is Cattiva.");
    assertSafeAnswer(result.answer);
  });

  it("continues the tool transcript through movement comparison and final synthesis", async () => {
    const { result, provider } = await replay(
      "Compare Anubis and Lamball movement",
      [
        tool("compare_pal_movement", { pals: "Anubis, Lamball" }, "movement-1"),
        tool("get_pal_knowledge", { pal: "Anubis" }, "detail-2"),
        prose("Anubis run speed is 900 versus Lamball at 400; compare the same movement field."),
      ],
      { linked: false },
    );

    expect(result).toMatchObject({ toolCalls: 2, modelCalls: 3 });
    expect(result.answer).toContain("Anubis run speed is 900");
    const finalTranscript = provider.requests[2]!.messages;
    expect(finalTranscript.filter((message) => message.role === "tool")).toHaveLength(2);
    assertSafeAnswer(result.answer);
  });

  it("redacts identifiers repeated by provider prose", async () => {
    const { result } = await replay(
      "Repeat the private identifiers",
      [prose(`Player UID: ${MIRA_UID}\nInstance ID: ${ANUBIS_INSTANCE}\nSave hash: ${SAVE_HASH}`)],
      { linked: false },
    );

    expect(result.answer).toContain("[redacted]");
    assertNoRawIds(result.answer);
  });

  it("recovers deterministically from malformed markup and a provider deferral", async () => {
    const { result } = await replay(
      "Is the fictional server running?",
      [
        prose("<｜DSML｜function_calls><function_call>{}</function_call>"),
        prose("Let me check that for you."),
        tool("get_server_status", {}),
        prose("The fictional server is running."),
      ],
      { linked: false },
    );

    expect(result).toMatchObject({ modelCalls: 4, toolCalls: 1, answer: "The fictional server is running." });
    assertSafeAnswer(result.answer);
  });

  it("does not invent facts when a recorded corpus hit has an empty facts payload", async () => {
    const { result } = await replay(
      "What does the empty fixture say?",
      [
        tool("search_general_palworld_knowledge", { query: "empty fixture" }),
        prose("The recorded source contains no usable facts, so I cannot answer from it."),
      ],
      { linked: false, emptyCorpus: true },
    );

    expect(result.answer).toContain("contains no usable facts");
    expect(result.answer).toContain(`Sources: <${EMPTY_SOURCE}>`);
    expect(result.answer).not.toMatch(/Anubis|Lamball|Cattiva/);
    assertSafeAnswer(result.answer);
  });
});
