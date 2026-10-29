// Type surface for lib/store.mjs. The runtime module is plain JS so `node
// --test` can load it without a build step; this declaration is what
// `server.ts` compiles against.

export declare class CatchupError extends Error {}

export declare const LEDGER_VERSION: 1;
export declare const WORKSTREAM_STATES: readonly ("active" | "blocked" | "idle" | "done")[];
export declare const ITEM_KINDS: readonly ("issue" | "decision" | "blocker" | "release" | "note")[];
export declare const ITEM_STATES: readonly ("open" | "done" | "blocked")[];
export declare const MAX_RUN_ERRORS: number;
export declare const MAX_ERROR_LENGTH: number;
export declare const MAX_RUNS: number;

export interface Workstream {
  id: string;
  name: string;
  repo: string;
  threadId: string;
  state: "active" | "blocked" | "idle" | "done";
  summary: string;
  updatedAt: string;
}

export interface Item {
  id: string;
  workstreamId: string;
  title: string;
  detail: string;
  kind: "issue" | "decision" | "blocker" | "release" | "note";
  state: "open" | "done" | "blocked";
  url: string | null;
  repo: string;
  number: number | null;
  threadId: string;
  evidence: string;
  updatedAt: string;
}

export interface Ledger {
  version: number;
  updatedAt: string;
  workstreams: Workstream[];
  items: Item[];
}

export interface RunError {
  source: string;
  message: string;
}

export interface Run {
  id: string;
  startedAt: string;
  finishedAt: string;
  workstreams: number;
  items: number;
  errors: RunError[];
}

export declare function ledgerPath(dir: string): string;
export declare function runsPath(dir: string): string;
export declare function emptyLedger(at: string): Ledger;
export declare function validateLedger(value: unknown, source?: string): Ledger;
export declare function readLedger(dir: string): Ledger | null;
export declare function readLedgerOrEmpty(dir: string, at: string): Ledger;
export declare function ensureDir(dir: string): void;
export declare function writeLedger(dir: string, ledger: Ledger): Ledger;
export declare function normalizeRunErrors(errors: unknown): RunError[];
export declare function validateRun(value: unknown, where?: string): Run;
export declare function appendRun(dir: string, run: Run): Run;
export declare function readRuns(dir: string, options?: { limit?: number }): Run[];
export declare function lastRun(dir: string): Run | null;
