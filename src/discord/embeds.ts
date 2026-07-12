import { EmbedBuilder } from "discord.js";

/** Palhelm brand-ish accent for regular embeds. */
export const COLOR_PRIMARY = 0x6b8e23; // olive — matches the v2 field-guide direction
export const COLOR_ERROR = 0xc0392b;
export const COLOR_SUCCESS = 0x2e8b57;
export const COLOR_NOTICE = 0xd4a017;

export function baseEmbed(title?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR_PRIMARY).setTimestamp(new Date());
  if (title) e.setTitle(title);
  return e;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOR_ERROR).setDescription(`⚠️ ${message}`);
}

/** 90061 -> "1d 1h 1m". Sub-minute durations render as "<1m". */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.length ? parts.join(" ") : "<1m";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

/** RFC 3339 timestamp -> Discord relative time markup (<t:...:R>). */
export function discordRelative(rfc3339: string): string {
  const ms = Date.parse(rfc3339);
  if (Number.isNaN(ms)) return rfc3339;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
