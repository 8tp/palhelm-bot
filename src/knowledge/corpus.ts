import { readFile } from "node:fs/promises";

export const KNOWLEDGE_CORPUS_SCHEMA_VERSION = 1;

export interface KnowledgeCorpusDocument {
  id: string;
  title: string;
  section: string;
  text: string;
  url: string;
  sourceLabel: string;
  license: string;
  revisionId: number | null;
  retrievedAt: string;
  versionTags: string[];
}

export interface KnowledgeCorpusFile {
  schemaVersion: typeof KNOWLEDGE_CORPUS_SCHEMA_VERSION;
  generatedAt: string;
  documents: KnowledgeCorpusDocument[];
}

export interface KnowledgeCorpusMatch extends KnowledgeCorpusDocument {
  score: number;
}

/**
 * Restart-safe, dependency-free full-text index for the local Palworld field guide.
 *
 * The corpus is loaded once and searched locally. BM25 keeps broad articles from
 * winning merely because they repeat common words, while exact title/section
 * matches get a small deterministic boost.
 */
export class KnowledgeCorpus {
  private documents: IndexedDocument[] = [];
  private documentFrequency = new Map<string, number>();
  private averageLength = 1;
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  async search(query: string, limit = 5): Promise<KnowledgeCorpusMatch[]> {
    await this.init();
    const terms = unique(tokenize(query));
    if (terms.length === 0 || this.documents.length === 0) return [];
    const scoringTerms = unique([...terms, ...queryExpansions(terms)]);
    const phrase = normalize(query);
    const wantsHistory = /\b(history|historical|patch|update|version|changelog|release|introduced|removed)\b/.test(phrase) ||
      /\b(?:0|1)\.\d+(?:\.\d+){0,2}\b/.test(phrase);
    const count = this.documents.length;
    const scored = this.documents.map((document) => {
      let score = 0;
      for (const term of scoringTerms) {
        const frequency = document.termFrequency.get(term) ?? 0;
        if (frequency === 0) continue;
        const seenIn = this.documentFrequency.get(term) ?? 0;
        const inverseFrequency = Math.log(1 + (count - seenIn + 0.5) / (seenIn + 0.5));
        const normalizedLength = 1.2 * (0.25 + 0.75 * document.length / this.averageLength);
        score += inverseFrequency * (frequency * 2.2) / (frequency + normalizedLength);
      }
      const heading = normalize(`${document.data.title} ${document.data.section}`);
      if (phrase && heading === phrase) score += 8;
      else if (phrase && heading.includes(phrase)) score += 4;
      const titleTerms = new Set(tokenize(document.data.title));
      for (const term of scoringTerms.filter((candidate) => titleTerms.has(candidate) && !TITLE_BOOST_STOP_WORDS.has(candidate))) {
        const seenIn = this.documentFrequency.get(term) ?? 0;
        score += 6 + Math.log(1 + (count - seenIn + 0.5) / (seenIn + 0.5)) * 4;
      }
      const coverage = terms.filter((term) => document.termFrequency.has(term)).length / terms.length;
      if (coverage === 1) score += 2;
      if (!wantsHistory && isHistoricalOrLowValue(document.data)) score *= 0.05;
      return { document, score, coverage };
    });
    return scored
      .filter(({ score, coverage }) => score > 0 && (coverage >= 0.4 || terms.length === 1))
      .sort((a, b) => b.score - a.score || a.document.data.title.localeCompare(b.document.data.title))
      .slice(0, Math.max(1, Math.min(limit, 8)))
      .map(({ document, score }) => ({ ...document.data, score: Number(score.toFixed(3)) }));
  }

  status(): { available: boolean; documentCount: number; path: string } {
    return { available: this.documents.length > 0, documentCount: this.documents.length, path: this.path };
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isCorpusFile(parsed)) throw new Error("unsupported knowledge corpus schema");
      this.documents = parsed.documents.map(indexDocument);
      this.documentFrequency.clear();
      let totalLength = 0;
      for (const document of this.documents) {
        totalLength += document.length;
        for (const term of document.termFrequency.keys()) {
          this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
        }
      }
      this.averageLength = this.documents.length > 0 ? totalLength / this.documents.length : 1;
    } catch {
      // Missing/corrupt optional corpora degrade to the built-in field guide.
      this.documents = [];
      this.documentFrequency.clear();
      this.averageLength = 1;
    }
  }
}

function queryExpansions(terms: string[]): string[] {
  const expanded: string[] = [];
  if (terms.some((term) => term.startsWith("reviv") || term === "incapacitated")) {
    expanded.push("injury", "affliction", "palbox");
  }
  return expanded;
}

function isHistoricalOrLowValue(document: KnowledgeCorpusDocument): boolean {
  const heading = normalize(document.section);
  const title = normalize(document.title);
  return /^(history|gallery|media|references|notes|trivia|changelog)$/.test(heading) ||
    /\b(patch notes|early access patch|xbox update)\b/.test(`${title} ${heading}`) ||
    /^0 \d+ \d+ \d+/.test(title);
}

interface IndexedDocument {
  data: KnowledgeCorpusDocument;
  termFrequency: Map<string, number>;
  length: number;
}

function indexDocument(data: KnowledgeCorpusDocument): IndexedDocument {
  const tokens = tokenize(`${data.title} ${data.title} ${data.section} ${data.section} ${data.text}`);
  const termFrequency = new Map<string, number>();
  for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  return { data, termFrequency, length: Math.max(1, tokens.length) };
}

function tokenize(value: string): string[] {
  return normalize(value).split(" ")
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
    .map((term) => term.length > 3 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isCorpusFile(value: unknown): value is KnowledgeCorpusFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  return root.schemaVersion === KNOWLEDGE_CORPUS_SCHEMA_VERSION &&
    typeof root.generatedAt === "string" && Array.isArray(root.documents) &&
    root.documents.every(isDocument);
}

function isDocument(value: unknown): value is KnowledgeCorpusDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  return ["id", "title", "section", "text", "url", "sourceLabel", "license", "retrievedAt"]
    .every((key) => typeof document[key] === "string") &&
    (document.revisionId === null || typeof document.revisionId === "number") &&
    Array.isArray(document.versionTags) && document.versionTags.every((tag) => typeof tag === "string");
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "how", "in", "is",
  "it", "of", "on", "or", "palworld", "that", "the", "this", "to", "what", "when", "where",
  "which", "with", "you", "your",
]);

const TITLE_BOOST_STOP_WORDS = new Set(["pal", "pals", "guide", "overview"]);
