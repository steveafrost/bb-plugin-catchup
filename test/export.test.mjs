// The export is a contract with Pulse: ids key user state on the other side,
// so stability is the property under test, not a nicety.
import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_ID_PREFIX, PULSE_KIND, exportEntry, exportId, exportLedger } from "../lib/export.mjs";
import { emptyLedger } from "../lib/store.mjs";

const AT = "2026-01-02T03:04:05.000Z";
const REPO = "steveafrost/bb-plugin-catchup";

const workstream = {
  id: `repo:${REPO}`,
  name: REPO,
  repo: REPO,
  threadId: "",
  state: "active",
  summary: "2 open items",
  updatedAt: AT,
};

const item = (overrides = {}) => ({
  id: `github:${REPO}#7`,
  workstreamId: workstream.id,
  title: "Sync records a run error when a repo fails",
  detail: "Partial failure must not abort the run.",
  kind: "issue",
  state: "open",
  url: `https://github.com/${REPO}/issues/7`,
  repo: REPO,
  number: 7,
  threadId: "",
  evidence: "",
  updatedAt: AT,
  ...overrides,
});

const ledgerOf = (items, workstreams = [workstream]) => ({
  ...emptyLedger(AT),
  workstreams,
  items,
});

test("every ledger kind maps to a Pulse kind", () => {
  assert.deepEqual(PULSE_KIND, {
    decision: "decision",
    blocker: "decision",
    release: "review",
    note: "fyi",
    issue: "followup",
  });
});

test("an exported id is the catchup: prefix plus the ledger id", () => {
  assert.equal(exportId(`github:${REPO}#7`), `catchup:github:${REPO}#7`);
  assert.ok(exportId(`github:${REPO}#7`).startsWith(EXPORT_ID_PREFIX));
});

test("the exported id survives a title, detail and state change", () => {
  const before = exportEntry(ledgerOf([item()]), item());
  const after = exportEntry(
    ledgerOf([item({ title: "Renamed", detail: "Rewritten", state: "blocked" })]),
    item({ title: "Renamed", detail: "Rewritten", state: "blocked" }),
  );
  assert.equal(before.id, after.id);
});

test("an issue exports as a followup that carries the issue url", () => {
  const entry = exportEntry(ledgerOf([item()]), item());
  assert.equal(entry.kind, "followup");
  assert.equal(entry.source, "catchup");
  assert.equal(entry.url, `https://github.com/${REPO}/issues/7`);
  assert.deepEqual(entry.quickActions, [{ label: "Open issue", url: `https://github.com/${REPO}/issues/7` }]);
});

test("a blocker exports as a decision", () => {
  const blocked = item({ kind: "blocker", state: "blocked" });
  assert.equal(exportEntry(ledgerOf([blocked]), blocked).kind, "decision");
});

test("a release exports as a review and a note as an fyi", () => {
  const release = item({ kind: "release" });
  const note = item({ kind: "note" });
  assert.equal(exportEntry(ledgerOf([release]), release).kind, "review");
  assert.equal(exportEntry(ledgerOf([note]), note).kind, "fyi");
});

test("a done item is not exported", () => {
  const done = item({ state: "done" });
  assert.equal(exportEntry(ledgerOf([done]), done), null);
});

test("quickActions stay within Pulse's three-action limit and carry a url or text", () => {
  const threaded = item({ threadId: "thr_abc" });
  const entry = exportEntry(ledgerOf([threaded]), threaded);
  assert.ok(entry.quickActions.length <= 3);
  for (const action of entry.quickActions) {
    assert.ok(action.label.length >= 1 && action.label.length <= 32);
    assert.ok(typeof action.url === "string" || typeof action.text === "string");
  }
});

test("an item with no url and no thread has no quick actions", () => {
  const bare = item({ url: null, threadId: "" });
  assert.deepEqual(exportEntry(ledgerOf([bare]), bare).quickActions, []);
});

test("the entry names its workstream so a consumer can group without re-joining", () => {
  const entry = exportEntry(ledgerOf([item()]), item());
  assert.deepEqual(entry.workstream, { id: workstream.id, name: workstream.name });
});

test("an item from a workstream not in the ledger still exports, ungrouped", () => {
  const orphan = item({ workstreamId: "repo:gone/gone" });
  const entry = exportEntry(ledgerOf([orphan]), orphan);
  assert.equal(entry.workstream, null);
});

test("exportLedger projects the workstream list and the open items together", () => {
  const done = item({ id: `github:${REPO}#8`, number: 8, state: "done" });
  const projection = exportLedger(ledgerOf([item(), done]));
  assert.equal(projection.version, 1);
  assert.equal(projection.updatedAt, AT);
  assert.deepEqual(projection.workstreams, [{
    id: workstream.id,
    name: workstream.name,
    state: "active",
    summary: "2 open items",
    updatedAt: AT,
  }]);
  assert.deepEqual(projection.entries.map((entry) => entry.id), [`catchup:github:${REPO}#7`]);
});

test("exportLedger tolerates an empty ledger", () => {
  const projection = exportLedger(emptyLedger(AT));
  assert.deepEqual(projection.entries, []);
  assert.deepEqual(projection.workstreams, []);
});
