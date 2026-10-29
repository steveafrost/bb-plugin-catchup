// The ledger is the only substrate the panel and Pulse share, so these tests
// are about the two properties that make it safe to depend on: a write is
// atomic and private, and a read refuses to hand back something unvalidated.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CatchupError,
  emptyLedger,
  ledgerPath,
  readLedger,
  readLedgerOrEmpty,
  readRuns,
  appendRun,
  lastRun,
  validateLedger,
  validateRun,
  writeLedger,
} from "../lib/store.mjs";

const AT = "2026-01-02T03:04:05.000Z";

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-store-"));
  test.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const workstream = {
  id: "repo:steveafrost/bb-plugin-catchup",
  name: "steveafrost/bb-plugin-catchup",
  repo: "steveafrost/bb-plugin-catchup",
  threadId: "",
  state: "active",
  summary: "2 open items",
  updatedAt: AT,
};

const item = {
  id: "github:steveafrost/bb-plugin-catchup#7",
  workstreamId: workstream.id,
  title: "Sync records a run error when a repo fails",
  detail: "",
  kind: "issue",
  state: "open",
  url: "https://github.com/steveafrost/bb-plugin-catchup/issues/7",
  repo: "steveafrost/bb-plugin-catchup",
  number: 7,
  threadId: "",
  evidence: "",
  updatedAt: AT,
};

const ledger = (overrides = {}) => ({
  ...emptyLedger(AT),
  workstreams: [workstream],
  items: [item],
  ...overrides,
});

test("readLedger returns null for a first run", () => {
  assert.equal(readLedger(tempDir()), null);
});

test("readLedgerOrEmpty falls back to an empty ledger", () => {
  assert.deepEqual(readLedgerOrEmpty(tempDir(), AT), emptyLedger(AT));
});

test("a write round-trips and lands at mode 0600", () => {
  const dir = tempDir();
  writeLedger(dir, ledger());
  assert.deepEqual(readLedger(dir), ledger());
  const mode = fs.statSync(ledgerPath(dir)).mode & 0o777;
  assert.equal(mode.toString(8), "600");
});

test("a write leaves no temp file behind", () => {
  const dir = tempDir();
  writeLedger(dir, ledger());
  writeLedger(dir, ledger({ updatedAt: "2026-01-02T04:00:00.000Z" }));
  const leftovers = fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("a damaged ledger throws instead of reading as empty", () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ledgerPath(dir), "{ this is not json");
  assert.throws(() => readLedger(dir), (error) => error instanceof CatchupError && /not valid JSON/.test(error.message));
});

test("an unknown field is rejected, naming the field", () => {
  const bad = ledger({ workstreams: [{ ...workstream, mood: "sunny" }] });
  assert.throws(() => validateLedger(bad), /workstreams\[0\] has unknown field\(s\): mood/);
});

test("a bad state value is rejected", () => {
  const bad = ledger({ workstreams: [{ ...workstream, state: "sleepy" }] });
  assert.throws(() => validateLedger(bad), /state must be one of active\|blocked\|idle\|done/);
});

test("an item naming a missing workstream is rejected", () => {
  const bad = ledger({ items: [{ ...item, workstreamId: "repo:nobody/nothing" }] });
  assert.throws(() => validateLedger(bad), /unknown workstream repo:nobody\/nothing/);
});

test("a duplicate item id is rejected", () => {
  const bad = ledger({ items: [item, { ...item }] });
  assert.throws(() => validateLedger(bad), /duplicate item id/);
});

test("a non-http url is rejected", () => {
  const bad = ledger({ items: [{ ...item, url: "javascript:alert(1)" }] });
  assert.throws(() => validateLedger(bad), /url must be an http\(s\) URL or null/);
});

test("a missing detail field is rejected", () => {
  const { detail: _drop, ...withoutDetail } = item;
  const bad = ledger({ items: [withoutDetail] });
  assert.throws(() => validateLedger(bad), /items\[0\]\.detail must be a string/);
});

test("writeLedger validates before touching disk", () => {
  const dir = tempDir();
  assert.throws(() => writeLedger(dir, ledger({ version: 99 })), /version must be 1/);
  assert.equal(readLedger(dir), null);
});

test("appendRun keeps run history and readRuns returns the newest", () => {
  const dir = tempDir();
  for (let index = 0; index < 3; index += 1) {
    appendRun(dir, {
      id: `run_${index}`,
      startedAt: AT,
      finishedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      workstreams: index,
      items: index,
      errors: [],
    });
  }
  const all = readRuns(dir);
  assert.deepEqual(all.map((run) => run.id), ["run_0", "run_1", "run_2"]);
  assert.deepEqual(readRuns(dir, { limit: 1 }).map((run) => run.id), ["run_2"]);
  assert.equal(lastRun(dir).id, "run_2");
});

test("run errors are bounded in count and length", () => {
  const dir = tempDir();
  const errors = Array.from({ length: 80 }, (_, index) => ({
    source: `repo:r${index}`,
    message: "x".repeat(2_000),
  }));
  appendRun(dir, {
    id: "run_big",
    startedAt: AT,
    finishedAt: AT,
    workstreams: 0,
    items: 0,
    errors,
  });
  const [run] = readRuns(dir, { limit: 1 });
  assert.equal(run.errors.length, 50);
  assert.ok(run.errors[0].message.length <= 500);
});

test("a malformed run line is skipped, not fatal", () => {
  const dir = tempDir();
  appendRun(dir, { id: "run_ok", startedAt: AT, finishedAt: AT, workstreams: 0, items: 0, errors: [] });
  fs.appendFileSync(path.join(dir, "runs.jsonl"), "{ not json }\n");
  assert.deepEqual(readRuns(dir).map((run) => run.id), ["run_ok"]);
});

test("validateRun rejects a non-count item total", () => {
  assert.throws(
    () => validateRun({ id: "run_x", startedAt: AT, finishedAt: AT, workstreams: 0, items: "many", errors: [] }),
    /items must be a count/,
  );
});
