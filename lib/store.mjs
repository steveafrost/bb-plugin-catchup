// The catchup ledger: one JSON file in the plugin's data directory, plus a
// JSONL run history beside it. No database.
//
// Both files are validated on read, so a hand-edited or half-written ledger
// fails loudly with the offending path and field instead of feeding the panel
// and Pulse something untyped. Writes are atomic (temp file + rename) and the
// file is 0600: a ledger names repos, threads and blockers, which is not
// secret, but it is the user's work in plain text and nothing else on the
// machine needs to read it.
import fs from "node:fs";
import path from "node:path";

export class CatchupError extends Error {}

export const LEDGER_VERSION = 1;
export const WORKSTREAM_STATES = ["active", "blocked", "idle", "done"];
export const ITEM_KINDS = ["issue", "decision", "blocker", "release", "note"];
export const ITEM_STATES = ["open", "done", "blocked"];

/** Max error entries kept on one run, and max length of one error message. */
export const MAX_RUN_ERRORS = 50;
export const MAX_ERROR_LENGTH = 500;
/** How many runs the history keeps. Older lines are dropped on append. */
export const MAX_RUNS = 100;

const WORKSTREAM_FIELDS = ["id", "name", "repo", "threadId", "state", "summary", "updatedAt"];
const ITEM_FIELDS = [
  "id", "workstreamId", "title", "detail", "kind", "state",
  "url", "repo", "number", "threadId", "evidence", "updatedAt",
];
const RUN_FIELDS = ["id", "startedAt", "finishedAt", "workstreams", "items", "errors"];

export const ledgerPath = (dir) => path.join(dir, "ledger.json");
export const runsPath = (dir) => path.join(dir, "runs.jsonl");

export function emptyLedger(at) {
  return { version: LEDGER_VERSION, updatedAt: at, workstreams: [], items: [] };
}

const fail = (message) => {
  throw new CatchupError(message);
};

function isIsoDate(value) {
  return typeof value === "string" && value !== "" && !Number.isNaN(new Date(value).getTime());
}

function checkUnknown(value, allowed, where) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) fail(`${where} has unknown field(s): ${extra.join(", ")}`);
}

function validateWorkstream(value, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  checkUnknown(value, WORKSTREAM_FIELDS, where);
  if (typeof value.id !== "string" || value.id.trim() === "") fail(`${where}.id must be a non-empty string`);
  if (typeof value.name !== "string" || value.name.trim() === "") fail(`${where}.name must be a non-empty string`);
  for (const key of ["repo", "threadId", "summary"]) {
    if (typeof value[key] !== "string") fail(`${where}.${key} must be a string ("" when unknown)`);
  }
  if (!WORKSTREAM_STATES.includes(value.state)) {
    fail(`${where}.state must be one of ${WORKSTREAM_STATES.join("|")}, got ${JSON.stringify(value.state)}`);
  }
  if (!isIsoDate(value.updatedAt)) fail(`${where}.updatedAt must be an ISO date string`);
  return value;
}

