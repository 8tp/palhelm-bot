import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PSP_COMMIT = "e46188978a13e74d84c9a1ce5569497ee0555cae";
const PALCALC_COMMIT = "b5e13e90fedc2e95d54fa223da77be464c313001";
const RAW = "https://raw.githubusercontent.com";

export interface PalKnowledgeSourceUrls {
  pspPals: string;
  pspEnglishPals: string;
  pspEnglishElements: string;
  pspEnglishWork: string;
  palCalcDb: string;
  palCalcBreeding: string;
}

export const DEFAULT_PAL_KNOWLEDGE_URLS: PalKnowledgeSourceUrls = {
  pspPals: `${RAW}/oMaN-Rod/palworld-save-pal/${PSP_COMMIT}/data/json/pals.json`,
  pspEnglishPals: `${RAW}/oMaN-Rod/palworld-save-pal/${PSP_COMMIT}/data/json/l10n/en/pals.json`,
  pspEnglishElements: `${RAW}/oMaN-Rod/palworld-save-pal/${PSP_COMMIT}/data/json/l10n/en/elements.json`,
  pspEnglishWork: `${RAW}/oMaN-Rod/palworld-save-pal/${PSP_COMMIT}/data/json/l10n/en/work_suitability.json`,
  palCalcDb: `${RAW}/tylercamp/palcalc/${PALCALC_COMMIT}/PalCalc.Model/db.json`,
  palCalcBreeding: `${RAW}/tylercamp/palcalc/${PALCALC_COMMIT}/PalCalc.Model/breeding.json`,
};

export interface KnowledgeSource {
  name: "Palworld Save Pal" | "PalCalc";
  version: string;
  url: string;
  attribution: string;
}

export interface KnowledgeMetadata {
  schemaVersion: 2;
  generatedAt: string;
  sources: KnowledgeSource[];
}

export interface PalWorkSuitability {
  id: string;
  name: string;
  level: number;
}

export interface PalKnowledge {
  internalId: string;
  name: string;
  dexNumber: number;
  isVariant: boolean;
  elements: string[];
  workSuitabilities: PalWorkSuitability[];
  learnset: Array<{
    id: string;
    name: string;
    unlockLevel: number;
    element: string | null;
    power: number;
    cooldownSeconds: number;
    hasSkillFruit: boolean;
    inheritable: boolean;
  }>;
  guaranteedPassives: Array<{
    id: string;
    name: string;
    rank: number;
    inheritable: boolean;
  }>;
  hp: number;
  attack: number;
  defense: number;
  rarity: number;
  breedingPower: number;
  minWildLevel: number;
  maxWildLevel: number;
  size: string;
  nocturnal: boolean;
  walkSpeed: number;
  runSpeed: number;
  rideSprintSpeed: number;
  transportSpeed: number;
  stamina: number;
  foodAmount: number;
  maxFullStomach: number;
  price: number;
}

export type PalGender = "WILDCARD" | "OPPOSITE_WILDCARD" | "MALE" | "FEMALE";

interface BreedingRow {
  parent1: string;
  parent1Gender: PalGender;
  parent2: string;
  parent2Gender: PalGender;
  child: string;
}

export interface BreedingOutcome {
  parent1: PalKnowledge;
  parent1Gender: PalGender;
  parent2: PalKnowledge;
  parent2Gender: PalGender;
  child: PalKnowledge;
}

export interface BreedingStep {
  parent1: PalKnowledge;
  parent1Gender: PalGender;
  parent2: PalKnowledge;
  parent2Gender: PalGender;
  child: PalKnowledge;
  parent1Owned: boolean;
  parent2Owned: boolean;
}

export interface BreedingPath {
  target: PalKnowledge;
  /** The target species is already present in the owned set. */
  alreadyOwned: boolean;
  /** A chain from owned species exists (true even when alreadyOwned). */
  reachable: boolean;
  /** Ordered so each step's parents are owned or produced by an earlier step. */
  steps: BreedingStep[];
}

export interface KnowledgeResult<T> {
  data: T;
  metadata: KnowledgeMetadata;
}

export interface PalKnowledgeStatus {
  ready: boolean;
  palCount: number;
  breedingCombinationCount: number;
  metadata: KnowledgeMetadata | null;
}

