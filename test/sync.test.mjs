// Sync is the only collector, and its whole promise is that one dead source
// costs one recorded error and nothing else. Every test here drives the
// mapping through fake deps — no `gh`, no `bb`, no network.
import assert from "node:assert/strict";
import test from "node:test";
import {
  issueKind,
  issueToItem,
  lastAgentMessage,
  syncLedger,
  threadState,
  threadSummary,
} from "../lib/sync.mjs";
import { parseSettings } from "../lib/settings.mjs";

const AT = "2026-01-02T03:04:05.000Z";
const now = () => AT;
const REPO = "steveafrost/bb-plugin-catchup";

const issue = (overrides = {}) => ({
  number: 7,
  title: "Sync records a run error when a repo fails",
  body: "A failing repo must not abort the rest of the run.",
  labels: [{ name: "bug" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function deps(overrides = {}) {
  return {
    listIssues: async () => [issue()],
    showThread: async () => ({ thread: { id: "thr_abc", title: "Catchup work", status: "active" } }),
    threadOutput: async () => null,
    threadLog: async () => [],
    ...overrides,
  };
}

function settingsOf(values) {
  return parseSettings(values);
}

test("an issue becomes an item with a stable github id", () => {
  const entry = issueToItem(REPO, issue(), AT);
  assert.equal(entry.id, "github:steveafrost/bb-plugin-catchup#7");
  assert.equal(entry.workstreamId, "repo:steveafrost/bb-plugin-catchup");
  assert.equal(entry.kind, "issue");
  assert.equal(entry.state, "open");
  assert.equal(entry.url, "https://github.com/steveafrost/bb-plugin-catchup/issues/7");
  assert.equal(entry.number, 7);
  assert.equal(entry.evidence, "");
});

test("the id does not change when the title or body changes", () => {
  const before = issueToItem(REPO, issue(), AT);
  const after = issueToItem(REPO, issue({ title: "Renamed", body: "Rewritten" }), "2026-02-02T00:00:00.000Z");
  assert.equal(before.id, after.id);
});

test("a `blocked` label makes the issue a blocker", () => {
  assert.equal(issueKind(issue({ labels: [{ name: "blocked" }] })), "blocker");
  assert.equal(issueKind(issue({ labels: [{ name: "Blocked: waiting-on-design" }] })), "blocker");
  assert.equal(issueKind(issue({ labels: ["blocked"] })), "blocker");
});

test("a body heading that reads 'Blocked on' makes the issue a blocker", () => {
  assert.equal(issueKind(issue({ body: "## Blocked on\n\nA decision from Sam." })), "blocker");
  assert.equal(issueKind(issue({ body: "Intro.\n\nBlocked on: the API key.\n" })), "blocker");
});

test("prose that merely mentions blocked does not", () => {
  assert.equal(issueKind(issue({ body: "This used to be blocked on design, but it is not any more." })), "issue");
});

test("a blocker item is created in the blocked state and carries its evidence", () => {
  const entry = issueToItem(REPO, issue({ labels: [{ name: "blocked" }] }), AT);
  assert.equal(entry.kind, "blocker");
  assert.equal(entry.state, "blocked");
  assert.match(entry.evidence, /^label: blocked/);
});

test("detail is one bounded line, not the whole body", () => {
  const body = `${"x".repeat(2_000)}\n\n## Section\n\nMore.`;
  const entry = issueToItem(REPO, issue({ body }), AT);
  assert.ok(entry.detail.length <= 400);
  assert.ok(!entry.detail.includes("\n"));
});

test("thread state maps status and outstanding todos", () => {
  assert.equal(threadState({ status: "active" }, null), "active");
  assert.equal(threadState({ status: "starting" }, null), "active");
  assert.equal(threadState({ status: "error" }, null), "blocked");
  // Idle with work left is waiting on someone — that is what blocked means here.
  assert.equal(threadState({ status: "idle" }, { items: [{ status: "pending" }] }), "blocked");
  assert.equal(threadState({ status: "idle" }, { items: [{ status: "completed" }] }), "idle");
  assert.equal(threadState({ status: "idle" }, null), "idle");
  assert.equal(threadState({}, null), "idle");
});

test("lastAgentMessage takes the final agent message and ignores other events", () => {
  const events = [
    { type: "item/completed", data: { item: { type: "agentMessage", text: "first" } } },
    { type: "item/reasoning/textDelta", data: { item: { type: "reasoning", text: "thinking" } } },
    { type: "item/completed", data: { item: { type: "agentMessage", text: "second" } } },
    { type: "item/commandExecution/outputDelta", data: {} },
  ];
  assert.equal(lastAgentMessage(events), "second");
  assert.equal(lastAgentMessage([]), "");
  assert.equal(lastAgentMessage(null), "");
});

test("threadSummary prefers the final output, bounded to one line", () => {
  assert.equal(threadSummary({ output: "Shipped it.", events: [] }), "Shipped it.");
  assert.equal(
    threadSummary({ output: null, events: [{ data: { item: { type: "agentMessage", text: "Still going." } } }] }),
    "Still going.",
  );
  assert.equal(threadSummary({ output: "a\n\nb", events: [] }), "a b");
  assert.ok(threadSummary({ output: "y".repeat(500), events: [] }).length <= 240);
  assert.equal(threadSummary({ output: null, events: [] }), "");
});

test("sync builds one workstream per repo and one item per issue", async () => {
  const { ledger, run } = await syncLedger({
    settings: settingsOf({ repos: REPO }),
    previous: null,
    deps: deps(),
    now,
  });
  assert.equal(ledger.workstreams.length, 1);
  assert.equal(ledger.workstreams[0].id, `repo:${REPO}`);
  assert.equal(ledger.workstreams[0].state, "active");
  assert.equal(ledger.workstreams[0].summary, "1 open item");
  assert.equal(ledger.items.length, 1);
  assert.equal(run.errors.length, 0);
  assert.equal(run.workstreams, 1);
  assert.equal(run.items, 1);
});

test("a repo with no open issues is idle, not absent", async () => {
  const { ledger } = await syncLedger({
    settings: settingsOf({ repos: REPO }),
    previous: null,
    deps: deps({ listIssues: async () => [] }),
    now,
  });
  assert.equal(ledger.workstreams.length, 1);
  assert.equal(ledger.workstreams[0].state, "idle");
  assert.deepEqual(ledger.items, []);
});

test("a failing repo is recorded and the next repo still syncs", async () => {
  const { ledger, run } = await syncLedger({
    settings: settingsOf({ repos: "acme/broken,acme/working" }),
    previous: null,
    deps: deps({
      listIssues: async (repo) => {
        if (repo === "acme/broken") throw new Error("gh: not logged in");
        return [issue({ number: 1, title: "Fine" })];
      },
    }),
    now,
  });
  assert.equal(run.errors.length, 1);
  assert.equal(run.errors[0].source, "repo:acme/broken");
  assert.match(run.errors[0].message, /not logged in/);
  // The failed repo keeps a workstream, marked blocked, so its absence is visible.
  const broken = ledger.workstreams.find((entry) => entry.id === "repo:acme/broken");
  assert.equal(broken.state, "blocked");
  assert.match(broken.summary, /could not be read/);
  // The healthy repo is unaffected.
  assert.deepEqual(ledger.items.map((entry) => entry.id), ["github:acme/working#1"]);
});

test("a failing repo keeps the items it had last time", async () => {
  const previous = {
    version: 1,
    updatedAt: AT,
    workstreams: [{ id: "repo:acme/broken", name: "acme/broken", repo: "acme/broken", threadId: "", state: "active", summary: "", updatedAt: AT }],
    items: [{
      id: "github:acme/broken#3", workstreamId: "repo:acme/broken", title: "Known issue", detail: "",
      kind: "issue", state: "open", url: "https://github.com/acme/broken/issues/3",
      repo: "acme/broken", number: 3, threadId: "", evidence: "", updatedAt: AT,
    }],
  };
  const { ledger } = await syncLedger({
    settings: settingsOf({ repos: "acme/broken" }),
    previous,
    deps: deps({ listIssues: async () => { throw new Error("boom"); } }),
    now,
  });
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].state, "open");
});

test("an issue closed since the last sync is marked done, not dropped", async () => {
  const previous = {
    version: 1,
    updatedAt: AT,
    workstreams: [{ id: `repo:${REPO}`, name: REPO, repo: REPO, threadId: "", state: "active", summary: "", updatedAt: AT }],
    items: [{
      id: `github:${REPO}#9`, workstreamId: `repo:${REPO}`, title: "Fixed", detail: "",
      kind: "issue", state: "open", url: `https://github.com/${REPO}/issues/9`,
      repo: REPO, number: 9, threadId: "", evidence: "", updatedAt: AT,
    }],
  };
  const { ledger } = await syncLedger({
    settings: settingsOf({ repos: REPO }),
    previous,
    deps: deps({ listIssues: async () => [issue({ number: 9 })] }),
    now,
  });
  const kept = ledger.items.find((entry) => entry.number === 9);
  assert.equal(kept.state, "open");

  const { ledger: after } = await syncLedger({
    settings: settingsOf({ repos: REPO }),
    previous: ledger,
    deps: deps({ listIssues: async () => [] }),
    now,
  });
  const closed = after.items.find((entry) => entry.number === 9);
  assert.equal(closed.state, "done");
});

test("a coordinator thread becomes a workstream with its own id and summary", async () => {
  const { ledger } = await syncLedger({
    settings: settingsOf({ coordinatorThreads: "thr_abc=Design" }),
    previous: null,
    deps: deps({
      showThread: async () => ({
        thread: { id: "thr_abc", title: "Catchup work", status: "idle" },
        pendingTodos: { items: [{ status: "pending" }] },
      }),
      threadOutput: async () => "Waiting on the settings shape.",
    }),
    now,
  });
  const workstream = ledger.workstreams[0];
  assert.equal(workstream.id, "thread:thr_abc");
  assert.equal(workstream.name, "Design");
  assert.equal(workstream.state, "blocked");
  assert.equal(workstream.summary, "Waiting on the settings shape.");
});

test("a thread without a label uses its title", async () => {
  const { ledger } = await syncLedger({
    settings: settingsOf({ coordinatorThreads: "thr_abc" }),
    previous: null,
    deps: deps(),
    now,
  });
  assert.equal(ledger.workstreams[0].name, "Catchup work");
});

test("a failing thread is recorded and other threads still sync", async () => {
  const { ledger, run } = await syncLedger({
    settings: settingsOf({ coordinatorThreads: "thr_bad,thr_good" }),
    previous: null,
    deps: deps({
      showThread: async (threadId) => {
        if (threadId === "thr_bad") throw new Error("No thread with id thr_bad");
        return { thread: { id: threadId, title: "Fine", status: "active" } };
      },
    }),
    now,
  });
  assert.equal(run.errors.length, 1);
  assert.equal(run.errors[0].source, "thread:thr_bad");
  assert.equal(ledger.workstreams.length, 2);
  assert.equal(ledger.workstreams.find((entry) => entry.threadId === "thr_bad").state, "blocked");
  assert.equal(ledger.workstreams.find((entry) => entry.threadId === "thr_good").state, "active");
});

test("a failing summary read does not lose the thread's state", async () => {
  const { ledger, run } = await syncLedger({
    settings: settingsOf({ coordinatorThreads: "thr_abc" }),
    previous: null,
    deps: deps({
      threadOutput: async () => { throw new Error("log unavailable"); },
    }),
    now,
  });
  assert.equal(run.errors.length, 1);
  assert.equal(run.errors[0].source, "thread:thr_abc:summary");
  assert.equal(ledger.workstreams[0].state, "active");
  assert.equal(ledger.workstreams[0].summary, "");
});

test("a malformed settings entry is a run error, not a crash", async () => {
  const { run } = await syncLedger({
    settings: settingsOf({ repos: "not-a-repo", coordinatorThreads: "ok,bad id" }),
    previous: null,
    deps: deps(),
    now,
  });
  assert.equal(run.errors.length, 2);
  assert.ok(run.errors.some((entry) => entry.source === "settings.repos"));
  assert.ok(run.errors.some((entry) => entry.source === "settings.coordinatorThreads"));
});

test("sync with no sources configured is an empty ledger, not an error", async () => {
  const { ledger, run } = await syncLedger({ settings: settingsOf({}), previous: null, deps: deps(), now });
  assert.deepEqual(ledger.workstreams, []);
  assert.deepEqual(ledger.items, []);
  assert.deepEqual(run.errors, []);
});
