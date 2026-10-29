// bb-plugin-catchup — a BB plugin backend entry.
//
// Catchup owns a daily catchup ledger: which workstreams exist, what each one
// is doing, which issues are open, and what is blocked on the user. It is not
// a task list and it is not a Pulse clone — Pulse (Third Hand) reads
// `bb catchup export --json` and decides what to do with it. Nothing here
// writes to Pulse.
//
// One ledger file in this plugin's data directory serves three surfaces: the
// Catchup page (app.tsx, over RPC), the `bb catchup` CLI (below), and the skill
// in skills/catchup/SKILL.md. `sync` is the only writer today, and it is
// read-only against every source it touches.
import path from "node:path";
import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readLedgerOrEmpty, readRuns, lastRun, appendRun, writeLedger, CatchupError } from "./lib/store.mjs";
import { parseSettings } from "./lib/settings.mjs";
import { syncLedger } from "./lib/sync.mjs";
import type { ThreadDetails } from "./lib/sync.mjs";
import { exportLedger } from "./lib/export.mjs";

/** `gh`/`bb` calls are bounded: a hung source is a recorded error, not a stall. */
const SOURCE_TIMEOUT_MS = 30_000;
const SOURCE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_RUN_LIMIT = 10;

const workstreamSchema = z.object({
  id: z.string(),
  name: z.string(),
  repo: z.string(),
  threadId: z.string(),
  state: z.enum(["active", "blocked", "idle", "done"]),
  summary: z.string(),
  updatedAt: z.string(),
});
const itemSchema = z.object({
  id: z.string(),
  workstreamId: z.string(),
  title: z.string(),
  detail: z.string(),
  kind: z.enum(["issue", "decision", "blocker", "release", "note"]),
  state: z.enum(["open", "done", "blocked"]),
  url: z.string().nullable(),
  repo: z.string(),
  number: z.number().int().nullable(),
  threadId: z.string(),
  evidence: z.string(),
  updatedAt: z.string(),
});
const runSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  workstreams: z.number().int(),
  items: z.number().int(),
  errors: z.array(z.object({ source: z.string(), message: z.string() })),
});

// Both schemas run at the wire boundary. The panel imports only types from
// here; the ledger itself is validated in lib/store.mjs.
export const rpcContract = defineRpcContract({
  ledger_get: {
    input: z.null(),
    output: z.object({
      ledger: z.object({
        version: z.number().int(),
        updatedAt: z.string(),
        workstreams: z.array(workstreamSchema),
        items: z.array(itemSchema),
      }),
      lastRun: runSchema.nullable(),
    }),
  },
});

export type Ledger = z.infer<ReturnType<typeof ledgerSchema>>;
function ledgerSchema() {
  return z.object({
    version: z.number().int(),
    updatedAt: z.string(),
    workstreams: z.array(workstreamSchema),
    items: z.array(itemSchema),
  });
}
export type Workstream = z.infer<typeof workstreamSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Run = z.infer<typeof runSchema>;

/** Realtime channel the panel listens on; `sync` publishes it. */
const LEDGER_CHANGED = "ledger-changed";

