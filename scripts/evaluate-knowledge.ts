import "dotenv/config";
import { KnowledgeCorpus } from "../src/knowledge/corpus.js";
import { OpenRouterClient } from "../src/ai/openrouter.js";

interface Case {
  id: number;
  question: string;
  expectedTitles: string[];
  expectedTerms: string[];
}

let nextCaseId = 1;
const cases: Case[] = [
  test("How do I obtain Flame Organs?", ["flame organ"], ["flambelle", "kelpsea ignis", "fire pal"]),
  test("What do I need to make Refined Ingots?", ["refined ingot"], ["ore", "coal", "improved furnace"]),
  test("What are Meteorite Fragments used for?", ["meteorite fragment"], ["meteor", "launcher", "paldium"]),
  test("Where do I spend Dog Coins?", ["dog coin"], ["medal merchant", "merchant"]),
  test("What are Ancient Civilization Cores for?", ["ancient civilization core"], ["ancient", "technology", "equipment"]),
  test("How does reviving an incapacitated Pal work?", ["afflictions", "palbox", "incapacitated"], ["palbox", "reviv", "incapacitated"]),
  test("Which Pals can produce items at a Ranch?", ["ranch"], ["ranch", "graze", "drop"]),
  test("How can I obtain High Quality Pal Oil?", ["high quality pal oil"], ["oil", "pal"]),
  test("How do I get Electric Organs?", ["electric organ"], ["electric", "pal"]),
  test("How do I get Ice Organs?", ["ice organ"], ["foxcicle", "ice pal", "ice"]),
  test("What is Polymer used for?", ["polymer"], ["polymer", "craft"]),
  test("How is Carbon Fiber made?", ["carbon fiber"], ["carbon fiber", "coal", "charcoal"]),
  test("How do I produce Pal Metal Ingots?", ["pal metal ingot"], ["pal metal", "furnace", "ore"]),
  test("Where is Sulfur commonly used?", ["sulfur"], ["gunpowder", "ammo", "sulfur"]),
  test("What do I need Coal for?", ["coal"], ["refined ingot", "carbon fiber", "coal"]),
  test("What is Crude Oil used to produce?", ["crude oil"], ["plasteel", "oil", "polymer"]),
  test("What is Pure Quartz used for?", ["pure quartz"], ["circuit", "quartz"]),
  test("How do I obtain Ancient Civilization Parts?", ["ancient civilization parts"], ["alpha", "lucky", "ancient"]),
  test("How can I earn more Technology Points?", ["technology"], ["technology point", "manual", "level"]),
  test("What affects egg incubation time?", ["egg incubation", "egg incubator", "breeding"], ["temperature", "incubat", "egg"]),
  test("What happens when a Pal's SAN gets low?", ["san", "sanity"], ["san", "work", "break"]),
  test("How do Pal injuries and medicine work?", ["afflictions", "medicine"], ["medicine", "injur", "pal"]),
  test("What are the different Pal Sphere tiers for?", ["pal sphere", "capture power", "spheres"], ["capture", "sphere"]),
  test("How do raid bosses work?", ["raid boss", "raid"], ["raid", "boss"]),
  test("What should I expect at an Oil Rig?", ["oil rig"], ["oil rig", "enemy", "loot"]),
  test("What are Pal Expeditions used for?", ["pal expedition", "expedition"], ["expedition", "reward", "pal"]),
  test("What do passive skills change on a Pal?", ["passive skill"], ["passive", "skill", "stat"]),
  test("How do elemental strengths and weaknesses work?", ["element"], ["element", "weak", "damage"]),
  test("How can I defend my base from raids?", ["raid", "base"], ["base", "raid", "defen"]),
  test("How does transporting work at a base?", ["transporting", "base", "work suitability"], ["transport", "item", "base"]),
];

const corpus = new KnowledgeCorpus(process.env.BOT_DATA_DIR
  ? `${process.env.BOT_DATA_DIR.replace(/\/$/, "")}/general-knowledge-corpus.json`
  : "data/general-knowledge-corpus.json");
await corpus.init();

const retrieval = await Promise.all(cases.map(async (entry) => {
  const matches = await corpus.search(entry.question, 4);
  const joined = matches.map((match) => `${match.title} ${match.section} ${match.text}`).join(" ").toLocaleLowerCase("en-US");
  const titlePass = matches.slice(0, 3).some((match) =>
    entry.expectedTitles.some((expected) => match.title.toLocaleLowerCase("en-US").includes(expected)));
  const termPass = entry.expectedTerms.some((term) => joined.includes(term));
  const artifactPass = !matches.slice(0, 3).some((match) => hasArtifact(match.text));
  return { entry, matches, titlePass, termPass, artifactPass };
}));

