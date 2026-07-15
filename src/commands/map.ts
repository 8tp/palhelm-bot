import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import sharp from "sharp";
import type { Command } from "../discord/commands.js";
import { baseEmbed, truncate } from "../discord/embeds.js";
import { AssetCache } from "../palhelm/assets.js";
import type { BinaryAsset, SessionClient, SessionPlayer } from "../palhelm/session.js";
import type { Guild, MapLayer, MapLayerTransform } from "../types.js";

// Tiles are static between operator re-fetches; share one cache across invocations.
let sharedAssets: AssetCache | null = null;
function assetsFor(session: SessionClient): AssetCache {
  return (sharedAssets ??= new AssetCache(session));
}

const TARGET_MIN_PX = 1024;
const TARGET_MAX_PX = 2048;
const MARKER_R = 6;

/** Pick a zoom whose full pyramid is roughly 1024–2048 px on a side. */
function pickZoom(tileSize: number, minZoom: number, maxZoom: number): number {
  let bestInRange: number | null = null;
  let bestAtOrUnderMax = minZoom;
  for (let z = minZoom; z <= maxZoom; z++) {
    const size = 2 ** z * tileSize;
    if (size <= TARGET_MAX_PX) bestAtOrUnderMax = z;
    if (size >= TARGET_MIN_PX && size <= TARGET_MAX_PX) bestInRange = z;
  }
  return bestInRange ?? bestAtOrUnderMax;
}

/**
 * UE world cm → pixel coords at zoom z.
 * Matches frontend mapTransform.ts THGL/Leaflet L.Transformation:
 *   tilePixel(zoom) = 2^zoom * (a*worldX + b), 2^zoom * (c*worldY + d)
 * where zoom-0 canvas is exactly `tileSize` square.
 */
function worldToPixel(
  worldX: number,
  worldY: number,
  t: MapLayerTransform,
  zoom: number,
): { x: number; y: number } {
  const s = 2 ** zoom;
  return {
    x: s * (t.a * worldX + t.b),
    y: s * (t.c * worldY + t.d),
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function label12(name: string): string {
  return name.length <= 12 ? name : `${name.slice(0, 11)}…`;
}

function guildsTextFallback(guilds: Guild[], intro: string): string {
  const lines: string[] = [intro, ""];
  if (guilds.length === 0) {
    lines.push("_No guilds in the current save._");
  } else {
    for (const g of guilds) {
      if (g.bases.length === 0) {
        lines.push(`**${g.name}** — no bases`);
        continue;
      }
      const coords = g.bases
        .map((b) => `(${Math.round(b.location.x)}, ${Math.round(b.location.y)})`)
        .join(", ");
      lines.push(`**${g.name}** — ${coords}`);
    }
  }
  return truncate(lines.join("\n"), 4096);
}

function markersOverlay(
  size: number,
  markers: Array<{ x: number; y: number; label?: string; color?: string }>,
): Buffer {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`,
  ];
  for (const m of markers) {
    const cx = Math.round(m.x);
    const cy = Math.round(m.y);
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${MARKER_R}" fill="${m.color ?? "#6b8e23"}" stroke="#1a1a1a" stroke-width="1.5"/>`,
    );
    if (m.label) {
      const text = escapeXml(label12(m.label));
      parts.push(
        `<text x="${cx + MARKER_R + 2}" y="${cy + 4}" font-size="11" font-family="DejaVu Sans,sans-serif" fill="#f5f5f5" stroke="#000" stroke-width="2.5" paint-order="stroke" stroke-linejoin="round">${text}</text>`,
      );
    }
  }
  parts.push("</svg>");
  return Buffer.from(parts.join(""), "utf8");
}

function resolveLayer(layers: MapLayer[], opt: string | null): MapLayer | undefined {
  if (!layers.length) return undefined;
  if (!opt) return layers[0];
  const lower = opt.toLowerCase();
  return (
    layers.find((l) => l.id === opt) ??
    layers.find((l) => l.id.toLowerCase() === lower) ??
    layers.find((l) => l.label.toLowerCase() === lower) ??
    layers.find((l) => l.label.toLowerCase().includes(lower)) ??
    layers[0]
  );
}

