// Deterministic collection: settings + `gh` + `bb` in, ledger + run record out.
//
// No model calls, no reasoning text. Every source is read-only, and one that
// fails is recorded in `run.errors` and skipped — a dead repo or a deleted
// thread must never cost the rest of the ledger.
//
// The mapping functions (`issueToItem`, `threadState`, `threadSummary`) are
// exported on their own so the tests can drive them from fixture JSON without
// spawning anything.
import { randomUUID } from "node:crypto";
import { firstParagraph, clip } from "./text.mjs";
import { workstreamIdForRepo, workstreamIdForThread } from "./settings.mjs";

/** Titles and summaries are lines, not documents. */
export const MAX_TITLE = 200;
export const MAX_SUMMARY = 240;
export const MAX_DETAIL = 400;

const BLOCKED_LABELS = new Set(["blocked", "blocker", "blocked-on", "blocked on"]);
// A line that is nothing but "Blocked on" (as a heading or a label), or a
// label followed by content: "Blocked on: the API key.". Prose that merely
// mentions the words does not count, which is why the line has to start with it.
const BLOCKED_SECTION = /^(?:#{1,6}\s*)?(?:\*\*)?blocked(?:\s+on)?(?:\*\*)?\s*(?::\s*\S|$)/i;

function labelName(label) {
  if (typeof label === "string") return label.trim().toLowerCase();
  if (label !== null && typeof label === "object" && typeof label.name === "string") return label.name.trim().toLowerCase();
  return "";
}

/** True when a label (or its `blocked:` / `blocked/` prefix) says blocked. */
export function hasBlockedLabel(labels) {
  return (Array.isArray(labels) ? labels : []).some((label) => {
    const name = labelName(label);
    if (name === "") return false;
    return BLOCKED_LABELS.has(name) || name.startsWith("blocked:") || name.startsWith("blocked/");
  });
}

/** True when the body carries a heading line or line that reads "Blocked on". */
export function hasBlockedSection(body) {
  return String(body ?? "")
    .split("\n")
    .some((line) => BLOCKED_SECTION.test(line.trim()));
}

/**
 * Only `issue` and `blocker` come out of `sync` in v1: `decision`, `release`
 * and `note` are model-shaped kinds that a later writer can set, and they are
 * in the schema so ids and Pulse mappings stay stable when it does.
 */
export function issueKind(issue) {
  if (hasBlockedLabel(issue?.labels)) return "blocker";
  if (hasBlockedSection(issue?.body)) return "blocker";
  return "issue";
}

/** Bounded, human-readable note on why an item has the kind it has. */
export function issueEvidence(issue, kind) {
  if (kind !== "blocker") return "";
  if (hasBlockedLabel(issue?.labels)) {
    const named = (Array.isArray(issue?.labels) ? issue.labels : [])
      .map(labelName)
      .filter((name) => BLOCKED_LABELS.has(name) || name.startsWith("blocked:") || name.startsWith("blocked/"));
    return clip(`label: ${named.join(", ")}`, 120);
  }
  return "body: Blocked on section";
}

/**
 * One `gh issue list --json` row → one ledger item.
 * Ids are the contract: `github:<owner/repo>#<number>`.
 */
export function issueToItem(repo, issue, at) {
  const number = Number(issue?.number);
  const kind = issueKind(issue);
  return {
    id: `github:${repo}#${number}`,
    workstreamId: workstreamIdForRepo(repo),
    title: clip(issue?.title ?? "", MAX_TITLE) || `Issue #${number}`,
    detail: firstParagraph(issue?.body, MAX_DETAIL),
    kind,
    state: kind === "blocker" ? "blocked" : "open",
    url: `https://github.com/${repo}/issues/${number}`,
    repo,
    number,
    threadId: "",
    evidence: issueEvidence(issue, kind),
    updatedAt: at,
  };
}

/**
 * Thread status + todos → workstream state.
 *
 * `error` is blocked outright. An idle thread that still has open todos is
 * waiting on someone (normally the user), which is what this ledger means by
 * blocked. `done` is never produced by sync — a thread has no "finished"
 * status — so it only appears if something else writes it.
 */
export function threadState(thread, pendingTodos) {
  const status = String(thread?.status ?? "");
  if (status === "error") return "blocked";
  if (status === "active" || status === "pending" || status === "starting") return "active";
  const todos = Array.isArray(pendingTodos?.items) ? pendingTodos.items : [];
  const outstanding = todos.some((todo) => todo?.status === "pending" || todo?.status === "in_progress");
  if (outstanding && (status === "idle" || status === "")) return "blocked";
  return "idle";
}

/** The last agent message in a raw event log, bounded to one line. */
export function lastAgentMessage(events) {
  const rows = Array.isArray(events) ? events : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index]?.data?.item;
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim() !== "") {
      return item.text;
    }
  }
  return "";
}

