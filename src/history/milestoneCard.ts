import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AssetCache } from "../palhelm/assets.js";
import type { Milestone } from "./tracker.js";

const WIDTH = 1200;
const HEIGHT = 675;
const PORTRAIT = 196;
const PAL_ICON = 214;
const BACKGROUND_PATH = fileURLToPath(
  new URL("../../assets/milestone-background-v1.png", import.meta.url),
);
// Steam's generic dark question-mark image is a successful HTTP response, not
// a 404. Treat it as unavailable so the card shows a useful player initial.
const STEAM_DEFAULT_AVATAR_SHA256 = "58f08592a940bcd85a9620b52c262b6ce1cd7a4b6cb6a3b6494028614794d2b2";

let backgroundPromise: Promise<Buffer> | null = null;

/** Render one self-contained Discord milestone card from cached panel assets. */
export async function renderMilestoneCard(
  milestone: Milestone,
  assets: Pick<AssetCache, "playerAvatar" | "palIcon">,
  label: string,
): Promise<Buffer> {
  const [background, avatarAsset, palAsset] = await Promise.all([
    (backgroundPromise ??= readFile(BACKGROUND_PATH)),
    milestone.playerUid
      ? assets.playerAvatar(milestone.playerUid).catch(() => null)
      : Promise.resolve(null),
    milestone.characterId
      ? assets.palIcon(milestone.characterId).catch(() => null)
      : Promise.resolve(null),
  ]);

  const avatar = avatarAsset && !isSteamDefaultAvatar(avatarAsset.buffer)
    ? await circularImage(avatarAsset.buffer, PORTRAIT)
    : await sharp(playerPlaceholder(milestone.playerName ?? "?")).png().toBuffer();
  const rightVisual = palAsset
    ? await circularImage(palAsset.buffer, PAL_ICON)
    : null;

  const composites: sharp.OverlayOptions[] = [
    { input: cardOverlay(milestone, Boolean(rightVisual), label), left: 0, top: 0 },
    { input: avatar, left: 73, top: 239 },
    ...(rightVisual ? [{ input: rightVisual, left: 925, top: 226 }] : []),
  ];

  return sharp(background)
    .resize(WIDTH, HEIGHT, { fit: "cover" })
    .composite(composites)
    .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

function isSteamDefaultAvatar(buffer: Buffer): boolean {
  return createHash("sha256").update(buffer).digest("hex") === STEAM_DEFAULT_AVATAR_SHA256;
}

async function circularImage(input: Buffer, size: number): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`,
  );
  return sharp(input)
    .resize(size, size, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

function playerPlaceholder(name: string): Buffer {
  const initial = escapeXml(name.trim().slice(0, 1).toUpperCase() || "?");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PORTRAIT}" height="${PORTRAIT}">
    <circle cx="98" cy="98" r="98" fill="#102b3c"/>
    <circle cx="98" cy="98" r="94" fill="none" stroke="#f3bd62" stroke-width="4"/>
    <text x="98" y="116" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="72" font-weight="700" fill="#f5f8fa">${initial}</text>
  </svg>`);
}

