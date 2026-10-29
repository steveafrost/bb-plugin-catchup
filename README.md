# Catchup

A BB plugin that owns a **daily catchup ledger**: which workstreams exist, what
each one is doing, which issues are open, and what is blocked on you.

It is not a task list. It is not a Pulse clone. Pulse (Third Hand) reads
`bb catchup export --json` and decides what to surface; nothing in this plugin
writes to Pulse.

## Surfaces

| Surface | What it does |
| --- | --- |
| Catchup page (sidebar) | Read-only view: workstreams grouped, items with state and kind, last run and its errors. |
| `bb catchup` | `sync`, `list`, `export`, `log`, `runs`. `--json` on all of them. |
| `skills/catchup/SKILL.md` | Tells an agent how to read the ledger and what not to assume. |

## Data model

Two files in the plugin's data directory
(`<dataDir>/plugins/catchup/`), both written atomically and at mode 0600:

- `ledger.json` — `{ version, updatedAt, workstreams[], items[] }`
- `runs.jsonl` — one line per sync run, newest last

A **workstream** is a repo (`repo:<owner/repo>`) or a coordinator thread
(`thread:<threadId>`). An **item** belongs to one workstream and has a stable id
that never changes when its title, body, or state does:

```
github:<owner/repo>#<number>      e.g. github:steveafrost/bb-plugin-catchup#7
```

Kinds: `issue`, `decision`, `blocker`, `release`, `note`. States: `open`,
`done`, `blocked`. Sync v1 emits only `issue` and `blocker`; the other kinds
exist so a future writer does not need a schema change.

The ledger is **validated on read**. A damaged file throws rather than reading
as empty — an empty ledger would look like "nothing is happening", which is the
worst failure mode for this kind of tool.

## Sync

`bb catchup sync` reads every configured source and rewrites the ledger. Its
rules:

- **One dead source costs one run error.** A failing repo or thread is recorded
  in `runs.jsonl`, its workstream is marked `blocked` with the reason, its
  previous items are kept, and the rest of the run continues.
- **Absent is not closed.** An issue that disappears from `gh issue list` after
  a *successful* read is marked `done`, not deleted. After a *failed* read,
  nothing is marked done.
- **`gh` and `bb` calls are bounded** (30s, 8MB). A hung source becomes a
  recorded error, not a stalled sync.
- **No reasoning traces.** Issue bodies are clipped to 400 characters of a
  single line; titles to 200; thread summaries to 240. The last agent message of
  a thread is the summary — nothing walks the transcript.

An idle thread with pending todos is `blocked`: something is waiting on
someone. A thread with `status: error` is `blocked`. Threads never become `done`
— BB has no "finished" thread status, and inventing one would be a lie.

## Export

`bb catchup export` projects open and blocked items into the shape Pulse reads:

```
{ version, updatedAt, workstreams[], entries[] }
```

Each entry carries `id: "catchup:<itemId>"`, a Pulse `kind`
(`decision | review | followup | fyi`), title, detail, url, `source: "catchup"`,
the workstream, and up to three quick actions.

**`catchup:<itemId>` is the contract.** Pulse keys its own user state (done,
snooze, dismiss) on it, so it must stay stable across renames, edits, and state
transitions. Changing the prefix or the id scheme orphans every item Pulse has
already shown.

## Settings

Declarative, editable with `bb plugin config catchup`:

| Setting | Shape |
| --- | --- |
| `repos` | Comma-separated `owner/repo` |
| `coordinatorThreads` | Comma-separated thread ids, optionally `id=Label` |
| `syncCron` | Cron expression. **Informational in v1** — nothing schedules sync yet. |

A malformed entry becomes a run error naming the entry; it never aborts the run
and never blocks the well-formed entries.

## Deliberate v1 omissions

- **Nothing schedules `sync`.** `syncCron` is recorded, not honoured. Adding a
  timer means deciding what happens when it fires with no user present.
- **Nothing writes item state by hand.** The panel is read-only. A manual writer
  would create a second, unrecorded path into a ledger whose whole value is that
  each row traces to a run.
- **No Pulse-side code.** `export`'s contract is implemented; the consumer is
  not this repo.
- **No cross-repo grouping.** A workstream is one repo or one thread. Grouping
  several repos under one workstream needs a stable grouping id that settings do
  not have yet.

## Development

```bash
npm install          # once
npm run typecheck    # tsc --noEmit, clean
npm test             # node --test test/*.test.mjs
npm run build        # bb plugin build → dist/
```

`lib/*.mjs` is plain JavaScript so `node --test` loads it without a build step.
Each module has a `.d.mts` beside it declaring the types `server.ts` compiles
against; keep them in step when a signature changes.

Tests inject their dependencies (`listIssues`, `showThread`, `threadOutput`,
`threadLog`), so no test shells out to `gh` or `bb` or touches the network.
