// Type surface for lib/settings.mjs.

import type { RunError } from "./store.mjs";

export interface ParsedSettings {
  repos: { repo: string }[];
  threads: { id: string; label: string }[];
  syncCron: string;
  errors: RunError[];
}

export declare function parseRepos(raw: unknown): { repos: { repo: string }[]; errors: RunError[] };
export declare function parseCoordinatorThreads(raw: unknown): {
  threads: { id: string; label: string }[];
  errors: RunError[];
};
export declare function parseSettings(values: unknown): ParsedSettings;
export declare function workstreamIdForRepo(repo: string): string;
export declare function workstreamIdForThread(threadId: string): string;
