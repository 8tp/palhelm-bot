import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  SlashCommandBuilder,
} from "discord.js";
import type { InteractionEditReplyOptions } from "discord.js";
import type { Command } from "../discord/commands.js";
import { baseEmbed, discordRelative, truncate } from "../discord/embeds.js";
import type { EventKind, PanelEvent } from "../types.js";

const FILTERS: Record<string, { label: string; kinds: EventKind[] }> = {
  all: { label: "Recent activity", kinds: [] },
  players: { label: "Player joins & leaves", kinds: ["join", "leave"] },
  backups: { label: "Backups", kinds: ["backup"] },
  system: { label: "System", kinds: ["system"] },
};

const EMOJI: Partial<Record<EventKind, string>> = {
  join: "🟢",
  leave: "🔴",
  backup: "💾",
  system: "⚙️",
};

const PUBLIC_SYSTEM_MESSAGES = new Set([
  "Palworld REST API is reachable",
  "Palworld REST API is unreachable",
  "world save format drift detected",
  "world save format drift resolved",
]);

const FETCH = 60;
const PAGE_SIZE = 10;
const COLLECTOR_MS = 180_000;

interface PublicEvent { event: PanelEvent; message: string }

export function historyPageRange(total: number, requestedPage: number): { page: number; pageCount: number; start: number; end: number } {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, requestedPage));
  const start = (page - 1) * PAGE_SIZE;
  return { page, pageCount, start, end: Math.min(total, start + PAGE_SIZE) };
}

function historyControlIds(interactionId: string): { previous: string; next: string } {
  return { previous: `history_prev:${interactionId}`, next: `history_next:${interactionId}` };
}

export function historyControlError(
  expected: { previous: string; next: string },
  actualCustomId: string,
  requesterId: string,
  actorId: string,
): string | null {
  if (actualCustomId !== expected.previous && actualCustomId !== expected.next) return "That history control is no longer valid.";
  if (actorId !== requesterId) return "Only the person who opened this history can change its page.";
  return null;
}

export function historyNavigationRow(interactionId: string, page: number, pageCount: number, disableAll = false): ActionRowBuilder<ButtonBuilder> {
  const ids = historyControlIds(interactionId);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.previous).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(disableAll || page <= 1),
    new ButtonBuilder().setCustomId(`history_page:${interactionId}`).setLabel(`Page ${page}/${pageCount}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(ids.next).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(disableAll || page >= pageCount),
  );
}

export const historyCommand: Command = {
  helpCategory: "server",
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Recent server activity — joins, leaves, backups, and system events")
    .addStringOption((option) =>
      option
        .setName("filter")
        .setDescription("What to show (defaults to everything)")
        .addChoices(
          { name: "Everything", value: "all" },
          { name: "Joins & leaves", value: "players" },
          { name: "Backups", value: "backups" },
          { name: "System", value: "system" },
        ),
    ),

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const filter = FILTERS[interaction.options.getString("filter") ?? "all"]
      ?? { label: "Recent activity", kinds: [] as EventKind[] };

    let events: PanelEvent[];
    try {
      // The public Integration contract already redacts this feed for Discord.
      // Do not fall back to admin-session event text in a public command.
      events = (await ctx.integration.events(FETCH)).data;
    } catch {
      await interaction.editReply({
        embeds: [baseEmbed("History unavailable").setDescription("Couldn't reach the panel to load recent events.")],
      });
      return;
    }

    const projected = events
      .filter((event) => filter.kinds.length === 0 || filter.kinds.includes(event.kind))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((event) => ({ event, message: safePublicEventMessage(event, ctx.config.suppressDriftNotices) }))
      .filter((item): item is PublicEvent => item.message !== null);

    const pageCount = historyPageRange(projected.length, 1).pageCount;
    let page = 1;
    const render = (target: number, disableAll = false): InteractionEditReplyOptions => {
      const { start, end } = historyPageRange(projected.length, target);
      const shown = projected.slice(start, end);
      const embed = baseEmbed(`📜 ${filter.label}`)
        .setDescription(shown.length === 0
          ? "No matching events recorded yet."
          : shown.map(({ event, message }) => `${EMOJI[event.kind] ?? "•"} ${message} · ${discordRelative(event.at)}`).join("\n"))
        .setFooter({ text: `${projected.length} safe event${projected.length === 1 ? "" : "s"} · page ${target}/${pageCount}` });
      return {
        embeds: [embed],
        components: pageCount > 1 ? [historyNavigationRow(interaction.id, target, pageCount, disableAll)] : [],
        allowedMentions: { parse: [] },
      };
    };

    const message = await interaction.editReply(render(page));
    if (pageCount <= 1) return;
    const ids = historyControlIds(interaction.id);
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: COLLECTOR_MS });
    collector.on("collect", async (button) => {
      const rejection = historyControlError(ids, button.customId, interaction.user.id, button.user.id);
      if (rejection) {
        await button.reply({ content: rejection, ephemeral: true }).catch(() => {});
        return;
      }
      page = button.customId === ids.next ? Math.min(pageCount, page + 1) : Math.max(1, page - 1);
      await button.update(render(page)).catch(() => {});
    });
    collector.on("end", async () => {
      await interaction.editReply(render(page, true)).catch(() => {});
    });
  },
};

/** Strict public projection of admin-session events. Unknown/admin event text is omitted. */
export function safePublicEventMessage(event: PanelEvent, suppressDrift: boolean): string | null {
  if (event.kind === "join" || event.kind === "leave") {
    const suffix = event.kind === "join" ? " joined" : " left";
    if (!event.message.endsWith(suffix)) return null;
    const name = event.message.slice(0, -suffix.length).replace(/[\r\n\t]/g, " ").trim();
    if (!name) return null;
    return `${truncate(name, 100)} ${event.kind === "join" ? "joined" : "left"}`;
  }
  if (event.kind === "backup") return "Backup completed";
  if (event.kind === "system") {
    if (!PUBLIC_SYSTEM_MESSAGES.has(event.message)) return null;
    if (suppressDrift && event.message.includes("format drift")) return null;
    return event.message;
  }
  return null;
}
