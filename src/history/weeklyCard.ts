import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { WeeklyDigest } from "./tracker.js";

const WIDTH = 1200;
const HEIGHT = 675;
const ICON = 126;
const BACKGROUND_PATH = fileURLToPath(new URL("../../assets/milestone-background-v1.png", import.meta.url));
let backgroundPromise: Promise<Buffer> | null = null;

/** Compose a compact weekly story card from already-aggregated, public data. */
export async function renderWeeklyDigestCard(digest: WeeklyDigest, label: string, palIcons: readonly Buffer[] = []): Promise<Buffer> {
  const icons = await Promise.all(palIcons.slice(0, 3).map(circularIcon));
  const overlays: sharp.OverlayOptions[] = [{ input: overlay(digest, label, icons.length), left: 0, top: 0 }];
  icons.forEach((icon, index) => overlays.push({ input: icon, left: 735 + (index * 145), top: 433 }));
  return sharp(await (backgroundPromise ??= readFile(BACKGROUND_PATH)))
    .resize(WIDTH, HEIGHT, { fit: "cover" })
    .composite(overlays)
    .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function circularIcon(input: Buffer): Promise<Buffer> {
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}"><circle cx="${ICON / 2}" cy="${ICON / 2}" r="${ICON / 2}" fill="white"/></svg>`);
  return sharp(input).resize(ICON, ICON, { fit: "cover" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

function overlay(digest: WeeklyDigest, label: string, iconCount: number): Buffer {
  const hours = Math.round(digest.playtimeDeltaSec / 3_600);
  const fps = digest.averageFps === null ? "—" : digest.averageFps.toFixed(1);
  const world = digest.firstDay === null ? "WORLD" : digest.firstDay === digest.lastDay ? `DAY ${digest.firstDay}` : `DAY ${digest.firstDay}–${digest.lastDay}`;
  const dates = `${new Date(digest.startedAt).toLocaleDateString()} – ${new Date(digest.endedAt).toLocaleDateString()}`;
  const species = digest.newSpecies.slice(0, 3).map((name, index) => `<text x="${798 + (index * 145)}" y="590" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="18" font-weight="700" fill="#f7fafb">${xml(short(name, 14))}</text>`).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><filter id="s"><feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="#00101c" flood-opacity=".7"/></filter><linearGradient id="p" x1="0" x2="1"><stop stop-color="#061b2c" stop-opacity=".88"/><stop offset="1" stop-color="#061b2c" stop-opacity=".48"/></linearGradient></defs>
    <rect x="64" y="62" width="1072" height="551" rx="38" fill="url(#p)" stroke="#75d9dc" stroke-opacity=".32"/>
    <text x="105" y="125" font-family="DejaVu Sans,sans-serif" font-size="21" font-weight="700" letter-spacing="4" fill="#75d9dc">${xml(short(label.toUpperCase(), 24))}</text>
    <text x="105" y="207" font-family="DejaVu Sans,sans-serif" font-size="61" font-weight="800" fill="#fff7e8" filter="url(#s)">WEEKLY DISPATCH</text>
    <text x="107" y="250" font-family="DejaVu Sans,sans-serif" font-size="22" fill="#d6e9ec">${xml(dates)} · ${xml(world)}</text>
    ${statBox(105, 304, "ADVENTURERS", String(digest.activePlayers.length), `${hours} combined hours`)}
    ${statBox(365, 304, "NEW PALS", String(digest.newPalInstances), `${digest.newSpecies.length} new species`)}
    ${statBox(625, 304, "RARE FINDS", String(digest.newAlphas + digest.newLuckies), `${digest.newAlphas} Alpha · ${digest.newLuckies} Lucky`)}
    ${statBox(885, 304, "SERVER", fps, `${digest.backups} backups · avg FPS`)}
    <text x="105" y="485" font-family="DejaVu Sans,sans-serif" font-size="20" font-weight="700" letter-spacing="3" fill="#f3bd62">HIGHLIGHTS</text>
    <text x="105" y="532" font-family="DejaVu Sans,sans-serif" font-size="21" fill="#f7fafb">${xml(short(digest.milestones[0] ?? "Another week of adventures recorded.", 48))}</text>
    ${iconCount > 0 ? species : `<text x="940" y="525" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="22" fill="#d6e9ec">No new species this week</text>`}
  </svg>`);
}

function statBox(x: number, y: number, label: string, value: string, detail: string): string {
  return `<rect x="${x}" y="${y}" width="226" height="127" rx="22" fill="#0b2b3d" fill-opacity=".8" stroke="#75d9dc" stroke-opacity=".25"/><text x="${x + 20}" y="${y + 34}" font-family="DejaVu Sans,sans-serif" font-size="16" font-weight="700" letter-spacing="2" fill="#75d9dc">${xml(label)}</text><text x="${x + 20}" y="${y + 82}" font-family="DejaVu Sans,sans-serif" font-size="43" font-weight="800" fill="#fff7e8">${xml(value)}</text><text x="${x + 20}" y="${y + 110}" font-family="DejaVu Sans,sans-serif" font-size="15" fill="#d6e9ec">${xml(detail)}</text>`;
}

function short(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
