// Bridge the panel's SSE event stream (/api/v1/events/stream) to Discord.
// We subscribe via ctx.session.streamEvents, keep only `event: event` frames
// (metrics/players frames drive live UI elsewhere), filter kinds against
// ctx.config.notifyEventKinds, and post one embed per event — coalescing
// bursts so a mass join/leave or a chatty countdown can't flood the channel.
import { EmbedBuilder } from "discord.js";
import type { NewsChannel, TextChannel } from "discord.js";
import type { BotContext } from "../discord/commands.js";
import type { PanelEvent } from "../types.js";
import {
  COLOR_NOTICE,
  COLOR_PRIMARY,
  COLOR_SUCCESS,
  formatBytes,
  truncate,
} from "../discord/embeds.js";

// Subtle accents for the high-frequency join/leave chatter.
const COLOR_JOIN = 0x4f9d69;
const COLOR_LEAVE = 0x8a929b;

// Flood guard: allow up to this many individual embeds inside a rolling window;
// anything past it in the same burst is batched into a single summary embed.
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 2000;
const BATCH_MAX_LINES = 20;

export function startNotifier(
  channel: TextChannel | NewsChannel | null,
  ctx: BotContext,
  signal: AbortSignal,
): void {
  let windowStart = 0;
  let countInWindow = 0;
  let batch: PanelEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (embed: EmbedBuilder): void => {
    if (!channel) return;
    channel
      .send({ embeds: [embed] })
      .catch((err) => console.error("[notify] failed to post embed:", err));
  };

  const flushBatch = (): void => {
    flushTimer = null;
    if (batch.length === 0) return;
    const items = batch;
    batch = [];
    send(buildBatchEmbed(items));
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(flushBatch, BURST_WINDOW_MS);
  };

  const handleEvent = (ev: PanelEvent): void => {
    const now = Date.now();
    if (now - windowStart > BURST_WINDOW_MS) {
      windowStart = now;
      countInWindow = 0;
    }
    countInWindow++;
    if (countInWindow <= BURST_LIMIT) {
      send(buildEventEmbed(ev));
    } else {
      // Remainder of this burst is coalesced into one summary embed.
      batch.push(ev);
      scheduleFlush();
    }
  };

  const onMessage = (msg: { event: string; data: string }): void => {
    if (msg.event !== "event") return; // ignore metrics/players frames
    let ev: PanelEvent;
    try {
      ev = JSON.parse(msg.data) as PanelEvent;
    } catch (err) {
      console.error("[notify] skipping unparseable event frame:", err);
      return;
    }
    if (!ev || typeof ev.kind !== "string") return;
    void ctx.observations.recordPanelEvent(ev).catch((err) =>
      console.error("[history] failed to record panel event:", err),
    );
    if (!ctx.config.notifyEventKinds.has(ev.kind)) return;
    // Transient GUID-keyed maps (fishing spots, supply drops…) flap the panel's
    // drift flag until the parser learns them; muting is opt-in and temporary.
    if (
      ctx.config.suppressDriftNotices &&
      ev.kind === "system" &&
      ev.message.includes("format drift")
    ) {
      return;
    }
    try {
      handleEvent(ev);
    } catch (err) {
      console.error("[notify] error handling event:", err);
    }
  };

  const onStatus = (
    status: "connected" | "disconnected",
    detail?: string,
  ): void => {
    console.log(`[notify] ${status}${detail ? `: ${detail}` : ""}`);
  };

  // Fire-and-forget: the stream runs for the life of the bot. Never let a
  // stream error crash the process — log and move on.
  void (async () => {
    try {
      await ctx.session.streamEvents(onMessage, signal, onStatus);
    } catch (err) {
      console.error("[notify] event stream terminated with error:", err);
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
    }
  })();
}

function metaStr(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function metaNum(meta: Record<string, unknown> | undefined, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildEventEmbed(ev: PanelEvent): EmbedBuilder {
  const embed = new EmbedBuilder().setTimestamp(new Date(ev.at));

  switch (ev.kind) {
    case "backup": {
      embed
        .setColor(COLOR_SUCCESS)
        .setTitle("💾 Backup")
        .setDescription(truncate(ev.message, 4096));
      const file = metaStr(ev.meta, "file");
      const size = metaNum(ev.meta, "sizeBytes");
      const trigger = metaStr(ev.meta, "trigger");
      const fields = [];
      if (file) fields.push({ name: "File", value: truncate(file, 1024), inline: true });
      if (size !== null) fields.push({ name: "Size", value: formatBytes(size), inline: true });
      if (trigger) fields.push({ name: "Trigger", value: trigger, inline: true });
      if (fields.length) embed.addFields(fields);
      break;
    }
    case "system":
      embed
        .setColor(COLOR_NOTICE)
        .setTitle("🔄 Server")
        // Countdowns/shutdown warnings arrive as system events — make them loud.
        .setDescription(`**${truncate(ev.message, 4090)}**`);
      break;
    case "join":
      embed.setColor(COLOR_JOIN).setDescription(`▶ ${truncate(ev.message, 4094)}`);
      break;
    case "leave":
      embed.setColor(COLOR_LEAVE).setDescription(`◀ ${truncate(ev.message, 4094)}`);
      break;
    case "panel":
    case "config":
    default:
      embed.setColor(COLOR_PRIMARY).setDescription(truncate(ev.message, 4096));
      break;
  }

  return embed;
}

function buildBatchEmbed(items: PanelEvent[]): EmbedBuilder {
  const prefix: Record<string, string> = {
    backup: "💾",
    system: "🔄",
    join: "▶",
    leave: "◀",
    panel: "•",
    config: "•",
  };
  const shown = items.slice(0, BATCH_MAX_LINES);
  const lines = shown.map(
    (ev) => `${prefix[ev.kind] ?? "•"} ${truncate(ev.message, 180)}`,
  );
  if (items.length > BATCH_MAX_LINES) {
    lines.push(`…and ${items.length - BATCH_MAX_LINES} more`);
  }
  return new EmbedBuilder()
    .setColor(COLOR_NOTICE)
    .setTitle(`🔔 ${items.length} more server events`)
    .setDescription(truncate(lines.join("\n"), 4096))
    .setTimestamp(new Date());
}