const localOnly = process.argv.includes("--local-only");
const key = process.env.OPENROUTER_API_KEY?.trim();
const model = process.env.OPENROUTER_MODEL?.trim() || "deepseek/deepseek-v4-flash";
if (!localOnly && !key) throw new Error("OPENROUTER_API_KEY is required for the single synthesis evaluation");

const evidence = retrieval.map(({ entry, matches }) => ({
  id: entry.id,
  question: entry.question,
  evidence: matches.slice(0, 2).map((match) => ({
    title: match.title,
    section: match.section,
    text: match.text.slice(0, 900),
    url: match.url,
  })),
}));
let parsed: Array<{ id: number; answer: string; source: string }> = [];
if (!localOnly) {
  const client = new OpenRouterClient({ apiKey: key!, model, timeoutMs: 120_000, maxTokens: 3_500, maxRetries: 0 });
  const completion = await client.complete({ messages: [
    {
      role: "system",
      content: "You are evaluating Palworld answers. Answer every numbered question only from its supplied evidence. Return only a JSON array of objects with keys id (number), answer (concise string), and source (one supplied URL). Do not use tools, Markdown, DSML, or facts absent from evidence. If evidence is insufficient, say that plainly in answer.",
    },
    { role: "user", content: JSON.stringify(evidence) },
  ] });
  parsed = parseAnswers(completion.message.content ?? "");
}
const answers = new Map(parsed.map((answer) => [answer.id, answer]));
let retrievalPassed = 0;
let synthesisPassed = 0;
for (const result of retrieval) {
  const localPass = result.titlePass && result.termPass && result.artifactPass;
  if (localPass) retrievalPassed++;
  const answer = answers.get(result.entry.id);
  const allowedUrls = new Set(result.matches.slice(0, 2).map((match) => match.url));
  const synthesisChecks = {
    present: Boolean(answer && answer.answer.length >= 20),
    groundedTerm: Boolean(answer && result.entry.expectedTerms.some((term) => answer.answer.toLocaleLowerCase("en-US").includes(term))),
    source: Boolean(answer && allowedUrls.has(answer.source)),
    clean: Boolean(answer && !hasArtifact(answer.answer) && !/(?:dsml|tool_call|function_call|<think>)/i.test(answer.answer)),
  };
  const synthesisPass = !localOnly && Object.values(synthesisChecks).every(Boolean);
  if (synthesisPass) synthesisPassed++;
  const top = result.matches.slice(0, 2).map((match) => match.title).join(" / ") || "none";
  const failed = [
    ...(!result.titlePass ? ["retrieval-title"] : []),
    ...(!result.termPass ? ["retrieval-facts"] : []),
    ...(!result.artifactPass ? ["template-artifact"] : []),
    ...(!localOnly ? Object.entries(synthesisChecks).filter(([, pass]) => !pass).map(([name]) => `answer-${name}`) : []),
  ];
  console.log(`${String(result.entry.id).padStart(2, "0")} ${failed.length === 0 ? "PASS" : `FAIL(${failed.join(",")})`} top=${top}`);
}
console.log(JSON.stringify({
  questions: cases.length,
  corpusSections: corpus.status().documentCount,
  retrievalPassed,
  synthesisPassed: localOnly ? null : synthesisPassed,
  parsedAnswers: localOnly ? null : parsed.length,
  providerCalls: localOnly ? 0 : 1,
  model,
}));

function test(question: string, expectedTitles: string[], expectedTerms: string[]): Case {
  return { id: nextCaseId++, question, expectedTitles, expectedTerms };
}

function hasArtifact(value: string): boolean {
  return /\{\{|<\/?(?:dsml|function_call)|\b(?:from|by)\s{2,}(?:when|and|pals?)\b|["']{2}\s*(?:when|and)/i.test(value);
}

function parseAnswers(raw: string): Array<{ id: number; answer: string; source: string }> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch { return []; }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return Number.isInteger(row.id) && typeof row.answer === "string" && typeof row.source === "string"
      ? [{ id: row.id as number, answer: row.answer, source: row.source }]
      : [];
  });
}
