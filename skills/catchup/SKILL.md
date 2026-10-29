---
name: catchup
description: Read the daily catchup ledger with the `bb catchup` CLI — which workstreams exist, what each is doing, what is open, and what is blocked on the user. Use when the user asks for a catchup, a status sweep, what they are blocked on, what happened while they were away, or asks to refresh the ledger.
---

# Catchup

The Catchup plugin keeps one **ledger**: a list of workstreams (a repo or a
coordinator thread), what each one is doing, which issues are open on it, and
which of those are blocked on the user. The Catchup page in the BB sidebar and
the `bb catchup` command read the same ledger.

The ledger is not a task list. It is a summary of what is already out there:
GitHub issues and BB threads that exist without anyone asking for them.

## Commands

| Command | Effect |
| --- | --- |
| `bb catchup sync` | Read every configured repo and thread, rewrite the ledger, record a run. |
| `bb catchup list` | Show every workstream with its state, summary, and items. |
| `bb catchup list --workstream <id>` | Narrow to one workstream. |
| `bb catchup list --state open\|blocked\|done` | Narrow to items in one state. |
| `bb catchup export` | Project the open items in Pulse's shape. Read-only. |
| `bb catchup log` | Show the most recent sync run, including its errors. |
| `bb catchup runs` | Show recent sync runs. `--limit n` for more or fewer. |

Add `--json` to any command when the output drives code or another agent.

## States

A workstream is `active` (moving), `idle` (nothing open), `blocked` (cannot
proceed, or could not be read), or `done`. An item is `open`, `blocked`, or
`done`.

`blocked` on an item means the issue itself says so: it carries a `blocked`
label, or its body has a `Blocked on` heading or line. Nothing infers a blocker
from silence — an unreadable source marks the *workstream* blocked and records a
run error instead.

## Procedure

1. Run `bb catchup log` first. If the last run is stale or has errors, say so
   before reporting anything as current.
2. Run `bb catchup sync` when the user asks for a fresh catchup, then
   `bb catchup list`.
3. Report per workstream: its state, its summary line, and its open or blocked
   items. Quote the item id when the user may want to act on it.
4. Lead with what is blocked on the user, then what is moving. Do not read the
   whole ledger back verbatim — summarize.
5. If `sync` reported errors, name each failing source. A source that could not
   be read is not a source with nothing in it.

## Rules

- `sync` is the only writer. Do not edit `ledger.json` or `runs.jsonl` directly,
  and do not write to the plugin's data directory.
- Never infer that an item is done because it stopped appearing: `sync` marks
  closed issues `done` itself, and only after a successful read.
- `export` implements the contract Pulse consumes. Do not reshape its output or
  rename its ids — `catchup:<itemId>` is what Pulse keys user state on.
- Configure sources with `bb plugin config catchup`, not by editing files:
  `repos` takes `owner/repo` entries and `coordinatorThreads` takes thread ids,
  optionally labeled as `id=Label`.