function validateItem(value, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  checkUnknown(value, ITEM_FIELDS, where);
  if (typeof value.id !== "string" || value.id.trim() === "") fail(`${where}.id must be a non-empty string`);
  if (typeof value.workstreamId !== "string" || value.workstreamId.trim() === "") {
    fail(`${where}.workstreamId must be a non-empty string`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") fail(`${where}.title must be a non-empty string`);
  if (typeof value.detail !== "string") fail(`${where}.detail must be a string ("" when empty)`);
  if (!ITEM_KINDS.includes(value.kind)) {
    fail(`${where}.kind must be one of ${ITEM_KINDS.join("|")}, got ${JSON.stringify(value.kind)}`);
  }
  if (!ITEM_STATES.includes(value.state)) {
    fail(`${where}.state must be one of ${ITEM_STATES.join("|")}, got ${JSON.stringify(value.state)}`);
  }
  // The panel renders `url` as a link and the value came from someone else's
  // issue body, so only web links are allowed through.
  if (value.url !== null && (typeof value.url !== "string" || !/^https?:\/\//i.test(value.url))) {
    fail(`${where}.url must be an http(s) URL or null`);
  }
  if (value.number !== null && !Number.isInteger(value.number)) fail(`${where}.number must be an integer or null`);
  for (const key of ["repo", "threadId", "evidence"]) {
    if (typeof value[key] !== "string") fail(`${where}.${key} must be a string ("" when unknown)`);
  }
  if (!isIsoDate(value.updatedAt)) fail(`${where}.updatedAt must be an ISO date string`);
  return value;
}

/** Returns a normalized copy, or throws a CatchupError naming the bad field. */
export function validateLedger(value, source = "ledger") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${source} must be a JSON object`);
  }
  checkUnknown(value, ["version", "updatedAt", "workstreams", "items"], source);
  if (value.version !== LEDGER_VERSION) {
    fail(`${source}.version must be ${LEDGER_VERSION}, got ${JSON.stringify(value.version)}`);
  }
  if (!isIsoDate(value.updatedAt)) fail(`${source}.updatedAt must be an ISO date string`);
  if (!Array.isArray(value.workstreams)) fail(`${source}.workstreams must be an array`);
  if (!Array.isArray(value.items)) fail(`${source}.items must be an array`);
  const workstreams = value.workstreams.map((entry, index) =>
    validateWorkstream(entry, `${source}.workstreams[${index}]`));
  const items = value.items.map((entry, index) => validateItem(entry, `${source}.items[${index}]`));
  const workstreamIds = new Set(workstreams.map((entry) => entry.id));
  const seen = new Set();
  for (const item of items) {
    if (!workstreamIds.has(item.workstreamId)) {
      fail(`${source}.items: item ${item.id} names unknown workstream ${item.workstreamId}`);
    }
    if (seen.has(item.id)) fail(`${source}.items: duplicate item id ${item.id}`);
    seen.add(item.id);
  }
  return { version: LEDGER_VERSION, updatedAt: value.updatedAt, workstreams, items };
}

/**
 * Read and validate the ledger: `null` when the file does not exist, a throw
 * when it exists but cannot be trusted. A damaged file is never silently
 * replaced with an empty ledger, because that would read as "no work".
 */
export function readLedger(dir) {
  const file = ledgerPath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail(`cannot read ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  return validateLedger(parsed, file);
}

/** `readLedger` with the empty-ledger fallback for a first run. */
export function readLedgerOrEmpty(dir, at) {
  return readLedger(dir) ?? emptyLedger(at);
}

function writeAtomic(target, body, mode) {
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  // rename carries the temp file's mode across, but be explicit: an existing
  // target may have been created by something else with a wider mode.
  fs.chmodSync(target, mode);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Validate, then write the ledger atomically at mode 0600. */
export function writeLedger(dir, ledger) {
  const checked = validateLedger(ledger, ledgerPath(dir));
  ensureDir(dir);
  writeAtomic(ledgerPath(dir), `${JSON.stringify(checked, null, 2)}\n`, 0o600);
  return checked;
}

function clipError(value) {
  const message = String(value ?? "");
  return message.length <= MAX_ERROR_LENGTH ? message : `${message.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

export function normalizeRunErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, MAX_RUN_ERRORS)
    .map((entry) => ({ source: String(entry.source ?? ""), message: clipError(entry.message) }));
}

export function validateRun(value, where = "run") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  checkUnknown(value, RUN_FIELDS, where);
  if (typeof value.id !== "string" || value.id === "") fail(`${where}.id must be a non-empty string`);
  if (!isIsoDate(value.startedAt)) fail(`${where}.startedAt must be an ISO date string`);
  if (!isIsoDate(value.finishedAt)) fail(`${where}.finishedAt must be an ISO date string`);
  for (const key of ["workstreams", "items"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) fail(`${where}.${key} must be a count`);
  }
  return {
    id: value.id,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    workstreams: value.workstreams,
    items: value.items,
    errors: normalizeRunErrors(value.errors),
  };
}

/** Append one run record, keeping only the newest MAX_RUNS lines. */
export function appendRun(dir, run) {
  const record = validateRun(run);
  ensureDir(dir);
  let existing = "";
  try {
    existing = fs.readFileSync(runsPath(dir), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = existing.split("\n").filter((line) => line.trim() !== "");
  lines.push(JSON.stringify(record));
  writeAtomic(runsPath(dir), `${lines.slice(-MAX_RUNS).join("\n")}\n`, 0o600);
  return record;
}

/**
 * Run history, oldest first, newest `limit` records — Third Hand's `runs`
 * ordering. A malformed line is skipped rather than failing the read: history
 * is reporting, not the ledger.
 */
export function readRuns(dir, { limit = 10 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(runsPath(dir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      runs.push(validateRun(JSON.parse(line)));
    } catch {
      // Skip the unreadable line; the rest of the history is still useful.
    }
  }
  const wanted = Number.isInteger(limit) && limit > 0 ? limit : 10;
  return runs.slice(-wanted);
}

/** The most recent run, or null when sync has never run. */
export function lastRun(dir) {
  const runs = readRuns(dir, { limit: 1 });
  return runs.length === 0 ? null : runs[0];
}