interface NormalizedCache {
  metadata: KnowledgeMetadata;
  pals: PalKnowledge[];
  breeding: BreedingRow[];
}

export interface PalKnowledgeServiceOptions {
  sourceUrls?: Partial<PalKnowledgeSourceUrls>;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

const LIMITS: Record<keyof PalKnowledgeSourceUrls, number> = {
  pspPals: 3 * 1024 * 1024,
  pspEnglishPals: 3 * 1024 * 1024,
  pspEnglishElements: 3 * 1024 * 1024,
  pspEnglishWork: 3 * 1024 * 1024,
  palCalcDb: 3 * 1024 * 1024,
  palCalcBreeding: 15 * 1024 * 1024,
};

export class PalKnowledgeService {
  private cache: NormalizedCache | null = null;
  private loadInFlight: Promise<void> | null = null;
  private readonly urls: PalKnowledgeSourceUrls;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(
    private readonly cachePath: string,
    options: PalKnowledgeServiceOptions = {},
  ) {
    this.urls = { ...DEFAULT_PAL_KNOWLEDGE_URLS, ...options.sourceUrls };
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  init(): Promise<void> {
    if (this.cache) return Promise.resolve();
    if (this.loadInFlight) return this.loadInFlight;
    const pending = this.load();
    this.loadInFlight = pending;
    void pending.finally(() => {
      if (this.loadInFlight === pending) this.loadInFlight = null;
    }).catch(() => {});
    return pending;
  }

  status(): PalKnowledgeStatus {
    return {
      ready: this.cache !== null,
      palCount: this.cache?.pals.length ?? 0,
      breedingCombinationCount: this.cache?.breeding.length ?? 0,
      metadata: this.cache?.metadata ?? null,
    };
  }

  search(query: string, limit = 10): KnowledgeResult<PalKnowledge[]> {
    const cache = this.requireCache();
    const needle = query.trim().toLocaleLowerCase("en-US");
    const capped = Math.max(1, Math.min(50, Math.trunc(limit) || 10));
    const ranked = cache.pals
      .map((pal) => ({ pal, rank: matchRank(pal, needle) }))
      .filter((item) => item.rank < 4)
      .sort((a, b) => a.rank - b.rank || a.pal.dexNumber - b.pal.dexNumber || a.pal.name.localeCompare(b.pal.name))
      .slice(0, capped)
      .map((item) => item.pal);
    return this.result(ranked);
  }

  /** Complete canonical catalogue, ordered by Paldeck number. */
  list(): KnowledgeResult<PalKnowledge[]> {
    const cache = this.requireCache();
    return this.result([...cache.pals].sort(
      (a, b) => a.dexNumber - b.dexNumber || Number(a.isVariant) - Number(b.isVariant) || a.name.localeCompare(b.name),
    ));
  }

  get(query: string): KnowledgeResult<PalKnowledge | null> {
    return this.result(this.resolve(query));
  }

  /** Exact-only lookup for save joins and claim validation; never fuzzy-matches. */
  getExact(query: string): KnowledgeResult<PalKnowledge | null> {
    const cache = this.requireCache();
    const needle = query.trim().toLocaleLowerCase("en-US");
    return this.result(cache.pals.find((pal) =>
      pal.internalId.toLocaleLowerCase("en-US") === needle ||
      pal.name.toLocaleLowerCase("en-US") === needle,
    ) ?? null);
  }

  breed(parent1: string, parent2: string): KnowledgeResult<BreedingOutcome[]> {
    const cache = this.requireCache();
    const first = this.resolve(parent1);
    const second = this.resolve(parent2);
    if (!first || !second) return this.result([]);
    const pals = new Map(cache.pals.map((pal) => [pal.internalId.toLowerCase(), pal]));
    const a = first.internalId.toLowerCase();
    const b = second.internalId.toLowerCase();
    return this.result(cache.breeding
      .filter((row) => {
        const p1 = row.parent1.toLowerCase();
        const p2 = row.parent2.toLowerCase();
        return (p1 === a && p2 === b) || (p1 === b && p2 === a);
      })
      .map((row) => outcome(row, pals))
      .filter((value): value is BreedingOutcome => value !== null));
  }

  parentsFor(child: string, limit = 20): KnowledgeResult<BreedingOutcome[]> {
    const cache = this.requireCache();
    const resolved = this.resolve(child);
    if (!resolved) return this.result([]);
    const pals = new Map(cache.pals.map((pal) => [pal.internalId.toLowerCase(), pal]));
    const capped = Math.max(1, Math.min(500, Math.trunc(limit) || 20));
    return this.result(cache.breeding
      .filter((row) => row.child.toLowerCase() === resolved.internalId.toLowerCase())
      .slice(0, capped)
      .map((row) => outcome(row, pals))
      .filter((value): value is BreedingOutcome => value !== null));
  }

  /**
   * Shortest breeding chain to `child` from the `owned` species set (lowercased
   * internal IDs), minimizing total breeding steps. Solved as a shortest
   * hyperpath: a species is producible once both its recipe parents are, so its
   * cost is `cost(parent1) + cost(parent2) + 1`. Owned species cost 0.
   */
  breedingPath(child: string, owned: Set<string>): KnowledgeResult<BreedingPath | null> {
    const cache = this.requireCache();
    const target = this.resolve(child);
    if (!target) return this.result(null);
    const pals = new Map(cache.pals.map((pal) => [pal.internalId.toLowerCase(), pal]));
    const targetId = target.internalId.toLowerCase();
    if (owned.has(targetId)) {
      return this.result({ target, alreadyOwned: true, reachable: true, steps: [] });
    }

    // Index recipes by each parent so a child can be relaxed as soon as both
    // parents are finalized. Store canonical (p1,p2) so reconstruction is stable.
    const recipesByParent = new Map<string, Array<{ other: string; child: string; p1: string; p2: string; g1: PalGender; g2: PalGender }>>();
    for (const row of cache.breeding) {
      const p1 = row.parent1.toLowerCase();
      const p2 = row.parent2.toLowerCase();
      const c = row.child.toLowerCase();
      if (!pals.has(p1) || !pals.has(p2) || !pals.has(c)) continue;
      (recipesByParent.get(p1) ?? recipesByParent.set(p1, []).get(p1)!).push({ other: p2, child: c, p1, p2, g1: row.parent1Gender, g2: row.parent2Gender });
      if (p2 !== p1) {
        (recipesByParent.get(p2) ?? recipesByParent.set(p2, []).get(p2)!).push({ other: p1, child: c, p1, p2, g1: row.parent1Gender, g2: row.parent2Gender });
      }
    }

    const cost = new Map<string, number>();
    const best = new Map<string, { p1: string; p2: string; g1: PalGender; g2: PalGender }>();
    const finalized = new Set<string>();
    for (const id of owned) if (pals.has(id)) cost.set(id, 0);

    // O(V^2) extract-min is ample for ~300 species; avoids a heap dependency.
    for (;;) {
      let u: string | null = null;
      let min = Infinity;
      for (const [id, value] of cost) {
        if (!finalized.has(id) && value < min) { min = value; u = id; }
      }
      if (u === null) break;
      finalized.add(u);
      if (u === targetId) break;
      for (const recipe of recipesByParent.get(u) ?? []) {
        if (recipe.other !== u && !finalized.has(recipe.other)) continue;
        const candidate = min + (cost.get(recipe.other) ?? Infinity) + 1;
        if (candidate < (cost.get(recipe.child) ?? Infinity)) {
          cost.set(recipe.child, candidate);
          best.set(recipe.child, { p1: recipe.p1, p2: recipe.p2, g1: recipe.g1, g2: recipe.g2 });
        }
      }
    }

    if (!cost.has(targetId)) {
      return this.result({ target, alreadyOwned: false, reachable: false, steps: [] });
    }

    const steps: BreedingStep[] = [];
    const emitted = new Set<string>();
    const build = (id: string): void => {
      if (owned.has(id) || emitted.has(id)) return;
      const recipe = best.get(id);
      if (!recipe) return;
      build(recipe.p1);
      build(recipe.p2);
      if (emitted.has(id)) return;
      emitted.add(id);
      steps.push({
        parent1: pals.get(recipe.p1)!,
        parent1Gender: recipe.g1,
        parent2: pals.get(recipe.p2)!,
        parent2Gender: recipe.g2,
        child: pals.get(id)!,
        parent1Owned: owned.has(recipe.p1),
        parent2Owned: owned.has(recipe.p2),
      });
    };
    build(targetId);
    return this.result({ target, alreadyOwned: false, reachable: true, steps });
  }

  private async load(): Promise<void> {
    try {
      const disk = validateCache(JSON.parse(await readFile(this.cachePath, "utf8")));
      this.cache = disk;
      return;
    } catch {
      // Missing or malformed cache: rebuild from immutable, version-pinned sources.
    }

    let normalized: NormalizedCache;
    try {
      normalized = await this.fetchAndNormalize();
    } catch (networkError) {
      // A last-good cache may have appeared between the first read and failure
      // (for example, another process completed an atomic refresh).
      try {
        this.cache = validateCache(JSON.parse(await readFile(this.cachePath, "utf8")));
        return;
      } catch {
        throw networkError;
      }
    }
    await this.persist(normalized);
    this.cache = normalized;
  }

  private async fetchAndNormalize(): Promise<NormalizedCache> {
    const keys = Object.keys(this.urls) as Array<keyof PalKnowledgeSourceUrls>;
    const values = await Promise.all(keys.map(async (key) => [
      key,
      JSON.parse(await this.fetchJson(this.urls[key], LIMITS[key])),
    ] as const));
    const source = Object.fromEntries(values) as Record<keyof PalKnowledgeSourceUrls, unknown>;
    return normalize(source, this.urls, this.now());
  }

  private async fetchJson(url: string, maxBytes: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Palhelm-Discord-Bot/0.1 (public Pal knowledge cache)",
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`knowledge source HTTP ${response.status}`);
      return await boundedText(response, maxBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  private async persist(cache: NormalizedCache): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const temp = `${this.cachePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.cachePath);
  }

  private requireCache(): NormalizedCache {
    if (!this.cache) throw new Error("Pal knowledge is not initialized");
    return this.cache;
  }

  private resolve(query: string): PalKnowledge | null {
    const cache = this.requireCache();
    const needle = query.trim().toLocaleLowerCase("en-US");
    const exact = cache.pals.find((pal) =>
      pal.internalId.toLocaleLowerCase("en-US") === needle ||
      pal.name.toLocaleLowerCase("en-US") === needle,
    );
    if (exact) return exact;
    return cache.pals
      .filter((pal) => matchRank(pal, needle) < 4)
      .sort((a, b) => matchRank(a, needle) - matchRank(b, needle) || a.dexNumber - b.dexNumber)[0] ?? null;
  }

  private result<T>(data: T): KnowledgeResult<T> {
    return { data, metadata: this.requireCache().metadata };
  }
}

function normalize(
  source: Record<keyof PalKnowledgeSourceUrls, unknown>,
  urls: PalKnowledgeSourceUrls,
  now: Date,
): NormalizedCache {
  const psp = record(source.pspPals);
  const names = record(source.pspEnglishPals);
  const elementNames = record(source.pspEnglishElements);
  const workNames = record(source.pspEnglishWork);
  const db = record(source.palCalcDb);
  const breedingDb = record(source.palCalcBreeding);
  if (!psp || !names || !elementNames || !workNames || !db || !breedingDb) throw new Error("invalid knowledge source");
  const palCalcPals = Array.isArray(db.Pals) ? db.Pals : [];
  const skills = new Map<string, {
    name: string;
    element: string | null;
    power: number;
    cooldownSeconds: number;
    hasSkillFruit: boolean;
    inheritable: boolean;
  }>();
  for (const raw of Array.isArray(db.ActiveSkills) ? db.ActiveSkills : []) {
    const skill = record(raw);
    if (typeof skill?.InternalName === "string" && typeof skill.Name === "string") {
      const rawElement = typeof skill.ElementInternalName === "string" ? skill.ElementInternalName : null;
      skills.set(skill.InternalName.toLowerCase(), {
        name: skill.Name,
        element: rawElement ? localizedPalCalcElement(db.Elements, rawElement) ?? rawElement : null,
        power: number(skill.Power),
        cooldownSeconds: number(skill.CooldownSeconds),
        hasSkillFruit: skill.HasSkillFruit === true,
        inheritable: skill.CanInherit === true,
      });
    }
  }
  const passives = new Map<string, { name: string; rank: number; inheritable: boolean }>();
  for (const raw of Array.isArray(db.PassiveSkills) ? db.PassiveSkills : []) {
    const passive = record(raw);
    if (typeof passive?.InternalName === "string" && typeof passive.Name === "string") {
      passives.set(passive.InternalName.toLowerCase(), {
        name: passive.Name,
        rank: number(passive.Rank),
        inheritable: passive.RandomInheritanceAllowed === true,
      });
    }
  }
  const pspIndex = new Map<string, Record<string, unknown>>();
  for (const [key, raw] of Object.entries(psp)) {
    const row = record(raw);
    if (!row) continue;
    pspIndex.set(key.toLowerCase(), row);
    if (typeof row.tribe === "string") pspIndex.set(row.tribe.toLowerCase(), row);
  }

  const pals: PalKnowledge[] = [];
  const idByPalId = new Map<string, string>();
  for (const raw of palCalcPals) {
    const pc = record(raw);
    const id = record(pc?.Id);
    if (!pc || !id || typeof pc.InternalName !== "string" || typeof pc.Name !== "string") continue;
    const matched = pspIndex.get(pc.InternalName.toLowerCase());
    const pspName = localizedName(names, pc.InternalName) ?? (matched && typeof matched.tribe === "string" ? localizedName(names, matched.tribe) : null);
    const work = record(matched?.work_suitability) ?? record(pc.WorkSuitability) ?? {};
    const scaling = record(matched?.scaling);
    const skillSet = record(matched?.skill_set) ?? {};
    const elements = Array.isArray(matched?.element_types)
      ? matched.element_types.filter((value): value is string => typeof value === "string").map((value) => localizedName(elementNames, value) ?? value)
      : [];
    const normalized: PalKnowledge = {
      internalId: pc.InternalName,
      name: pspName ?? pc.Name,
      dexNumber: number(id.PalDexNo),
      isVariant: id.IsVariant === true,
      elements,
      workSuitabilities: Object.entries(work)
        .filter(([, level]) => number(level) > 0)
        .map(([workId, level]) => ({ id: workId, name: localizedName(workNames, workId) ?? palCalcWorkName(workId), level: number(level) })),
      learnset: Object.entries(skillSet)
        .filter(([, level]) => number(level) > 0)
        .map(([skillId, level]) => {
          const detail = skills.get(skillId.toLowerCase());
          return {
            id: skillId,
            name: detail?.name ?? skillId,
            unlockLevel: number(level),
            element: detail?.element ?? null,
            power: detail?.power ?? 0,
            cooldownSeconds: detail?.cooldownSeconds ?? 0,
            hasSkillFruit: detail?.hasSkillFruit ?? false,
            inheritable: detail?.inheritable ?? false,
          };
        })
        .sort((a, b) => a.unlockLevel - b.unlockLevel || a.name.localeCompare(b.name))
        .slice(0, 100),
      guaranteedPassives: (Array.isArray(pc.GuaranteedPassivesInternalIds) ? pc.GuaranteedPassivesInternalIds : [])
        .filter((value): value is string => typeof value === "string")
        .map((passiveId) => {
          const detail = passives.get(passiveId.toLowerCase());
          return {
            id: passiveId,
            name: detail?.name ?? passiveId,
            rank: detail?.rank ?? 0,
            inheritable: detail?.inheritable ?? false,
          };
        })
        .slice(0, 20),
      hp: number(scaling?.hp ?? pc.Hp),
      attack: number(scaling?.attack ?? pc.Attack),
      defense: number(scaling?.defense ?? pc.Defense),
      rarity: number(matched?.rarity ?? pc.Rarity),
      breedingPower: number(pc.BreedingPower),
      minWildLevel: number(pc.MinWildLevel),
      maxWildLevel: number(pc.MaxWildLevel),
      size: typeof pc.Size === "string" ? pc.Size : "Unknown",
      nocturnal: pc.Nocturnal === true,
      walkSpeed: number(pc.WalkSpeed),
      runSpeed: number(pc.RunSpeed),
      rideSprintSpeed: number(pc.RideSprintSpeed),
      transportSpeed: number(pc.TransportSpeed),
      stamina: number(pc.Stamina),
      foodAmount: number(pc.FoodAmount),
      maxFullStomach: number(pc.MaxFullStomach),
      price: number(pc.Price),
    };
    pals.push(normalized);
    idByPalId.set(palIdKey(id), normalized.internalId);
  }

  const rawBreeding = Array.isArray(breedingDb.Breeding) ? breedingDb.Breeding : [];
  const breeding: BreedingRow[] = [];
  for (const raw of rawBreeding) {
    const row = record(raw);
    const p1 = idByPalId.get(palIdKey(record(row?.Parent1ID)));
    const p2 = idByPalId.get(palIdKey(record(row?.Parent2ID)));
    const child = idByPalId.get(palIdKey(record(row?.ChildID)));
    if (!row || !p1 || !p2 || !child) continue;
    breeding.push({
      parent1: p1,
      parent1Gender: gender(row.Parent1Gender),
      parent2: p2,
      parent2Gender: gender(row.Parent2Gender),
      child,
    });
  }
  if (pals.length === 0 || breeding.length === 0) throw new Error("empty knowledge source");

  return {
    metadata: {
      schemaVersion: 2,
      generatedAt: now.toISOString(),
      sources: [
        { name: "Palworld Save Pal", version: PSP_COMMIT, url: urls.pspPals, attribution: "Data extracted by oMaN-Rod/palworld-save-pal" },
        { name: "PalCalc", version: PALCALC_COMMIT, url: urls.palCalcDb, attribution: "PalCalc © Tyler Camp, MIT; generated from Palworld game data" },
      ],
    },
    pals,
    breeding,
  };
}

function validateCache(value: unknown): NormalizedCache {
  const cache = record(value);
  const metadata = record(cache?.metadata);
  if (metadata?.schemaVersion !== 2 || !Array.isArray(cache?.pals) || !Array.isArray(cache?.breeding)) {
    throw new Error("invalid knowledge cache");
  }
  return value as NormalizedCache;
}

function localizedPalCalcElement(value: unknown, internalName: string): string | null {
  const elements = Array.isArray(value) ? value : [];
  for (const raw of elements) {
    const element = record(raw);
    if (typeof element?.InternalName === "string" && element.InternalName.toLowerCase() === internalName.toLowerCase()) {
      return typeof element.Name === "string" ? element.Name : null;
    }
  }
  return null;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("knowledge source response too large");
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function outcome(row: BreedingRow, pals: Map<string, PalKnowledge>): BreedingOutcome | null {
  const parent1 = pals.get(row.parent1.toLowerCase());
  const parent2 = pals.get(row.parent2.toLowerCase());
  const child = pals.get(row.child.toLowerCase());
  return parent1 && parent2 && child ? {
    parent1, parent1Gender: row.parent1Gender,
    parent2, parent2Gender: row.parent2Gender,
    child,
  } : null;
}

function matchRank(pal: PalKnowledge, needle: string): number {
  if (!needle) return 3;
  const id = pal.internalId.toLocaleLowerCase("en-US");
  const name = pal.name.toLocaleLowerCase("en-US");
  if (id === needle || name === needle) return 0;
  if (id.startsWith(needle) || name.startsWith(needle)) return 1;
  if (id.includes(needle) || name.includes(needle)) return 2;
  return 4;
}

function localizedName(table: Record<string, unknown>, key: string): string | null {
  const direct = record(table[key]) ?? Object.entries(table).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1];
  const row = record(direct);
  return typeof row?.localized_name === "string" ? row.localized_name : null;
}

function palCalcWorkName(id: string): string {
  const names: Record<string, string> = { GenerateElectricity: "Generating Electricity", MedicineProduction: "Medicine Production" };
  return names[id] ?? id;
}

function palIdKey(id: Record<string, unknown> | null): string {
  return id ? `${number(id.PalDexNo)}:${id.IsVariant === true ? 1 : 0}` : "";
}

function gender(value: unknown): PalGender {
  return value === "MALE" || value === "FEMALE" || value === "OPPOSITE_WILDCARD" ? value : "WILDCARD";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