function cardOverlay(milestone: Milestone, hasPalIcon: boolean, label: string): Buffer {
  const copy = milestoneCopy(milestone, label);
  const badgeLabel = escapeXml(short(label.toUpperCase(), 16));
  const player = escapeXml(short(milestone.playerName ?? "Player", 28));
  const eyebrow = escapeXml(copy.eyebrow.toUpperCase());
  const title = escapeXml(short(copy.title, 30));
  const subtitle = escapeXml(short(copy.subtitle, 52));
  const badge = escapeXml(copy.badge);
  const palName = escapeXml(short(milestone.speciesName ?? copy.title, 24));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="8" flood-color="#00101c" flood-opacity=".65"/></filter>
      <linearGradient id="panel" x1="0" x2="1"><stop stop-color="#061b2c" stop-opacity=".78"/><stop offset="1" stop-color="#061b2c" stop-opacity=".32"/></linearGradient>
    </defs>
    <rect x="286" y="154" width="626" height="367" rx="34" fill="url(#panel)" stroke="#75d9dc" stroke-opacity=".25"/>
    <circle cx="171" cy="337" r="108" fill="none" stroke="#f3bd62" stroke-width="5" filter="url(#shadow)"/>
    <circle cx="171" cy="337" r="115" fill="none" stroke="#74d7dc" stroke-opacity=".35" stroke-width="2"/>
    <text x="171" y="482" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="25" font-weight="700" fill="#f7fafb">${player}</text>
    <text x="334" y="223" font-family="DejaVu Sans,sans-serif" font-size="22" font-weight="700" letter-spacing="4" fill="#77dce0">${eyebrow}</text>
    <text x="334" y="330" font-family="DejaVu Sans,sans-serif" font-size="67" font-weight="800" fill="#fff7e8" filter="url(#shadow)">${title}</text>
    <text x="337" y="389" font-family="DejaVu Sans,sans-serif" font-size="27" font-weight="500" fill="#d6e9ec">${subtitle}</text>
    <rect x="334" y="434" width="196" height="42" rx="21" fill="#f3bd62"/>
    <text x="432" y="463" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="20" font-weight="800" letter-spacing="2" fill="#102334">${badgeLabel}</text>
    ${hasPalIcon ? `
      <circle cx="1032" cy="337" r="119" fill="#092236" fill-opacity=".58" stroke="#f3bd62" stroke-width="5" filter="url(#shadow)"/>
      <circle cx="1032" cy="337" r="127" fill="none" stroke="#74d7dc" stroke-opacity=".4" stroke-width="2"/>
      <text x="1032" y="482" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="25" font-weight="700" fill="#f7fafb">${palName}</text>` : `
      <circle cx="1032" cy="337" r="119" fill="#092236" fill-opacity=".78" stroke="#f3bd62" stroke-width="5" filter="url(#shadow)"/>
      <text x="1032" y="316" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="27" font-weight="700" letter-spacing="3" fill="#75d9dc">${escapeXml(copy.badgeLabel)}</text>
      <text x="1032" y="382" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="58" font-weight="800" fill="#fff7e8">${badge}</text>`}
  </svg>`);
}

function milestoneCopy(milestone: Milestone, label: string): {
  eyebrow: string;
  title: string;
  subtitle: string;
  badgeLabel: string;
  badge: string;
} {
  const player = milestone.playerName?.trim() || "A player";
  switch (milestone.kind) {
    case "first_species":
      return {
        eyebrow: "First observed Pal",
        title: milestone.speciesName ?? "New Pal",
        subtitle: `${player} expanded the server Paldeck`,
        badgeLabel: "NEW",
        badge: "PAL",
      };
    case "first_alpha":
      return {
        eyebrow: "Rare Pal milestone",
        title: "First Alpha",
        subtitle: milestone.speciesName ? `${player} found ${milestone.speciesName}` : `${player} found their first Alpha Pal`,
        badgeLabel: "ALPHA",
        badge: "★",
      };
    case "first_lucky":
      return {
        eyebrow: "Rare Pal milestone",
        title: "First Lucky",
        subtitle: milestone.speciesName ? `${player} found ${milestone.speciesName}` : `${player} found their first Lucky Pal`,
        badgeLabel: "LUCKY",
        badge: "♦",
      };
    case "level":
      return {
        eyebrow: "Player milestone",
        title: `Level ${milestone.value ?? 0}`,
        subtitle: `${player} reached a new level`,
        badgeLabel: "LEVEL",
        badge: String(milestone.value ?? 0),
      };
    case "playtime": {
      const hours = Math.round((milestone.value ?? 0) / 3_600);
      return {
        eyebrow: "Adventure milestone",
        title: `${hours} Hours`,
        subtitle: `${player} has been exploring ${label}`,
        badgeLabel: "HOURS",
        badge: String(hours),
      };
    }
    case "record":
      return {
        eyebrow: "New server record",
        title: milestone.recordLabel ?? "Record",
        subtitle: `${player} · ${milestone.recordDetail ?? "new high score"}`,
        badgeLabel: "RECORD",
        badge: "#1",
      };
  }
}

function short(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
