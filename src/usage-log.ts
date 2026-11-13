/**
 * One line per model call, for every app on a box: who called which vendor,
 * and what came of it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * On 10-11 Nov 2026 the fleet spent about $567 at Google and nobody could say
 * which app had spent it, on what, or when. Each app counted its own calls in
 * its own process (or not at all), so the only whole picture was the vendor's
 * invoice, two days late. The owner's words: "I never know what is used up,
 * what isn't, what it was used up for, and when."
 *
 * The chain walk (./walk) already knows everything worth knowing about a call
 * at the moment it happens: the app, the vendor, the model, whether the link
 * was refused by the spend rules, failed at the vendor (and how), or served.
 * This module is where it says so.
 *
 * ── How it reaches a page ────────────────────────────────────────────────────
 * `emitUsage` hands each event to a sink. With no sink set, and `AI_USAGE_DIR`
 * in the environment, events are appended to `<dir>/<UTC day>.jsonl`. A box
 * sets that variable once for all its apps, and one reader (`readUsageDay`,
 * `summariseUsage`) then sees the whole fleet. An append of one short line is
 * atomic on POSIX, so many processes share the file without a lock.
 *
 * Never in a line: a prompt, an answer, a key, a person. Only counts and names.
 *
 * ── Why `getBuiltinModule` and not an import ─────────────────────────────────
 * This file is reachable from the package root, which browser bundles import
 * for types and pure helpers. An `import "node:fs"` here, even a dynamic one,
 * is resolved by the bundler and breaks those builds. `process.getBuiltinModule`
 * (Node 20.16+/22.3+) is a runtime call the bundler never sees; where it is
 * missing (a browser, an edge runtime, an old Node) the file sink is simply off.
 */
import type { Link } from "./chain.js";

export type UsageOutcome = "served" | "failed" | "refused";

export interface UsageEvent {
  /** Epoch milliseconds. */
  t: number;
  /** The app that made the call (`spendApp`): "ORANGECAT", "LOKI", … */
  app: string;
  provider: string;
  model: string;
  outcome: UsageOutcome;
  /** A vendor that bills per call (./spend `isPaidProvider`). */
  paid: boolean;
  /** A reader's own key, not the platform's. */
  byok: boolean;
  /** failed: the HTTP status, when the vendor gave one. */
  status?: number;
  /** failed: the kind of refusal ("daily", "rate", "size", …). */
  kind?: string;
  /** refused: which spend rule said no ("paid-disabled", "app-cap", …). */
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** How long the vendor took, in milliseconds. */
  ms?: number;
}

export type UsageSink = (event: UsageEvent) => void;

type Env = Record<string, string | undefined>;

let sink: UsageSink | null = null;

/** Send events somewhere else (a database, a test). `null` restores the default. Returns the previous sink. */
export function setUsageSink(next: UsageSink | null): UsageSink | null {
  const prev = sink;
  sink = next;
  return prev;
}

interface FsLike {
  appendFile(path: string, data: string, cb: (err: unknown) => void): void;
  mkdirSync(path: string, options: { recursive: boolean }): unknown;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
}

function nodeFs(): FsLike | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  try {
    return (proc?.getBuiltinModule?.("node:fs") as FsLike | undefined) ?? null;
  } catch {
    return null;
  }
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Directories a failed write was already reported for: one warning, not one per call. */
const warned = new Set<string>();

function appendLine(dir: string, event: UsageEvent): void {
  const fs = nodeFs();
  if (!fs) return;
  const file = `${dir.replace(/\/+$/, "")}/${dayOf(event.t)}.jsonl`;
  fs.appendFile(file, `${JSON.stringify(event)}\n`, (err) => {
    if (!err || warned.has(dir)) return;
    warned.add(dir);
    console.warn(
      `[ai-kit] usage log: cannot write ${file}: ${String((err as Error).message ?? err)}`,
    );
  });
}

/**
 * Report one call. Never throws and never waits: a usage line is not worth an
 * answer. With no sink set, it is appended under `AI_USAGE_DIR` when that is set.
 */
export function emitUsage(event: UsageEvent, env: Env = defaultEnv()): void {
  try {
    if (sink) return sink(event);
    const dir = env.AI_USAGE_DIR?.trim();
    if (dir) appendLine(dir, event);
  } catch {
    // Counting must never be the reason a person gets no answer.
  }
}

function defaultEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

/** The event for a link, with the fields every outcome shares. */
export function usageEventFor(
  link: Link,
  app: string,
  paid: boolean,
  rest: Pick<UsageEvent, "outcome"> & Partial<UsageEvent>,
  now = Date.now(),
): UsageEvent {
  return {
    t: now,
    app,
    provider: link.provider.id,
    model: link.model,
    paid,
    byok: Boolean(link.provider.byok),
    ...rest,
  };
}

// ── reading ────────────────────────────────────────────────────────────────

const isEvent = (v: unknown): v is UsageEvent => {
  const e = v as UsageEvent;
  return (
    !!e &&
    typeof e.t === "number" &&
    typeof e.app === "string" &&
    typeof e.provider === "string" &&
    typeof e.model === "string" &&
    (e.outcome === "served" || e.outcome === "failed" || e.outcome === "refused")
  );
};

/** Events from the text of a day's file. A torn or foreign line is skipped, never fatal. */
export function parseUsageLines(text: string): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isEvent(v)) out.push(v);
    } catch {
      // A line cut short by a crash mid-append.
    }
  }
  return out;
}

