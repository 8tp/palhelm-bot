import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  KNOWLEDGE_CORPUS_SCHEMA_VERSION,
  type KnowledgeCorpusDocument,
  type KnowledgeCorpusFile,
} from "../src/knowledge/corpus.js";
import { cleanWikitext } from "../src/knowledge/wikitext.js";

interface Options {
  apiUrl: string;
  articleBaseUrl: string;
  outputPath: string;
  sourceLabel: string;
  license: string;
  userAgent: string;
  delayMs: number;
  maxPages: number;
  namespace: number;
}

interface WikiPage {
  pageid?: number;
  title?: string;
  extract?: string;
  revisions?: Array<{
    revid?: number;
    timestamp?: string;
    slots?: { main?: { content?: string } };
  }>;
}

const options = parseOptions(process.argv.slice(2));
await ingest(options);

async function ingest(options: Options): Promise<void> {
  const previous = await readExisting(options.outputPath);
  const documents: KnowledgeCorpusDocument[] = [];
  let continuation: string | undefined;
  let fetchedPages = 0;

  do {
    const url = new URL(options.apiUrl);
    for (const [key, value] of Object.entries({
      action: "query",
      format: "json",
      formatversion: "2",
      generator: "allpages",
      gapnamespace: String(options.namespace),
      gaplimit: "20",
      prop: "revisions",
      rvslots: "main",
      rvprop: "ids|timestamp|content",
      gapfilterredir: "nonredirects",
      maxlag: "5",
    })) url.searchParams.set(key, value);
    if (continuation) url.searchParams.set("gapcontinue", continuation);

    const payload = await fetchJson(url, options.userAgent);
    const root = asRecord(payload);
    const query = asRecord(root?.query);
    const pages = Array.isArray(query?.pages) ? query.pages as WikiPage[] : [];
    for (const page of pages) {
      if (fetchedPages >= options.maxPages) break;
      const title = typeof page.title === "string" ? page.title.trim() : "";
      const revision = page.revisions?.[0];
      const wikitext = revision?.slots?.main?.content;
      const text = typeof wikitext === "string" ? cleanWikitext(wikitext) : "";
      if (!title || text.length < 80) continue;
      const retrievedAt = typeof revision?.timestamp === "string" ? revision.timestamp : new Date().toISOString();
      documents.push(...chunkArticle({
        pageId: page.pageid ?? 0,
        title,
        text,
        url: `${options.articleBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        sourceLabel: options.sourceLabel,
        license: options.license,
        revisionId: revision?.revid ?? null,
        retrievedAt,
      }));
      fetchedPages++;
    }
    console.log(`[knowledge] fetched ${fetchedPages}/${options.maxPages} pages (${documents.length} sections)`);
    if (fetchedPages >= options.maxPages) break;
    continuation = typeof asRecord(root?.continue)?.gapcontinue === "string"
      ? asRecord(root?.continue)!.gapcontinue as string
      : undefined;
    if (continuation) await delay(options.delayMs);
  } while (continuation);

  if (documents.length === 0) throw new Error("The wiki API returned no usable article text; previous corpus was preserved.");
  const merged = mergeDocuments(previous?.documents ?? [], documents, options.sourceLabel);
  const corpus: KnowledgeCorpusFile = {
    schemaVersion: KNOWLEDGE_CORPUS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    documents: merged,
  };
  await atomicWrite(options.outputPath, `${JSON.stringify(corpus)}\n`);
  console.log(`[knowledge] wrote ${merged.length} attributed sections to ${options.outputPath}`);
}

function chunkArticle(input: {
  pageId: number;
  title: string;
  text: string;
  url: string;
  sourceLabel: string;
  license: string;
  revisionId: number | null;
  retrievedAt: string;
}): KnowledgeCorpusDocument[] {
  const sections = splitSections(input.text);
  const output: KnowledgeCorpusDocument[] = [];
  let ordinal = 0;
  for (const section of sections) {
    for (const chunk of chunkText(section.text, 2_800, 240)) {
      output.push({
        id: `${input.pageId || slug(input.title)}:${ordinal++}`,
        title: input.title,
        section: section.heading,
        text: chunk,
        url: input.url,
        sourceLabel: input.sourceLabel,
        license: input.license,
        revisionId: input.revisionId,
        retrievedAt: input.retrievedAt,
        // Never claim a game version solely because an article is current.
        versionTags: [],
      });
    }
  }
  return output;
}

function splitSections(text: string): Array<{ heading: string; text: string }> {
  const lines = text.split(/\n/);
  const sections: Array<{ heading: string; text: string }> = [];
  let heading = "Overview";
  let body: string[] = [];
  const flush = () => {
    const value = body.join("\n").trim();
    if (value) sections.push({ heading, text: value });
    body = [];
  };
  for (const line of lines) {
    const match = line.match(/^\s*=+\s*(.+?)\s*=+\s*$/);
    if (match) {
      flush();
      heading = match[1]!.trim();
    } else body.push(line);
  }
  flush();
  return sections;
}

function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      chunks.push(current);
      const overlap = current.slice(Math.max(0, current.length - overlapChars));
      current = `${overlap}\n\n${paragraph}`;
    } else current = current ? `${current}\n\n${paragraph}` : paragraph;
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars - overlapChars);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function fetchJson(url: URL, userAgent: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal: controller.signal,
    });
    if (response.status === 429 || response.status === 503) {
      throw new Error(`Wiki API asked the importer to slow down (HTTP ${response.status}); rerun later to resume.`);
    }
    if (!response.ok) throw new Error(`Wiki API request failed with HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.toLocaleLowerCase("en-US").includes("json")) throw new Error("Wiki API returned a non-JSON response");
    const payload: unknown = await response.json();
    const apiError = asRecord(asRecord(payload)?.error);
    if (apiError) {
      const code = typeof apiError.code === "string" ? apiError.code : "unknown";
      throw new Error(`Wiki API returned an application error (${code})`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function parseOptions(args: string[]): Options {
  const value = (name: string, fallback?: string): string => {
    const index = args.indexOf(`--${name}`);
    const result = index >= 0 ? args[index + 1] : fallback;
    if (!result || result.startsWith("--")) throw new Error(`Missing --${name}`);
    return result;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const result = Number(value(name, String(fallback)));
    if (!Number.isInteger(result) || result < min || result > max) throw new Error(`--${name} must be ${min}-${max}`);
    return result;
  };
  return {
    apiUrl: value("api", "https://palworld.wiki.gg/api.php"),
    articleBaseUrl: value("article-base", "https://palworld.wiki.gg/wiki"),
    outputPath: resolve(value("output", "data/general-knowledge-corpus.json")),
    sourceLabel: value("source", "The Palworld Wiki"),
    license: value("license", "CC BY-SA 4.0"),
    userAgent: value("user-agent", process.env.PALHELM_CORPUS_USER_AGENT),
    delayMs: integer("delay-ms", 1_250, 500, 60_000),
    maxPages: integer("max-pages", 100, 1, 50_000),
    namespace: integer("namespace", 0, 0, 10_000),
  };
}

async function readExisting(path: string): Promise<KnowledgeCorpusFile | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as KnowledgeCorpusFile;
    return value.schemaVersion === KNOWLEDGE_CORPUS_SCHEMA_VERSION && Array.isArray(value.documents) ? value : null;
  } catch {
    return null;
  }
}

function mergeDocuments(existing: KnowledgeCorpusDocument[], incoming: KnowledgeCorpusDocument[], sourceLabel: string): KnowledgeCorpusDocument[] {
  const refreshedTitles = new Set(incoming.map((document) => document.title));
  const retained = existing.filter((document) =>
    document.sourceLabel !== sourceLabel || !refreshedTitles.has(document.title));
  return [...retained, ...incoming].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function slug(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
