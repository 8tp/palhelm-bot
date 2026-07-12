import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { BotConfig } from "../config.js";
import type { IntegrationClient } from "../palhelm/integration.js";
import type { SessionClient } from "../palhelm/session.js";
import type { SnapshotService } from "../snapshots/service.js";
import type { ObservationTracker } from "../history/tracker.js";
import type { OpenRouterClient } from "../ai/openrouter.js";
import type { WebSearchClient } from "../ai/websearch.js";
import type { PalKnowledgeService } from "../knowledge/paldeck.js";
import type { GoalService } from "../goals/service.js";
import type { PlayerLinkService } from "../identity/playerLinks.js";
import type { KnowledgeCorpus } from "../knowledge/corpus.js";

export interface BotContext {
  config: BotConfig;
  integration: IntegrationClient;
  session: SessionClient;
  snapshots: SnapshotService;
  observations: ObservationTracker;
  knowledge: PalKnowledgeService;
  /** Optional disk-backed general Palworld field guide; empty when not yet ingested. */
  generalKnowledge: KnowledgeCorpus;
  goals: GoalService;
  playerLinks: PlayerLinkService;
  openRouter: OpenRouterClient | null;
  /** Palworld-scoped web search; null when SEARXNG_URL is unset. */
  webSearch: WebSearchClient | null;
}

export type CommandHelpCategory =
  | "server"
  | "players"
  | "pals"
  | "breeding"
  | "records"
  | "assistant"
  | "admin";

export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  /** Category used by /help. Required so newly registered commands cannot be omitted. */
  helpCategory: CommandHelpCategory;
  /** Set true for commands gated on ADMIN_ROLE_ID (checked centrally in index.ts). */
  adminOnly?: boolean;
  execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction, ctx: BotContext): Promise<void>;
}