/**
 * One UTC day of the box's calls ("2026-11-13"). `null` when the day could not
 * be read (no directory, no file system): "could not look" is not "no calls".
 * A day with no file yet is an empty list.
 */
export function readUsageDay(dir: string, day: string): UsageEvent[] | null {
  const fs = nodeFs();
  if (!fs || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const root = dir.replace(/\/+$/, "");
  try {
    return parseUsageLines(fs.readFileSync(`${root}/${day}.jsonl`, "utf8"));
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") return null;
    try {
      fs.readdirSync(root);
      return [];
    } catch {
      return null;
    }
  }
}

export interface UsageTally {
  served: number;
  failed: number;
  refused: number;
  inputTokens: number;
  outputTokens: number;
  /** When this last served, epoch ms; null if it never did in the window. */
  lastServedAt: number | null;
  /** The most recent failure or refusal: what, and when. */
  lastProblem: {
    at: number;
    outcome: UsageOutcome;
    status?: number;
    kind?: string;
    reason?: string;
  } | null;
}

export interface ProviderUsage extends UsageTally {
  provider: string;
  paid: boolean;
  /** Per model at this vendor, busiest first. */
  models: Array<UsageTally & { model: string }>;
  /** Which apps called this vendor, busiest first. */
  apps: Array<UsageTally & { app: string }>;
}

export interface AppUsage extends UsageTally {
  app: string;
  /** Which vendors this app called, busiest first. */
  providers: Array<UsageTally & { provider: string; paid: boolean }>;
}

export interface UsageSummary {
  /** Calls made with the platform's keys. A reader's own key is counted in `ownKeyCalls` only. */
  total: UsageTally;
  providers: ProviderUsage[];
  apps: AppUsage[];
  ownKeyCalls: number;
  /** First and last event in the window; null when there were none. */
  from: number | null;
  to: number | null;
}

const blank = (): UsageTally => ({
  served: 0,
  failed: 0,
  refused: 0,
  inputTokens: 0,
  outputTokens: 0,
  lastServedAt: null,
  lastProblem: null,
});

function add(tally: UsageTally, e: UsageEvent): void {
  tally[e.outcome] += 1;
  tally.inputTokens += Math.max(0, e.inputTokens ?? 0);
  tally.outputTokens += Math.max(0, e.outputTokens ?? 0);
  if (e.outcome === "served") {
    if (tally.lastServedAt === null || e.t > tally.lastServedAt) tally.lastServedAt = e.t;
  } else if (!tally.lastProblem || e.t >= tally.lastProblem.at) {
    tally.lastProblem = {
      at: e.t,
      outcome: e.outcome,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.kind ? { kind: e.kind } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
    };
  }
}

const calls = (t: UsageTally) => t.served + t.failed + t.refused;
const busiest = <T extends UsageTally>(rows: T[]) => rows.sort((a, b) => calls(b) - calls(a));

/**
 * The whole picture from a list of events: per vendor (with its models and the
 * apps that used it) and per app (with the vendors it used). Pure.
 */
export function summariseUsage(events: readonly UsageEvent[]): UsageSummary {
  const total = blank();
  const byProvider = new Map<
    string,
    ProviderUsage & {
      m: Map<string, UsageTally & { model: string }>;
      a: Map<string, UsageTally & { app: string }>;
    }
  >();
  const byApp = new Map<
    string,
    AppUsage & { p: Map<string, UsageTally & { provider: string; paid: boolean }> }
  >();
  let ownKeyCalls = 0;
  let from: number | null = null;
  let to: number | null = null;

  for (const e of events) {
    if (from === null || e.t < from) from = e.t;
    if (to === null || e.t > to) to = e.t;
    if (e.byok) {
      ownKeyCalls += 1;
      continue;
    }
    add(total, e);

    let p = byProvider.get(e.provider);
    if (!p) {
      p = {
        ...blank(),
        provider: e.provider,
        paid: e.paid,
        models: [],
        apps: [],
        m: new Map(),
        a: new Map(),
      };
      byProvider.set(e.provider, p);
    }
    if (e.paid) p.paid = true;
    add(p, e);
    let pm = p.m.get(e.model);
    if (!pm) p.m.set(e.model, (pm = { ...blank(), model: e.model }));
    add(pm, e);
    let pa = p.a.get(e.app);
    if (!pa) p.a.set(e.app, (pa = { ...blank(), app: e.app }));
    add(pa, e);

    let a = byApp.get(e.app);
    if (!a) {
      a = { ...blank(), app: e.app, providers: [], p: new Map() };
      byApp.set(e.app, a);
    }
    add(a, e);
    let ap = a.p.get(e.provider);
    if (!ap) a.p.set(e.provider, (ap = { ...blank(), provider: e.provider, paid: e.paid }));
    if (e.paid) ap.paid = true;
    add(ap, e);
  }

  const providers = busiest(
    [...byProvider.values()].map(({ m, a, ...p }) => ({
      ...p,
      models: busiest([...m.values()]),
      apps: busiest([...a.values()]),
    })),
  );
  const apps = busiest(
    [...byApp.values()].map(({ p, ...a }) => ({ ...a, providers: busiest([...p.values()]) })),
  );
  return { total, providers, apps, ownKeyCalls, from, to };
}
