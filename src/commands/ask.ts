import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../discord/commands.js";
import { answerQuestion, stageLabel } from "../ai/assistant.js";
import { OpenRouterError } from "../ai/openrouter.js";
import { baseEmbed, errorEmbed, truncate } from "../discord/embeds.js";

const MAX_CONCURRENT = 2;
let activeRequests = 0;
let usageDay = "";
let dailyRequests = 0;
const lastRequestAt = new Map<string, number>();

/** Public /ask presentation: concise provenance without internal diagnostics. */
export function buildAskAnswerEmbed(answer: string) {
  return baseEmbed("🤖 Palhelm Guide")
    .setDescription(truncate(answer, 4096))
    .setFooter({ text: "AI Generated" });
}

export const askCommand: Command = {
  helpCategory: "assistant",
  data: new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the read-only AI guide about the server")
    .addStringOption((option) =>
      option
        .setName("question")
        .setDescription("Question about the server, players, Pals, records, or collections")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(500),
    )
    .addBooleanOption((option) =>
      option
        .setName("private")
        .setDescription("Only you can see the reply (defaults to false)"),
    ),

  async execute(interaction, ctx) {
    const question = interaction.options.getString("question", true).trim();
    const privateReply = interaction.options.getBoolean("private") === true;
    const now = Date.now();
    const previous = lastRequestAt.get(interaction.user.id) ?? 0;
    const cooldownMs = ctx.config.aiCooldownSec * 1_000;

    if (!ctx.openRouter) {
      await interaction.reply({
        embeds: [errorEmbed("The AI guide is not configured yet.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (cooldownMs > 0 && now - previous < cooldownMs) {
      const remaining = Math.max(1, Math.ceil((cooldownMs - (now - previous)) / 1_000));
      await interaction.reply({
        embeds: [errorEmbed(`Please wait ${remaining}s before asking another question.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    resetDailyCounter(now);
    if (dailyRequests >= ctx.config.aiDailyRequestLimit) {
      await interaction.reply({
        embeds: [errorEmbed("The AI guide has reached today's bot-side request limit.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (activeRequests >= MAX_CONCURRENT) {
      await interaction.reply({
        embeds: [errorEmbed("The AI guide is busy with other questions—try again shortly.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (privateReply) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    else await interaction.deferReply();
    dailyRequests++;
    lastRequestAt.set(interaction.user.id, now);
    activeRequests++;
    const startedAt = performance.now();
    let stageStartedAt = startedAt;
    let activeStage = "deferred";
    const stageTimings: string[] = [];
    const finishStage = (at = performance.now()) => {
      stageTimings.push(`${activeStage}:${Math.max(0, Math.round(at - stageStartedAt))}`);
      stageStartedAt = at;
    };
    try {
      // Live status: chain edits so the final answer always lands last, and skip
      // repeats so we never spam identical frames.
      let statusChain: Promise<unknown> = Promise.resolve();
      let lastLabel = "";
      const onProgress = (stage: Parameters<typeof stageLabel>[0]) => {
        const label = stageLabel(stage);
        if (label === lastLabel) return;
        const changedAt = performance.now();
        finishStage(changedAt);
        activeStage = stage.kind === "tool" ? `tool_${stage.tool}` : stage.kind;
        lastLabel = label;
        statusChain = statusChain
          .then(() => interaction.editReply({ embeds: [baseEmbed("🤖 Palhelm Guide").setDescription(label)] }))
          .catch(() => {});
      };

      const guildId = interaction.guildId ?? ctx.config.guildId;
      const playerLink = ctx.playerLinks.get(guildId, interaction.user.id);
      const result = await answerQuestion(
        ctx.openRouter,
        ctx,
        question,
        onProgress,
        playerLink ? { playerUid: playerLink.playerUid } : undefined,
      );
      await statusChain.catch(() => {}); // let any in-flight status edit settle first
      const embed = buildAskAnswerEmbed(result.answer);
      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      finishStage();
      console.log(
        `[ai] request completed duration_ms=${Math.round(performance.now() - startedAt)} model_calls=${result.modelCalls} tool_calls=${result.toolCalls} stages_ms=${stageTimings.join(",")}`,
      );
    } catch (error) {
      const message = aiErrorMessage(error);
      const safeCode = error instanceof OpenRouterError
        ? `${error.code}${error.status ? `/${error.status}` : ""}`
        : "assistant_error";
      finishStage();
      console.error(`[ai] request failed code=${safeCode} duration_ms=${Math.round(performance.now() - startedAt)} stages_ms=${stageTimings.join(",")}`);
      await interaction.editReply({ embeds: [errorEmbed(message)] });
    } finally {
      activeRequests--;
    }
  },
};

function resetDailyCounter(now: number): void {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== usageDay) {
    usageDay = day;
    dailyRequests = 0;
  }
}

function aiErrorMessage(error: unknown): string {
  if (error instanceof OpenRouterError) {
    if (error.code === "timeout") return "The AI provider took too long to answer—try again.";
    if (error.status === 402) return "The AI guide's OpenRouter credits are unavailable.";
    if (error.status === 429) return "The AI provider is rate-limiting requests—try again shortly.";
    if (error.status !== undefined && error.status >= 500) return "The AI provider is temporarily unavailable.";
  }
  return "The AI guide ran into an internal response problem—try again.";
}