function runCommand(file: string, args: string[]): Promise<unknown> {
  // Returns parsed JSON; the caller narrows. A tool that exits non-zero, times
  // out, or prints non-JSON becomes a rejection the caller turns into a run
  // error.
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: SOURCE_TIMEOUT_MS, maxBuffer: SOURCE_MAX_BYTES, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          // Surface the tool's own stderr when it has one: "gh: not logged in"
          // is actionable, "Command failed" is not.
          const detail = typeof error.stderr === "string" ? error.stderr.trim() : "";
          const message = detail !== "" ? detail : error.message;
          reject(new Error(`${file} ${args.slice(0, 3).join(" ")}: ${message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`${file} ${args.slice(0, 3).join(" ")} returned non-JSON output`));
        }
      },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Declarative settings — rendered in BB's settings UI and editable with
  // `bb plugin config catchup`. Settings are read per command, not cached, so
  // a change applies on the next `bb catchup sync` without a reload.
  const settings = bb.settings.define({
    repos: {
      type: "string",
      label: "Repositories",
      description: "Comma-separated owner/repo. Open issues in each become ledger items.",
      experimental_multiline: true,
      default: "",
    },
    coordinatorThreads: {
      type: "string",
      label: "Coordinator threads",
      description: "Comma-separated BB thread ids, optionally labeled as id=Label. Each becomes a workstream; its child threads become its items.",
      experimental_multiline: true,
      default: "",
    },
    syncCron: {
      type: "string",
      label: "Sync schedule (informational)",
      description: "Not scheduled in v1: nothing runs sync for you yet. Recorded here so the intent survives.",
      default: "",
    },
  });

  async function currentSettings() {
    return parseSettings(await settings.get());
  }

  // The plugin's own data directory: `<dataDir>/plugins/<id>/`, the layout the
  // SDK documents for `bb.storage.database()` ("the plugin's own SQLite database
  // at <dataDir>/plugins/<id>/data.db") and for secret files. Read lazily — it
  // comes from the host, and only handlers and CLI runs should depend on it.
  //
  // `experimental_dataDir` itself is documented as "deliberately not a place to
  // write"; that is about bb-managed files, not this plugin's own subdirectory.
  // The ledger goes here rather than in `bb.storage.kv` because it is a document
  // with a schema, one read and one atomic write, not a set of rows — and kv
  // caps a value at 256KB, which a full ledger will pass.
  function dataDir(): string {
    return path.join(bb.server.experimental_dataDir, "plugins", bb.pluginId);
  }

  function ghDeps() {
    return {
      listIssues: async (repo: string) => {
        const rows = await runCommand("gh", [
          "issue", "list", "--repo", repo, "--state", "open", "--limit", "200",
          "--json", "number,title,body,labels,createdAt",
        ]);
        return Array.isArray(rows) ? rows : [];
      },
      showThread: async (threadId: string): Promise<ThreadDetails> => {
        const shown = await runCommand("bb", ["thread", "show", threadId, "--json"]);
        if (shown === null || typeof shown !== "object") throw new Error("bb thread show returned no object");
        return shown as ThreadDetails;
      },
      threadOutput: async (threadId: string) => {
        const result = await runCommand("bb", ["thread", "output", threadId, "--json"]);
        if (result === null || typeof result !== "object") return null;
        const { output } = result as { output?: unknown };
        return typeof output === "string" ? output : null;
      },
      threadLog: async (threadId: string) => {
        const events = await runCommand("bb", ["thread", "log", threadId, "--json", "--limit", "40"]);
        return Array.isArray(events) ? events : [];
      },
    };
  }

  async function runSync() {
    const dir = dataDir();
    const startedAt = new Date().toISOString();
    const parsed = await currentSettings();
    const previous = readLedgerOrEmpty(dir, startedAt);
    const deps = { ...ghDeps(), startedAt };
    const { ledger, run } = await syncLedger({
      settings: parsed,
      previous,
      deps,
      now: () => new Date().toISOString(),
    });
    writeLedger(dir, ledger);
    appendRun(dir, run);
    bb.realtime.publish(LEDGER_CHANGED, { at: ledger.updatedAt });
    return { ledger, run };
  }

  bb.rpc.register(rpcContract, {
    ledger_get: async () => {
      const dir = dataDir();
      return {
        ledger: readLedgerOrEmpty(dir, new Date().toISOString()),
        lastRun: lastRun(dir),
      };
    },
  });

  // The `bb catchup` command. `commands` is metadata BB renders into help and
  // the generated plugin-commands skill without running plugin code; parsing
  // argv is plugin-owned.
  const usage = [
    "Usage:",
    "  bb catchup sync [--json]",
    "  bb catchup list [--workstream <id>] [--state open|blocked|done] [--json]",
    "  bb catchup export [--json]",
    "  bb catchup log [--json]",
    "  bb catchup runs [--limit n] [--json]",
  ].join("\n");

  const STATE_GLYPH: Record<string, string> = { active: "●", blocked: "▲", idle: "○", done: "✓" };
  const ITEM_GLYPH: Record<string, string> = { open: "·", blocked: "▲", done: "✓" };

  function formatLedger(ledger: Ledger): string {
    if (ledger.workstreams.length === 0) {
      return [
        "No workstreams yet.",
        "Set `repos` and/or `coordinatorThreads` with `bb plugin config catchup`, then run `bb catchup sync`.",
      ].join("\n");
    }
    const lines: string[] = [];
    for (const workstream of ledger.workstreams) {
      const glyph = STATE_GLYPH[workstream.state] ?? "?";
      lines.push(`${glyph} ${workstream.name} (${workstream.state}) — ${workstream.id}`);
      if (workstream.summary !== "") lines.push(`    ${workstream.summary}`);
      const items = ledger.items.filter((item) => item.workstreamId === workstream.id);
      for (const item of items) {
        const marker = ITEM_GLYPH[item.state] ?? "?";
        lines.push(`    ${marker} [${item.kind}/${item.state}] ${item.title} — ${item.id}`);
      }
    }
    return lines.join("\n");
  }

  function formatRun(run: Run): string {
    const head = `${run.id}  ${run.startedAt} → ${run.finishedAt}  ${run.workstreams} workstream(s), ${run.items} item(s)`;
    if (run.errors.length === 0) return head;
    const errors = run.errors.map((entry) => `    ✗ ${entry.source}: ${entry.message}`);
    return [head, ...errors].join("\n");
  }

  bb.cli.register({
    name: "catchup",
    summary: "Collect and read the daily catchup ledger",
    commands: [
      { name: "sync", summary: "Collect issues and threads into the ledger", usage: "bb catchup sync [--json]" },
      { name: "list", summary: "Show workstreams and their items", usage: "bb catchup list [--workstream <id>] [--state open|blocked|done] [--json]" },
      { name: "export", summary: "Project open items for Pulse", usage: "bb catchup export [--json]" },
      { name: "log", summary: "Show the most recent sync run", usage: "bb catchup log [--json]" },
      { name: "runs", summary: "Show sync run history", usage: "bb catchup runs [--limit n] [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      const flag = (name: string): string | undefined => {
        const index = rest.indexOf(name);
        return index === -1 ? undefined : rest[index + 1];
      };

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "sync": {
            const { ledger, run } = await runSync();
            const failed = run.errors.length > 0;
            const body = formatRun(run);
            return {
              // Partial success still exits 0: the ledger was written and the
              // errors are visible. Only a total failure would change that.
              exitCode: 0,
              stdout: json ? JSON.stringify({ ledger, run }) : `${body}\n\n${formatLedger(ledger)}`,
              stderr: failed ? `${run.errors.length} source(s) failed; see the run's errors above.` : undefined,
            };
          }

          case "list": {
            const dir = dataDir();
            const ledger = readLedgerOrEmpty(dir, new Date().toISOString());
            const workstreamFilter = flag("--workstream");
            const stateFilter = flag("--state");
            const filtered = {
              ...ledger,
              workstreams: workstreamFilter === undefined
                ? ledger.workstreams
                : ledger.workstreams.filter((entry) => entry.id === workstreamFilter),
            };
            const visibleIds = new Set(filtered.workstreams.map((entry) => entry.id));
            filtered.items = ledger.items.filter((item) =>
              visibleIds.has(item.workstreamId) && (stateFilter === undefined || item.state === stateFilter));
            if (workstreamFilter !== undefined && filtered.workstreams.length === 0) {
              return {
                exitCode: 1,
                stderr: `No workstream with id ${workstreamFilter}. Run "bb catchup list" to see ids.`,
              };
            }
            return reply(filtered, formatLedger(filtered));
          }

          case "export": {
            const dir = dataDir();
            const ledger = readLedgerOrEmpty(dir, new Date().toISOString());
            const projection = exportLedger(ledger);
            const text = projection.entries.length === 0
              ? "Nothing to export: no open or blocked items in the ledger."
              : projection.entries
                  .map((entry) => `${entry.id}  [${entry.kind}] ${entry.title}`)
                  .join("\n");
            return reply(projection, text);
          }

          case "log": {
            const dir = dataDir();
            const run = lastRun(dir);
            if (run === null) {
              return reply(null, "No sync has run yet. Run \"bb catchup sync\".");
            }
            return reply(run, formatRun(run));
          }

          case "runs": {
            const dir = dataDir();
            const raw = flag("--limit");
            const limit = raw === undefined ? DEFAULT_RUN_LIMIT : Number.parseInt(raw, 10);
            if (raw !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
              return { exitCode: 1, stderr: `--limit wants a positive integer, got ${JSON.stringify(raw)}` };
            }
            const runs = readRuns(dir, { limit });
            const text = runs.length === 0
              ? "No sync has run yet."
              : runs.map(formatRun).join("\n");
            return reply(runs, text);
          }
        }
      } catch (error) {
        const message = error instanceof CatchupError
          ? `The ledger could not be read: ${error.message}`
          : error instanceof Error ? error.message : String(error);
        return { exitCode: 1, stderr: message };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // Cleanup on reload/disable/shutdown; hooks run LIFO.
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
