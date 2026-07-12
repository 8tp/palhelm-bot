import sharp from "sharp";
import { AssetCache } from "../palhelm/assets.js";
import type { SessionClient } from "../palhelm/session.js";
import type { Pal } from "../types.js";
import { palVariantTags } from "../pals/presentation.js";

// Icons are static between operator re-fetches; share one cache across invocations.
let sharedAssets: AssetCache | null = null;
export function assetsFor(session: SessionClient): AssetCache {
  return (sharedAssets ??= new AssetCache(session));
}

export const BOX_COLS = 6;
export const BOX_ROWS = 5;

const CELL = 72;
const PAD = 8;

/** Shown when the panel reports save format drift — never confuse with "empty world". */
export const FORMAT_DRIFT_WARNING =
  "⚠️ Palhelm can't fully parse this Palworld save version yet — data may be incomplete or missing.";

export interface GridPlacement {
  itemIndex: number;
  slot: number;
  col: number;
  row: number;
}

export interface PalGridOptions {
  cols: number;
  /** Fixes the canvas height and bounds, as needed by an in-game box page. */
  rows?: number;
  /** Explicit zero-based slots. Omit for sequential packed placement. */
  slots?: ReadonlyArray<number | null | undefined>;
}

/** Pure placement logic shared by rendering and unit tests. */
export function computeGridPlacements(
  itemCount: number,
  options: PalGridOptions,
): GridPlacement[] {
  const count = Math.max(0, Math.floor(itemCount));
  const cols = Math.max(1, Math.floor(options.cols));
  const fixedRows = options.rows === undefined
    ? undefined
    : Math.max(1, Math.floor(options.rows));
  const capacity = fixedRows === undefined ? Number.POSITIVE_INFINITY : cols * fixedRows;
  const placements: GridPlacement[] = [];

  for (let itemIndex = 0; itemIndex < count; itemIndex++) {
    const suppliedSlot = options.slots?.[itemIndex];
    const slot = options.slots === undefined ? itemIndex : suppliedSlot;
    if (slot === null || slot === undefined || !Number.isInteger(slot)) continue;
    if (slot < 0 || slot >= capacity) continue;
    placements.push({
      itemIndex,
      slot,
      col: slot % cols,
      row: Math.floor(slot / cols),
    });
  }

  return placements;
}

/** Number of box pages represented by the roster (boxPage is zero-based). */
export function boxPageCount(pals: readonly Pal[]): number {
  let maxPage = -1;
  for (const pal of pals) {
    if (
      pal.boxPage !== null &&
      pal.boxPage !== undefined &&
      Number.isInteger(pal.boxPage) &&
      pal.boxPage >= 0
    ) {
      maxPage = Math.max(maxPage, pal.boxPage);
    }
  }
  return maxPage + 1;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function placeholderSvg(initial: string): Buffer {
  const ch = escapeXml(initial.slice(0, 1).toUpperCase() || "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}">
  <circle cx="${CELL / 2}" cy="${CELL / 2}" r="${CELL / 2 - 4}" fill="#3a3f47" stroke="#6a7078" stroke-width="2"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="28" font-family="DejaVu Sans,sans-serif" fill="#c8ccd0">${ch}</text>
</svg>`;
  return Buffer.from(svg, "utf8");
}

export function ringSvg(color: string): Buffer {
  const r = CELL / 2 - 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}">
  <circle cx="${CELL / 2}" cy="${CELL / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="3.5"/>
</svg>`;
  return Buffer.from(svg, "utf8");
}

export function palLine(pal: Pal): string {
  const tags = palVariantTags(pal);
  return `Lv ${String(pal.level).padStart(2, "0")} ${pal.displayName}${tags}`;
}

export async function renderIconCell(
  icon: Buffer | null,
  pal: Pal,
): Promise<Buffer> {
  let base: Buffer;
  if (icon) {
    base = await sharp(icon)
      .resize(CELL, CELL, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } else {
    base = await sharp(placeholderSvg(pal.displayName || pal.characterId))
      .png()
      .toBuffer();
  }

  const overlays: sharp.OverlayOptions[] = [];
  // Lucky (gold) under alpha (red) so both are visible when both apply.
  if (pal.isLucky) overlays.push({ input: ringSvg("#d4a017"), left: 0, top: 0 });
  if (pal.isAlpha) overlays.push({ input: ringSvg("#c0392b"), left: 0, top: 0 });

  if (overlays.length === 0) return base;
  return sharp(base).composite(overlays).png().toBuffer();
}

/** Render either packed items or items placed into explicit fixed slots. */
export async function renderPalGrid(
  pals: readonly Pal[],
  icons: ReadonlyArray<Buffer | null>,
  options: PalGridOptions,
): Promise<Buffer> {
  const placements = computeGridPlacements(pals.length, options);
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = options.rows === undefined
    ? Math.max(1, Math.ceil(pals.length / cols))
    : Math.max(1, Math.floor(options.rows));
  const width = PAD + cols * (CELL + PAD);
  const height = PAD + rows * (CELL + PAD);

  const composites: sharp.OverlayOptions[] = [];
  for (const placement of placements) {
    const pal = pals[placement.itemIndex];
    if (!pal) continue;
    const cell = await renderIconCell(icons[placement.itemIndex] ?? null, pal);
    composites.push({
      input: cell,
      left: PAD + placement.col * (CELL + PAD),
      top: PAD + placement.row * (CELL + PAD),
    });
  }

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 22, g: 26, b: 32, alpha: 1 },
    },
  }).composite(composites).png().toBuffer();
}
