import "dotenv/config";
import { performance } from "node:perf_hooks";
import { answerQuestion } from "../src/ai/assistant.js";
import { OpenRouterClient, type ChatCompletionRequest, type ChatCompletionResult } from "../src/ai/openrouter.js";
import { KnowledgeCorpus } from "../src/knowledge/corpus.js";

const requestedModelIndex = process.argv.indexOf("--model");
const requestedModel = requestedModelIndex >= 0 ? process.argv[requestedModelIndex + 1]?.trim() : "";
const models = requestedModel
  ? [requestedModel]
  : ["qwen/qwen-plus", "openai/gpt-oss-120b:exacto"];
const questions = [
  { question: "How do I obtain Flame Organs?", required: [["flambelle", "kelpsea ignis"], ["fire pal"]] },
  { question: "How do I revive an incapacitated Pal?", required: [["palbox", "reviv"], ["injur", "incapacitated"]] },
  { question: "What do I need to automate Refined Ingots?", required: [["ore"], ["coal"], ["furnace"]] },
  { question: "Where do I spend Dog Coins?", required: [["medal merchant", "merchant"]] },
] as const;
const startIndex = Math.max(0, Number(process.argv[process.argv.indexOf("--start") + 1] ?? 1) - 1 || 0);
const limitValue = Math.max(1, Number(process.argv[process.argv.indexOf("--limit") + 1] ?? questions.length) || questions.length);
const selectedQuestions = questions.map((item, index) => ({ item, index })).slice(startIndex, startIndex + limitValue);

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
const corpusPath = process.env.BOT_DATA_DIR
  ? `${process.env.BOT_DATA_DIR.replace(/\/$/, "")}/general-knowledge-corpus.json`
  : "data/general-knowledge-corpus.json";
const generalKnowledge = new KnowledgeCorpus(corpusPath);
await generalKnowledge.init();

for (const model of models) {
  const usage = { prompt: 0, completion: 0, reasoning: 0, cost: 0, calls: 0 };
  const base = new OpenRouterClient({ apiKey, model, timeoutMs: 120_000, maxTokens: 800, maxRetries: 0 });
  const tracked = {
    async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      const result = await base.complete(request);
      usage.calls++;
      usage.prompt += result.usage?.promptTokens ?? 0;
      usage.completion += result.usage?.completionTokens ?? 0;
      usage.reasoning += result.usage?.reasoningTokens ?? 0;
      usage.cost += result.usage?.costUsd ?? 0;
      return result;
    },
  } as OpenRouterClient;

  let passed = 0;
  let totalLatencyMs = 0;
  let completed = 0;
  for (const { item, index } of selectedQuestions) {
    const started = performance.now();
    const costBefore = usage.cost;
    const promptBefore = usage.prompt;
    const completionBefore = usage.completion;
    try {
      const result = await answerQuestion(
        tracked,
        { generalKnowledge, webSearch: null, config: { serverLabel: "the server" } } as never,
        item.question,
      );
      const latencyMs = Math.round(performance.now() - started);
      totalLatencyMs += latencyMs;
      completed++;
      const normalized = result.answer.toLocaleLowerCase("en-US");
      const termsPass = item.required.every((alternatives) => alternatives.some((term) => normalized.includes(term)));
      const clean = !/(?:dsml|tool_call|function_call|<think>|internal response|did not finish)/i.test(result.answer);
      const grounded = result.toolCalls > 0;
      const pass = termsPass && clean && grounded;
      if (pass) passed++;
      console.log(`${model} q${index + 1} ${pass ? "PASS" : "FAIL"} latency_ms=${latencyMs} model_calls=${result.modelCalls} tool_calls=${result.toolCalls} clean=${clean} terms=${termsPass} prompt_tokens=${usage.prompt - promptBefore} completion_tokens=${usage.completion - completionBefore} cost_usd=${(usage.cost - costBefore).toFixed(8)}`);
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      totalLatencyMs += latencyMs;
      const safeCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "assistant_error";
      const safeStatus = error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? ` status=${error.status}`
        : "";
      const safeName = error instanceof Error ? error.name : typeof error;
      const localDetail = error instanceof TypeError ? ` detail=${JSON.stringify(error.message)}` : "";
      console.log(`${model} q${index + 1} ERROR code=${safeCode}${safeStatus} type=${safeName}${localDetail} latency_ms=${latencyMs}`);
    }
  }
  const averageCost = completed > 0 ? usage.cost / completed : 0;
  console.log(JSON.stringify({
    model,
    passed,
    questions: selectedQuestions.length,
    completed,
    providerCalls: usage.calls,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    reasoningTokens: usage.reasoning,
    measuredCostUsd: Number(usage.cost.toFixed(8)),
    averageCostPerCompletedQueryUsd: Number(averageCost.toFixed(8)),
    averageLatencyMs: completed > 0 ? Math.round(totalLatencyMs / completed) : null,
    projectedDaily30Usd: Number((averageCost * 30).toFixed(4)),
    projectedDaily50Usd: Number((averageCost * 50).toFixed(4)),
    projectedMonthly30PerDayUsd: Number((averageCost * 30 * 30).toFixed(2)),
    projectedMonthly50PerDayUsd: Number((averageCost * 50 * 30).toFixed(2)),
  }));
}
