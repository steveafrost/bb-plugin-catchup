// The Pulse-facing projection.
//
// Catchup owns the ledger; Pulse owns what happens to it. This module is the
// whole boundary between them: `catchup export --json` prints these entries and
// Pulse reads that output. Nothing here writes to Pulse, and nothing in Pulse's
// store shape belongs in the ledger.
//
// The `id` field is the contract. `catchup:<itemId>` is stable for the life of
// the item, because Pulse keys user state (snoozed, dismissed, replied) on it;
// changing the shape silently orphans everything the user has already triaged.

/** Ledger kind → Pulse kind. Pulse knows reply|decision|rsvp|conflict|deadline|review|followup|fyi. */
export const PULSE_KIND = {
  decision: "decision",
  blocker: "decision",
  release: "review",
  note: "fyi",
  issue: "followup",
};

/** States that still need the user's attention. `done` is not exported. */
export const EXPORTED_STATES = ["open", "blocked"];

/** Pulse allows at most three quick actions, each 1-32 chars, with text or url. */
export const MAX_QUICK_ACTIONS = 3;

/** The stable Pulse-side id for a ledger item. */
export const exportId = (itemId) => `catchup:${itemId}`;

/**
 * The Pulse-side id prefix. Exported so a future importer can verify it is
 * reading catchup entries and not Third Hand's own.
 */
export const EXPORT_ID_PREFIX = "catchup:";

function quickActionsFor(item) {
  const actions = [];
  if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
    actions.push({ label: "Open issue", url: item.url });
  }
  if (typeof item.threadId === "string" && item.threadId !== "") {
    // Thread references are not URLs, so they ride along as text the user can
    // paste into bb rather than as a link Pulse would try to open.
    actions.push({ label: "Thread", text: item.threadId });
  }
  return actions.slice(0, MAX_QUICK_ACTIONS);
}

/** Which workstream an item belongs to, for grouping on the Pulse side. */
function workstreamOf(ledger, item) {
  return (ledger?.workstreams ?? []).find((entry) => entry.id === item.workstreamId) ?? null;
}

/**
 * One item → one Pulse entry, or null when the item should not be exported
 * (done, or a kind the mapping does not know).
 */
export function exportEntry(ledger, item) {
  if (!EXPORTED_STATES.includes(item.state)) return null;
  const kind = PULSE_KIND[item.kind];
  if (!kind) return null;
  const workstream = workstreamOf(ledger, item);
  return {
    id: exportId(item.id),
    kind,
    title: item.title,
    detail: item.detail,
    url: item.url ?? null,
    source: "catchup",
    status: item.state === "blocked" ? "open" : "open",
    // Both fields are informational for Pulse: it decides routing, this only
    // tells it where the item came from.
    workstream: workstream ? { id: workstream.id, name: workstream.name } : null,
    quickActions: quickActionsFor(item),
    updatedAt: item.updatedAt,
  };
}

/**
 * The whole projection, grouped by workstream so a consumer can render
 * "here is what each workstream is doing" without re-joining by hand.
 */
export function exportLedger(ledger) {
  const entries = (ledger?.items ?? [])
    .map((item) => exportEntry(ledger, item))
    .filter((entry) => entry !== null);
  return {
    version: 1,
    updatedAt: ledger?.updatedAt ?? null,
    workstreams: (ledger?.workstreams ?? []).map((workstream) => ({
      id: workstream.id,
      name: workstream.name,
      state: workstream.state,
      summary: workstream.summary,
      updatedAt: workstream.updatedAt,
    })),
    entries,
  };
}
