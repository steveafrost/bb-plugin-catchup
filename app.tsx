// bb-plugin-catchup — a BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled),
// so this file must be loaded by BB, not imported directly.
//
// Read-only by design: the ledger is written by `bb catchup sync`, and a
// panel that could also write would give the user two ways to change the same
// rows with only one of them recorded in the run history. Showing state plus
// the last run is the whole job.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Item, Ledger, Run, Workstream } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type LedgerPayload = { ledger: Ledger; lastRun: Run | null };

/** The ledger, kept current by the server's "ledger-changed" signal. */
function useLedger() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<LedgerPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("ledger_get").then((result) => {
      setData(result);
      setError(null);
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  // sync publishes after every write, so a run started from a shell lands here
  // without a manual refresh.
  useRealtime("ledger-changed", refetch);
  return { data, error };
}

// State colours come from theme tokens, never hardcoded grays: `destructive`
// for what needs the user, `muted` for asleep, default for moving.
const WORKSTREAM_BADGE: Record<Workstream["state"], string> = {
  active: "border-border bg-muted text-foreground",
  blocked: "border-destructive/40 bg-destructive/10 text-destructive",
  idle: "border-border bg-transparent text-muted-foreground",
  done: "border-border bg-transparent text-muted-foreground line-through",
};

const KIND_LABEL: Record<Item["kind"], string> = {
  issue: "issue",
  decision: "decision",
  blocker: "blocker",
  release: "release",
  note: "note",
};

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ItemRow({ item }: { item: Item }) {
  const body = (
    <>
      <Icon
        name={item.kind === "blocker" ? "OctagonAlert" : "CircleDot"}
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          item.state === "blocked" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", item.state === "done" && "line-through text-muted-foreground")}>
          {item.title}
        </span>
        {item.evidence === "" ? null : (
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
            {item.evidence}
          </span>
        )}
      </span>
      <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
        {item.id}
      </span>
      <Badge className="border-border text-muted-foreground">{KIND_LABEL[item.kind]}</Badge>
    </>
  );
  const className = "flex items-start gap-2.5 py-2";
  // Only http(s) URLs reach the ledger (validated on read), and a plain anchor
  // is enough: opening an issue in a tab should not need plugin plumbing.
  return item.url === null ? (
    <li className={className}>{body}</li>
  ) : (
    <li className={className}>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 flex-1 items-start gap-2.5 hover:underline"
      >
        {body}
      </a>
    </li>
  );
}

function WorkstreamSection({ workstream, items }: { workstream: Workstream; items: Item[] }) {
  return (
    <section className="mt-5 first:mt-0">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="min-w-0 truncate text-sm font-semibold">{workstream.name}</h2>
        <Badge className={WORKSTREAM_BADGE[workstream.state]}>{workstream.state}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {workstream.summary}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="mt-1 pl-1 text-xs text-muted-foreground">No items.</p>
      ) : (
        <ul className="mt-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-3">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The dashed box BB's own list pages use for loading and empty states. */
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function RunFooter({ run }: { run: Run | null }) {
  if (run === null) {
    return (
      <p className="text-xs text-muted-foreground">
        No sync has run yet. Run <code>bb catchup sync</code>.
      </p>
    );
  }
  return (
    <div className="text-xs text-muted-foreground">
      <p>
        Last sync {new Date(run.finishedAt).toLocaleString()} — {run.workstreams} workstream(s),{" "}
        {run.items} item(s)
        {run.errors.length === 0 ? "" : `, ${run.errors.length} error(s)`}
      </p>
      {run.errors.length === 0 ? null : (
        <ul className="mt-1 space-y-0.5">
          {run.errors.map((entry, index) => (
            <li key={`${entry.source}-${index}`} className="text-destructive">
              <span className="font-mono">{entry.source}</span>: {entry.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Tailwind classes compile against the host theme's live CSS variables. The
// frame (scrolling page, centered column) matches BB's own nav-panel pages.
function CatchupPage() {
  const { data, error } = useLedger();
  const ledger = data?.ledger ?? null;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          The daily catchup ledger: what each workstream is doing and what is blocked on you.
          Collected by <code>bb catchup sync</code>; Pulse reads{" "}
          <code>bb catchup export --json</code>.
        </p>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4">
          {ledger === null ? (
            <EmptyState>Loading the ledger…</EmptyState>
          ) : ledger.workstreams.length === 0 ? (
            <EmptyState>
              Nothing collected yet. Set <code>repos</code> and{" "}
              <code>coordinatorThreads</code> in the Catchup settings, then run{" "}
              <code>bb catchup sync</code>.
            </EmptyState>
          ) : (
            ledger.workstreams.map((workstream) => (
              <WorkstreamSection
                key={workstream.id}
                workstream={workstream}
                items={ledger.items.filter((item) => item.workstreamId === workstream.id)}
              />
            ))
          )}
        </div>
        <div className="mt-4">
          <RunFooter run={data?.lastRun ?? null} />
        </div>
      </div>
    </div>
  );
}

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. navPanel adds a page to the left sidebar.
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "catchup",
    title: "Catchup",
    icon: "ListTodo",
    // Routed at /plugins/catchup/catchup; the component receives the remainder
    // as `subPath` for deep links within the page.
    path: "catchup",
    component: CatchupPage,
  });
});
