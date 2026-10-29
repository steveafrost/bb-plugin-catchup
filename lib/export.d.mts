// Type surface for lib/export.mjs — the Pulse-facing projection.

import type { Item, Ledger } from "./store.mjs";

/** Pulse's own item kinds, as understood by Third Hand. */
export type PulseKind = "decision" | "review" | "followup" | "fyi";

export interface QuickAction {
  label: string;
  text?: string;
  url?: string;
}

export interface ExportEntry {
  id: string;
  kind: PulseKind;
  title: string;
  detail: string;
  url: string | null;
  source: "catchup";
  status: "open";
  workstream: { id: string; name: string } | null;
  quickActions: QuickAction[];
  updatedAt: string;
}

export interface ExportProjection {
  version: number;
  updatedAt: string | null;
  workstreams: {
    id: string;
    name: string;
    state: string;
    summary: string;
    updatedAt: string;
  }[];
  entries: ExportEntry[];
}

export declare const PULSE_KIND: Record<Item["kind"], PulseKind>;
export declare const EXPORTED_STATES: readonly string[];
export declare const MAX_QUICK_ACTIONS: number;
export declare const EXPORT_ID_PREFIX: "catchup:";
export declare function exportId(itemId: string): string;
export declare function exportEntry(ledger: Ledger | null, item: Item): ExportEntry | null;
export declare function exportLedger(ledger: Ledger | null): ExportProjection;