export const mapCommand: Command = {
  helpCategory: "server",
  data: new SlashCommandBuilder()
    .setName("map")
    .setDescription("Render the world map with guild bases")
    .addStringOption((o) =>
      o
        .setName("layer")
        .setDescription("Map layer (autocomplete from dataset)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName("pal").setDescription("Optional Pal habitat/encounter lookup").setRequired(false).setAutocomplete(true),
    ),

  async autocomplete(interaction, ctx) {
    const focusedOption = interaction.options.getFocused(true);
    const focused = String(focusedOption.value).toLowerCase();
    try {
      if (focusedOption.name === "pal") {
        await ctx.knowledge.init();
        await interaction.respond(ctx.knowledge.search(focused, 25).data.map((pal) => ({ name: truncate(pal.name, 100), value: pal.name.slice(0, 100) })));
        return;
      }
      const { data: dataset } = await ctx.integration.map();
      const layers = dataset.layers ?? [];
      const matches = layers
        .filter(
          (l) =>
            l.id.toLowerCase().includes(focused) ||
            l.label.toLowerCase().includes(focused),
        )
        .slice(0, 25)
        .map((l) => ({
          name: truncate(`${l.label} (${l.id})`, 100),
          value: l.id.slice(0, 100),
        }));
      await interaction.respond(matches);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction, ctx) {
    await interaction.deferReply();

    const [{ data: dataset }, guildsEnv, sessionPlayers] = await Promise.all([
      ctx.integration.map(),
      ctx.integration.guilds(),
      // Player world positions live only on the session API; never break the map
      // if that call fails (auth, panel outage) — just fall back to bases only.
      ctx.session.players().catch(() => [] as SessionPlayer[]),
    ]);
    const guilds = guildsEnv.data;
    const basesDrift = guildsEnv.formatDrift === true;

    const layers = dataset.layers ?? [];
    const totalBases = guilds.reduce((n, g) => n + g.bases.length, 0);
    const livePlayers = sessionPlayers.filter((p) => p.online && p.location);
    const layerOpt = interaction.options.getString("layer");
    const palQuery = interaction.options.getString("pal");
    const palLocations = palQuery ? ctx.locations.search(palQuery, 12) : [];
    const layer = resolveLayer(layers, layerOpt);

    const baseEmbedFields = () => {
      const embed = baseEmbed("World map").addFields(
        { name: "Players", value: `${livePlayers.length} online`, inline: true },
        { name: "Bases", value: basesDrift && totalBases === 0 ? "unavailable" : `${totalBases}`, inline: true },
        { name: "Guilds", value: `${guilds.length}`, inline: true },
      );
      if (palQuery) embed.addFields({
        name: `${truncate(palQuery, 80)} encounters`,
        value: palLocations.length === 0 ? "No exact rows in the local attributed location cache." : truncate(palLocations.map((row) =>
          `${row.variantType ? `${row.variantType} ` : ""}${row.locationName}${row.level === null ? "" : ` Lv ${row.level}`}${row.coords ? ` · (${row.coords.x}, ${row.coords.y})` : ""}`
        ).join("\n"), 1024),
      }, {
        name: "Encounter source",
        value: "[The Palworld Wiki](https://palworld.wiki.gg/wiki/Template:Entity_Location_Spawn) · CC BY-SA 4.0 · in-game coordinates are listed as text until map-coordinate calibration is proven.",
      });
      return embed;
    };

    if (!layer) {
      const embed = baseEmbedFields().setDescription(
        guildsTextFallback(
          guilds,
          "No map layers in the dataset — map tiles have not been fetched on the panel (`scripts/fetch-map-tiles.sh`). Listing guild bases as text:",
        ),
      );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const zoom = pickZoom(layer.tileSize, layer.minZoom, layer.maxZoom);
    const n = 2 ** zoom;
    const tileSize = layer.tileSize;
    const format = layer.format || "png";
    const canvasSize = n * tileSize;
    const assets = assetsFor(ctx.session);

    // Layered pyramids first; single-layer/legacy omit the layer segment.
    let layerKey: string | null = layer.id;
    let corner: BinaryAsset | null = await assets.tile(layerKey, zoom, 0, 0, format);
    if (!corner) {
      const legacy = await assets.tile(null, zoom, 0, 0, format);
      if (legacy) {
        layerKey = null;
        corner = legacy;
      }
    }

    const tileJobs: Promise<{ x: number; y: number; buffer: Buffer } | null>[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        tileJobs.push(
          (async () => {
            const asset =
              x === 0 && y === 0
                ? corner
                : await assets.tile(layerKey, zoom, x, y, format);
            return asset ? { x, y, buffer: asset.buffer } : null;
          })(),
        );
      }
    }

    const tileResults = await Promise.all(tileJobs);
    const tileComposites = tileResults
      .filter((t): t is { x: number; y: number; buffer: Buffer } => t !== null)
      .map((t) => ({
        input: t.buffer,
        left: t.x * tileSize,
        top: t.y * tileSize,
      }));

    if (tileComposites.length === 0) {
      const embed = baseEmbedFields().setDescription(
        guildsTextFallback(
          guilds,
          "Map tiles returned 404 — the pyramid has not been fetched on the panel (`scripts/fetch-map-tiles.sh`). Listing guild bases as text:",
        ),
      );
      if (layer) {
        embed.addFields({
          name: "Layer",
          value: truncate(layer.label || layer.id, 1024),
          inline: true,
        });
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const onCanvas = (p: { x: number; y: number }) =>
      p.x >= -20 && p.y >= -20 && p.x <= canvasSize + 20 && p.y <= canvasSize + 20;
    const markers: Array<{ x: number; y: number; label?: string; color?: string }> = [];
    for (const g of guilds) {
      g.bases.forEach((base, i) => {
        const p = worldToPixel(base.location.x, base.location.y, layer.transform, zoom);
        if (!onCanvas(p)) return;
        // Label only the guild's first base. Olive = guild base.
        markers.push({ x: p.x, y: p.y, label: i === 0 ? g.name : undefined, color: "#6b8e23" });
      });
    }
    // Live players on top, in blue, so friends can see where everyone is.
    for (const player of livePlayers) {
      const p = worldToPixel(player.location!.x, player.location!.y, layer.transform, zoom);
      if (!onCanvas(p)) continue;
      markers.push({ x: p.x, y: p.y, label: player.name, color: "#4da3ff" });
    }

    const composites: sharp.OverlayOptions[] = [...tileComposites];
    if (markers.length > 0) {
      composites.push({
        input: markersOverlay(canvasSize, markers),
        left: 0,
        top: 0,
      });
    }

    const png = await sharp({
      create: {
        width: canvasSize,
        height: canvasSize,
        channels: 3,
        background: { r: 18, g: 22, b: 28 },
      },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const file = new AttachmentBuilder(png, { name: "map.png" });
    const legend = `**${truncate(layer.label || layer.id, 80)}** — 🔵 players · 🟢 guild bases`;
    const embed = baseEmbedFields()
      .setDescription(basesDrift && totalBases === 0 ? `${legend}\n⚠️ Guild bases are unavailable while the save is re-parsing.` : legend)
      .setImage("attachment://map.png");

    await interaction.editReply({ embeds: [embed], files: [file] });
  },
};
