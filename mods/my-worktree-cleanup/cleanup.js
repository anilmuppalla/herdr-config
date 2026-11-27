// Pure helpers for my-worktree-cleanup. No Herdr calls here, so tests can run
// them on plain data.

/** Ignored folders that a build or install recreates; anything else ignored
 *  (an .env, local notes) keeps the worktree. */
export const REGENERABLE = new Set(["node_modules", ".venv", "venv", "dist", "build", ".next", "__pycache__", ".turbo", ".pytest_cache", ".mypy_cache", ".ruff_cache", "target", "coverage"]);

/** Where a space is now: its first terminal's live folder, or null with no terminal. */
export function place(space, panes) {
  const tabs = new Set(space.tabs.map((t) => t.id));
  return panes.find((p) => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd || null;
}

/** `git rev-parse --show-toplevel --show-prefix --path-format=absolute --git-common-dir`
 *  output, run in `folder` -> { top, tops, main } for a linked worktree, else null.
 *  `tops` holds the checkout's root as git spells it and as Herdr spelled `folder`
 *  (they differ through symlinks such as /tmp). */
export function parseCheckout(stdout, folder) {
  const [top, prefix, common] = stdout.split("\n");
  if (!top || common === undefined || common === `${top}/.git`) return null;
  const depth = prefix.split("/").filter(Boolean).length;
  const seen = depth ? folder.split("/").slice(0, -depth).join("/") : folder.replace(/\/$/, "");
  return { top, tops: [...new Set([top, seen])], main: common.replace(/\/\.git$/, "") };
}

/** Ids in `known` (space id -> { machine, ... }) whose space is gone, on a machine whose
 *  layout is loaded. The caller forgets all of them, worktree or not. */
export const closed = (known, spaces, ready) => {
  const open = new Set(spaces.map((s) => s.id));
  return Object.keys(known).filter((id) => !open.has(id) && ready.has(known[id].machine));
};

/** Does any live terminal on `machine` sit in one of `tops` (or below it)? */
export function inUse(tops, machine, spaces, panes) {
  const tabs = new Set(spaces.filter((s) => (s.machine ?? null) === machine).flatMap((s) => s.tabs.map((t) => t.id)));
  return panes.some((p) => p.terminal && p.cwd && tabs.has(p.tab) && tops.some((t) => p.cwd === t || p.cwd.startsWith(`${t}/`)));
}

/** The `git worktree list --porcelain -z` record for `top`: { detached }, or null. */
export function worktreeRecord(stdout, top) {
  for (const rec of stdout.split("\0\0")) {
    const fields = rec.split("\0").filter(Boolean);
    if (fields[0] === `worktree ${top}`) return { detached: fields.includes("detached") };
  }
  return null;
}

/** Ignored paths (`git ls-files --others --ignored --exclude-standard --directory -z`)
 *  that removal would lose: those not inside a regenerable folder. */
export const keptIgnored = (stdout) =>
  stdout.split("\0").filter(Boolean).filter((p) => !p.split("/").some((seg) => REGENERABLE.has(seg)));
