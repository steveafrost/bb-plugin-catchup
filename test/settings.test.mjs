// Settings are free-text fields a user types into, so every parser here is a
// boundary: a bad entry becomes a recorded error and the rest still works.
import assert from "node:assert/strict";
import test from "node:test";
import { parseCoordinatorThreads, parseRepos, parseSettings } from "../lib/settings.mjs";

test("parseRepos reads a comma-separated list", () => {
  const { repos, errors } = parseRepos("steveafrost/bb-plugin-catchup, acme/widgets");
  assert.deepEqual(repos.map((entry) => entry.repo), ["steveafrost/bb-plugin-catchup", "acme/widgets"]);
  assert.deepEqual(errors, []);
});

test("parseRepos tolerates blanks, newlines and stray separators", () => {
  const { repos, errors } = parseRepos("\n , steveafrost/a ,\n\n , ,");
  assert.deepEqual(repos.map((entry) => entry.repo), ["steveafrost/a"]);
  assert.deepEqual(errors, []);
});

test("parseRepos records malformed entries instead of throwing", () => {
  const { repos, errors } = parseRepos("steveafrost/good, not-a-repo, too/many/slashes");
  assert.deepEqual(repos.map((entry) => entry.repo), ["steveafrost/good"]);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /malformed repo entry "not-a-repo"/);
  assert.ok(errors.every((entry) => entry.source === "settings.repos"));
});

test("parseRepos de-duplicates case-insensitively", () => {
  const { repos } = parseRepos("acme/widgets, ACME/widgets");
  assert.equal(repos.length, 1);
});

test("parseCoordinatorThreads reads bare ids and id=Label pairs", () => {
  const { threads, errors } = parseCoordinatorThreads("thr_abc,thr_def=Frost work");
  assert.deepEqual(threads, [
    { id: "thr_abc", label: "" },
    { id: "thr_def", label: "Frost work" },
  ]);
  assert.deepEqual(errors, []);
});

test("parseCoordinatorThreads records a malformed id", () => {
  const { threads, errors } = parseCoordinatorThreads("thr_ok,not a thread,caught=Label with spaces");
  assert.deepEqual(threads.map((entry) => entry.id), ["thr_ok", "caught"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /malformed thread entry "not a thread"/);
});

test("parseSettings never throws on undefined", () => {
  const parsed = parseSettings(undefined);
  assert.deepEqual(parsed.repos, []);
  assert.deepEqual(parsed.threads, []);
  assert.equal(parsed.syncCron, "");
  assert.deepEqual(parsed.errors, []);
});

test("parseSettings folds both error lists and keeps syncCron verbatim", () => {
  const parsed = parseSettings({
    repos: "bad entry",
    coordinatorThreads: "also bad",
    syncCron: " 0 9 * * * ",
  });
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.syncCron, "0 9 * * *");
});
