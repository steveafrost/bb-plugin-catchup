// Settings parsing, done once at the boundary.
//
// BB stores these as plain strings, so a typo is a user's typo, not a crash:
// every entry that cannot be understood becomes an error record that `sync`
// puts in `run.errors` (and `bb catchup sync` prints), and the rest of the
// list is still used. Blanks and stray separators are simply skipped.

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Split a comma/newline separated setting, dropping blanks. */
function splitEntries(raw) {
  return String(raw ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * `repos` → `[{ repo }]` plus errors. The workstream id for a repo is
 * `repo:<owner/repo>`, which is also stable across syncs.
 */
export function parseRepos(raw) {
  const repos = [];
  const errors = [];
  const seen = new Set();
  for (const entry of splitEntries(raw)) {
    if (!REPO_PATTERN.test(entry)) {
      errors.push({ source: "settings.repos", message: `ignored malformed repo entry ${JSON.stringify(entry)} (want owner/repo)` });
      continue;
    }
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({ repo: entry });
  }
  return { repos, errors };
}

/**
 * `coordinatorThreads` → `[{ id, label }]` plus errors. `id=Label` labels a
 * thread in the panel; a bare `id` uses the thread's own title.
 */
export function parseCoordinatorThreads(raw) {
  const threads = [];
  const errors = [];
  const seen = new Set();
  for (const entry of splitEntries(raw)) {
    const eq = entry.indexOf("=");
    const id = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const label = eq === -1 ? "" : entry.slice(eq + 1).trim();
    if (!THREAD_ID_PATTERN.test(id)) {
      errors.push({
        source: "settings.coordinatorThreads",
        message: `ignored malformed thread entry ${JSON.stringify(entry)} (want <thread-id> or <thread-id>=Label)`,
      });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    threads.push({ id, label });
  }
  return { threads, errors };
}

/**
 * The whole settings surface. `syncCron` is informational in v1: nothing
 * schedules `sync` yet, so it is parsed and echoed back, not acted on.
 */
export function parseSettings(values) {
  const repos = parseRepos(values?.repos);
  const threads = parseCoordinatorThreads(values?.coordinatorThreads);
  return {
    repos: repos.repos,
    threads: threads.threads,
    syncCron: String(values?.syncCron ?? "").trim(),
    errors: [...repos.errors, ...threads.errors],
  };
}

export const workstreamIdForRepo = (repo) => `repo:${repo}`;
export const workstreamIdForThread = (threadId) => `thread:${threadId}`;