/**
 * Workstream summary: the thread's final output when it has one, else its last
 * agent message. Reasoning deltas are ignored on purpose — a catchup summary
 * is a line about where the work stands, not a transcript.
 */
export function threadSummary({ output, events } = {}) {
  const final = typeof output === "string" && output.trim() !== "" ? output : lastAgentMessage(events);
  return clip(final, MAX_SUMMARY);
}

function errorRecord(source, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { source, message };
}

/**
 * Build the next ledger and the run record that describes this sync.
 *
 * `deps` is the outside world, injected so tests never spawn a process:
 *   listIssues(repo) → gh issue list rows
 *   showThread(id)   → { thread, pendingTodos }
 *   threadOutput(id) → final output string or null
 *   threadLog(id)    → raw thread events (only read when there is no output)
 *
 * Items seen as open last time and absent from a *successful* fetch are
 * marked done rather than dropped: their ids — the Pulse contract — stay
 * present in the ledger. A failed fetch changes nothing.
 */
export async function syncLedger({ settings, previous, deps, now, runId }) {
  const at = now();
  const errors = [...(settings?.errors ?? [])];
  const previousItems = new Map((previous?.items ?? []).map((item) => [item.id, item]));
  const workstreams = [];
  const items = [];

  for (const { repo } of settings?.repos ?? []) {
    const workstreamId = workstreamIdForRepo(repo);
    let fetched = null;
    try {
      fetched = await deps.listIssues(repo);
      if (!Array.isArray(fetched)) throw new Error("gh returned a non-array issue list");
    } catch (cause) {
      errors.push(errorRecord(`repo:${repo}`, cause));
    }

    if (fetched !== null) {
      const open = fetched.map((issue) => issueToItem(repo, issue, at));
      const openIds = new Set(open.map((item) => item.id));
      for (const item of open) items.push(item);
      // Anything we knew as open and GitHub no longer reports is done, not gone.
      for (const [id, item] of previousItems) {
        if (item.repo !== repo || openIds.has(id)) continue;
        if (item.state === "done") continue;
        items.push({ ...item, state: "done", updatedAt: at });
      }
    } else {
      // Keep what we had for this repo; the run records the failure.
      for (const item of previousItems.values()) {
        if (item.repo === repo) items.push(item);
      }
    }

    const openCount = items.filter((item) => item.workstreamId === workstreamId && item.state !== "done").length;
    let state = "idle";
    let summary = `${openCount} open item${openCount === 1 ? "" : "s"}`;
    if (fetched === null) {
      state = "blocked";
      summary = "GitHub issue list could not be read; see the last run's errors.";
    } else if (openCount > 0) {
      state = "active";
    }
    workstreams.push({
      id: workstreamId,
      name: repo,
      repo,
      threadId: "",
      state,
      summary,
      updatedAt: at,
    });
  }

  for (const { id, label } of settings?.threads ?? []) {
    const workstreamId = workstreamIdForThread(id);
    let shown = null;
    try {
      shown = await deps.showThread(id);
      if (!shown || typeof shown !== "object" || !shown.thread) throw new Error("bb thread show returned no thread");
    } catch (cause) {
      errors.push(errorRecord(`thread:${id}`, cause));
    }

    if (shown === null) {
      const prior = (previous?.workstreams ?? []).find((entry) => entry.id === workstreamId);
      workstreams.push(prior
        ? { ...prior, state: "blocked", summary: "Thread could not be read; see the last run's errors.", updatedAt: at }
        : {
            id: workstreamId,
            name: label || id,
            repo: "",
            threadId: id,
            state: "blocked",
            summary: "Thread could not be read; see the last run's errors.",
            updatedAt: at,
          });
      continue;
    }

    let summary = "";
    try {
      const output = await deps.threadOutput(id);
      summary = threadSummary({
        output,
        events: typeof output === "string" && output.trim() !== "" ? undefined : await deps.threadLog(id),
      });
    } catch (cause) {
      errors.push(errorRecord(`thread:${id}:summary`, cause));
    }

    workstreams.push({
      id: workstreamId,
      name: label || clip(shown.thread.title ?? "", MAX_TITLE) || id,
      repo: "",
      threadId: id,
      state: threadState(shown.thread, shown.pendingTodos),
      summary,
      updatedAt: at,
    });
  }

  const ledger = { version: 1, updatedAt: at, workstreams, items };
  const run = {
    id: runId ?? `run_${at.replace(/[^0-9]/g, "").slice(0, 14)}_${randomUUID().slice(0, 6)}`,
    startedAt: deps.startedAt ?? at,
    finishedAt: at,
    workstreams: workstreams.length,
    items: items.length,
    errors,
  };
  return { ledger, run };
}
