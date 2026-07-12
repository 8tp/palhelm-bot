import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorldSnapshot } from "../snapshots/service.js";
import { baseCharacterId, isBossVariant, palOwnerLabel } from "../pals/presentation.js";

export type GoalVariant = "any" | "alpha" | "lucky" | "boss";

export interface PalGoal {
  id: string;
  createdBy: string;
  createdByName: string;
  speciesId: string;
  speciesName: string;
  variant: GoalVariant;
  createdAt: string;
  baselineInstances: string[];
}

export interface GoalCompletion {
  goal: PalGoal;
  completedAt: string;
  pal: { instanceId: string; level: number; ownerName: string };
}

interface GoalState {
  version: 2;
  nextId: number;
  active: PalGoal[];
  pending: GoalCompletion[];
  completed: GoalCompletion[];
  lastCapturedAt: string | null;
  /** Every stable instance observed by this service, including pals currently absent. */
  observedInstances: Record<string, true>;
}

const MAX_ACTIVE = 50;
const MAX_PER_USER = 10;
const MAX_COMPLETED = 100;

export class GoalService {
  private state: GoalState | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly statePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async init(): Promise<void> {
    await this.withLock(async () => {
      if (this.state) return;
      try {
        this.state = validateState(JSON.parse(await readFile(this.statePath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = emptyState();
        await this.persist();
      }
    });
  }

  list(createdBy?: string): PalGoal[] {
    return (this.requireState().active)
      .filter((goal) => createdBy === undefined || goal.createdBy === createdBy)
      .map((goal) => structuredClone(goal));
  }

  async add(input: {
    createdBy: string;
    createdByName: string;
    speciesId: string;
    speciesName: string;
    variant: GoalVariant;
    snapshot: WorldSnapshot;
  }): Promise<PalGoal> {
    return this.withLock(async () => {
      const state = this.requireState();
      if (state.active.length >= MAX_ACTIVE) throw new Error("goal_limit");
      if (state.active.filter((goal) => goal.createdBy === input.createdBy).length >= MAX_PER_USER) {
        throw new Error("user_goal_limit");
      }
      const speciesId = baseCharacterId(input.speciesId);
      const duplicate = state.active.find((goal) =>
        goal.createdBy === input.createdBy &&
        goal.speciesId.toLowerCase() === speciesId.toLowerCase() &&
        goal.variant === input.variant,
      );
      if (duplicate) throw new Error("duplicate_goal");
      const already = input.snapshot.pals.filter((pal) =>
        baseCharacterId(pal.characterId).toLowerCase() === speciesId.toLowerCase() &&
        matchesVariant(pal, input.variant),
      );
      if (already.length > 0) throw new Error("already_observed");
      for (const pal of input.snapshot.pals) state.observedInstances[pal.instanceId] = true;
      const goal: PalGoal = {
        id: String(state.nextId++),
        createdBy: input.createdBy,
        createdByName: input.createdByName,
        speciesId,
        speciesName: input.speciesName,
        variant: input.variant,
        createdAt: this.now().toISOString(),
        baselineInstances: input.snapshot.pals
          .filter((pal) => baseCharacterId(pal.characterId).toLowerCase() === speciesId.toLowerCase())
          .map((pal) => pal.instanceId),
      };
      state.active.push(goal);
      await this.persist();
      return structuredClone(goal);
    });
  }

  async remove(id: string, createdBy: string): Promise<boolean> {
    return this.withLock(async () => {
      const state = this.requireState();
      const index = state.active.findIndex((goal) => goal.id === id && goal.createdBy === createdBy);
      if (index < 0) return false;
      state.active.splice(index, 1);
      await this.persist();
      return true;
    });
  }

  async observe(snapshot: WorldSnapshot): Promise<GoalCompletion[]> {
    return this.withLock(async () => {
      const state = this.requireState();
      if (state.lastCapturedAt === snapshot.capturedAt) return [];
      const completions: GoalCompletion[] = [];
      const remaining: PalGoal[] = [];
      const previouslyObserved = new Set(Object.keys(state.observedInstances));
      for (const goal of state.active) {
        const baseline = new Set(goal.baselineInstances);
        const pal = snapshot.pals.find((candidate) =>
          !baseline.has(candidate.instanceId) &&
          !previouslyObserved.has(candidate.instanceId) &&
          baseCharacterId(candidate.characterId).toLowerCase() === goal.speciesId.toLowerCase() &&
          matchesVariant(candidate, goal.variant),
        );
        if (!pal) {
          remaining.push(goal);
          continue;
        }
        completions.push({
          goal,
          completedAt: this.now().toISOString(),
          pal: {
            instanceId: pal.instanceId,
            level: pal.level,
            ownerName: palOwnerLabel(pal, snapshot.players),
          },
        });
      }
      state.active = remaining;
      state.pending.push(...completions);
      state.completed.push(...completions);
      state.completed = state.completed.slice(-MAX_COMPLETED);
      for (const pal of snapshot.pals) state.observedInstances[pal.instanceId] = true;
      state.lastCapturedAt = snapshot.capturedAt;
      await this.persist();
      return structuredClone(completions);
    });
  }

  nextPending(): GoalCompletion | null {
    return structuredClone(this.requireState().pending[0] ?? null);
  }

  async ackPending(goalId: string): Promise<void> {
    await this.withLock(async () => {
      const state = this.requireState();
      if (state.pending[0]?.goal.id !== goalId) return;
      state.pending.shift();
      await this.persist();
    });
  }

  private requireState(): GoalState {
    if (!this.state) throw new Error("GoalService is not initialized");
    return this.state;
  }

  private async persist(): Promise<void> {
    const state = this.requireState();
    await mkdir(dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.statePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function matchesVariant(
  pal: { characterId: string; isAlpha: boolean; isLucky: boolean },
  variant: GoalVariant,
): boolean {
  if (variant === "boss") return isBossVariant(pal);
  if (variant === "alpha") return pal.isAlpha && !isBossVariant(pal);
  if (variant === "lucky") return pal.isLucky;
  return true;
}

function emptyState(): GoalState {
  return {
    version: 2,
    nextId: 1,
    active: [],
    pending: [],
    completed: [],
    lastCapturedAt: null,
    observedInstances: {},
  };
}

function validateState(value: unknown): GoalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid goal state");
  const state = value as {
    version?: unknown;
    nextId?: unknown;
    active?: unknown;
    pending?: unknown;
    completed?: unknown;
    lastCapturedAt?: unknown;
    observedInstances?: unknown;
  };
  if ((state.version !== 1 && state.version !== 2) || !Number.isInteger(state.nextId) || !Array.isArray(state.active) ||
      !Array.isArray(state.pending) || !Array.isArray(state.completed)) {
    throw new Error("invalid goal state");
  }
  if (state.version === 1) {
    const legacy = state as unknown as Omit<GoalState, "version" | "observedInstances"> & { version: 1 };
    const observedInstances: Record<string, true> = {};
    for (const goal of legacy.active) {
      for (const instanceId of goal.baselineInstances) observedInstances[instanceId] = true;
    }
    for (const completion of [...legacy.pending, ...legacy.completed]) {
      observedInstances[completion.pal.instanceId] = true;
    }
    return { ...legacy, version: 2, observedInstances };
  }
  if (!state.observedInstances || typeof state.observedInstances !== "object" || Array.isArray(state.observedInstances)) {
    throw new Error("invalid goal state");
  }
  return state as unknown as GoalState;
}
