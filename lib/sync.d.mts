// Type surface for lib/sync.mjs.

import type { Ledger, Item, Run } from "./store.mjs";
import type { ParsedSettings } from "./settings.mjs";

/** One `gh issue list --json number,title,body,labels,createdAt` row. */
export interface GhIssue {
  number: number;
  title?: string;
  body?: string;
  labels?: { name?: string }[] | string[];
  createdAt?: string;
}

/** `bb thread show <id> --json` payload, as far as sync reads it. */
export interface ThreadDetails {
  thread: { id: string; title?: string; status?: string };
  pendingTodos?: { items?: { status?: string }[] };
}

export interface SyncDeps {
  /** Throws when the repo cannot be read; sync records it and continues. */
  listIssues(repo: string): Promise<GhIssue[]>;
  showThread(threadId: string): Promise<ThreadDetails>;
  threadOutput(threadId: string): Promise<string | null>;
  threadLog(threadId: string): Promise<unknown[]>;
  /** Wall clock when the run began; defaults to the sync instant. */
  startedAt?: string;
}

export declare const MAX_TITLE: number;
export declare const MAX_SUMMARY: number;
export declare const MAX_DETAIL: number;

export declare function hasBlockedLabel(labels: unknown): boolean;
export declare function hasBlockedSection(body: unknown): boolean;
export declare function issueKind(issue: GhIssue): "issue" | "blocker";
export declare function issueEvidence(issue: GhIssue, kind: string): string;
export declare function issueToItem(repo: string, issue: GhIssue, at: string): Item;
export declare function threadState(thread: unknown, pendingTodos: unknown): "active" | "blocked" | "idle";
export declare function lastAgentMessage(events: unknown): string;
export declare function threadSummary(input?: { output?: string | null; events?: unknown }): string;
export declare function syncLedger(input: {
  settings: ParsedSettings;
  previous: Ledger | null;
  deps: SyncDeps;
  now: () => string;
  runId?: string;
}): Promise<{ ledger: Ledger; run: Run }>;
