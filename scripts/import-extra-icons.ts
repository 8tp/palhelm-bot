import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const destinationArgument = process.argv[2]?.trim();
if (!destinationArgument) {
  throw new Error("Usage: npm run icons:extras -- /path/to/pal-icons");
}
const destination = resolve(destinationArgument);
const apiUrl = "https://palworld.wiki.gg/api.php";
const userAgent = "Palhelm-Icon-Fallback/1.0 (personal server; attributed local cache)";
const maxIconBytes = 2 * 1024 * 1024;
const license = "CC BY-SA 4.0 (wiki page/content); artwork rights remain with their owners";

const requested = [
  { id: "boss_hunter_rifle", title: "Hawk icon.png" },
  { id: "yakushimaboss001", title: "Eye of Cthulhu icon.png" },
  { id: "yakushimaboss001_small", title: "Demon Eye icon.png" },
  { id: "yakushimamonster001", title: "Green Slime icon.png" },
  { id: "yakushimamonster001_blue", title: "Blue Slime icon.png" },
  { id: "yakushimamonster001_pink", title: "Illuminant Slime icon.png" },
  { id: "yakushimamonster001_purple", title: "Purple Slime icon.png" },
  { id: "yakushimamonster001_rainbow", title: "Rainbow Slime icon.png" },
  { id: "yakushimamonster001_red", title: "Red Slime icon.png" },
  { id: "yakushimamonster002", title: "Enchanted Sword icon.png" },
  { id: "yakushimamonster003_purple", title: "Illuminant Bat icon.png" },
] as const;

type WikiPage = {
  title?: string;
  missing?: boolean;
  imageinfo?: Array<{ url?: string; mime?: string; sha1?: string }>;
};

async function fetchChecked(url: URL | string): Promise<Response> {
  const response = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
  return response;
}

await mkdir(destination, { recursive: true });
const query = new URL(apiUrl);
query.search = new URLSearchParams({
  action: "query",
  format: "json",
  formatversion: "2",
  prop: "imageinfo",
  iiprop: "url|mime|sha1",
  maxlag: "5",
  titles: requested.map(({ title }) => `File:${title}`).join("|"),
}).toString();

const payload = (await (await fetchChecked(query)).json()) as { query?: { pages?: WikiPage[] } };
const pages = new Map((payload.query?.pages ?? []).map((page) => [page.title?.replace(/^File:/, ""), page]));
const provenance: Array<{ id: string; title: string; source: string; sha1: string | null; license: string }> = [];

for (const item of requested) {
  const page = pages.get(item.title);
  const info = page?.imageinfo?.[0];
  if (!page || page.missing || !info?.url || info.mime !== "image/png") {
    throw new Error(`Missing PNG image metadata for ${item.title}`);
  }
  const imageUrl = new URL(info.url);
  if (imageUrl.protocol !== "https:" || imageUrl.hostname !== "palworld.wiki.gg") {
    throw new Error(`Refusing unexpected image host for ${item.title}: ${imageUrl.hostname}`);
  }
  const response = await fetchChecked(imageUrl);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxIconBytes) {
    throw new Error(`Unexpected image size for ${item.title}: ${bytes.length}`);
  }
  const target = join(destination, `${item.id}.png`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, target);
  provenance.push({
    id: item.id,
    title: item.title,
    source: `https://palworld.wiki.gg/wiki/File:${encodeURIComponent(item.title.replaceAll(" ", "_"))}`,
    sha1: info.sha1 ?? null,
    license,
  });
  await new Promise((done) => setTimeout(done, 120));
}

const fetchedAt = new Date().toISOString();
await writeFile(
  join(destination, "fallback-sources.json"),
  `${JSON.stringify({ fetchedAt, source: "palworld.wiki.gg", license, icons: provenance }, null, 2)}\n`,
  { mode: 0o644 },
);

const files = await readdir(destination);
let count = 0;
for (const file of files) {
  if (!/\.(?:png|webp)$/i.test(file)) continue;
  if ((await stat(join(destination, file))).size > 0) count++;
}
let existingSource = "paldeck.cc";
try {
  const current = JSON.parse(await readFile(join(destination, "dataset.json"), "utf8")) as { source?: unknown };
  if (typeof current.source === "string" && current.source.trim()) existingSource = current.source;
} catch {
  // A missing or malformed sidecar is safely replaced with fresh provenance.
}
const sources = [...new Set([...existingSource.split(" + "), "palworld.wiki.gg"])]
  .filter(Boolean)
  .join(" + ");
await writeFile(
  join(destination, "dataset.json"),
  `${JSON.stringify({ source: sources, fetched_at: fetchedAt, count }, null, 2)}\n`,
  { mode: 0o644 },
);

console.log(`installed ${provenance.length} supplemental icons in ${destination} (${count} total image files)`);
