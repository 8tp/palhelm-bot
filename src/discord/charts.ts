import sharp from "sharp";

// Field-guide palette (see embeds.ts COLOR_PRIMARY): cream ink on a dark card, olive bars.
const BG = "#1b1e23";
const CARD = "#22262c";
const INK = "#e8e4d8";
const INK_DIM = "#9a9488";
const OLIVE = "#8faa3a";
const OLIVE_SOFT = "#4a5a25";
const GRID = "#2f343b";

const WIDTH = 760;
const PAD = 18;
const ROW_H = 34;
const BAR_H = 18;
const TITLE_H = 30;
const LABEL_W = 210;
const VALUE_W = 96;

export interface BarItem {
  label: string;
  value: number;
  /** Optional pre-formatted value text; defaults to the numeric value. */
  display?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A horizontal bar chart rasterized to PNG. Bars scale to the largest value;
 * zero/negative values still render a hairline so every row stays legible.
 */
export async function barChartPng(title: string, items: BarItem[]): Promise<Buffer> {
  const rows = items.slice(0, 15);
  const height = PAD * 2 + TITLE_H + Math.max(1, rows.length) * ROW_H;
  const barMax = WIDTH - PAD * 2 - LABEL_W - VALUE_W;
  const maxValue = Math.max(1, ...rows.map((item) => item.value));

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<rect width="${WIDTH}" height="${height}" rx="14" fill="${BG}"/>`,
    `<rect x="6" y="6" width="${WIDTH - 12}" height="${height - 12}" rx="10" fill="${CARD}"/>`,
    `<text x="${PAD + 6}" y="${PAD + 18}" font-family="DejaVu Sans, sans-serif" font-size="17" font-weight="700" fill="${INK}">${escapeXml(clip(title, 60))}</text>`,
  ];

  if (rows.length === 0) {
    parts.push(
      `<text x="${WIDTH / 2}" y="${height / 2 + 20}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="14" fill="${INK_DIM}">No data yet</text>`,
    );
  }

  rows.forEach((item, index) => {
    const y = PAD + TITLE_H + index * ROW_H;
    const barY = y + (ROW_H - BAR_H) / 2;
    const barX = PAD + LABEL_W;
    const width = Math.max(2, Math.round((item.value / maxValue) * barMax));
    const value = escapeXml(clip(item.display ?? String(item.value), 14));
    const label = escapeXml(clip(item.label, 26));
    parts.push(
      `<text x="${PAD + 6}" y="${barY + BAR_H - 4}" font-family="DejaVu Sans, sans-serif" font-size="13" fill="${INK}">${index + 1}. ${label}</text>`,
      `<rect x="${barX}" y="${barY}" width="${barMax}" height="${BAR_H}" rx="5" fill="${GRID}"/>`,
      `<rect x="${barX}" y="${barY}" width="${width}" height="${BAR_H}" rx="5" fill="${OLIVE}"/>`,
      `<rect x="${barX}" y="${barY}" width="${Math.min(width, 4)}" height="${BAR_H}" fill="${OLIVE_SOFT}"/>`,
      `<text x="${barX + barMax + VALUE_W - 10}" y="${barY + BAR_H - 4}" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="13" font-weight="600" fill="${INK_DIM}">${value}</text>`,
    );
  });

  parts.push("</svg>");
  return sharp(Buffer.from(parts.join(""), "utf8")).png().toBuffer();
}

/**
 * A donut/ring progress chart (e.g. Paldeck completion) with a percentage label,
 * rasterized to PNG.
 */
export async function ringPng(title: string, done: number, total: number): Promise<Buffer> {
  const size = 260;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const r = 86;
  const stroke = 26;
  const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * pct;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="14" fill="${CARD}"/>`,
    `<text x="${cx}" y="26" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="700" fill="${INK}">${escapeXml(clip(title, 34))}</text>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${GRID}" stroke-width="${stroke}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${OLIVE}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${dash} ${circumference}" transform="rotate(-90 ${cx} ${cy})"/>`,
    `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="40" font-weight="700" fill="${INK}">${Math.round(pct * 100)}%</text>`,
    `<text x="${cx}" y="${cy + 30}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="15" fill="${INK_DIM}">${done} / ${total}</text>`,
    "</svg>",
  ].join("");
  return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}
