// What a closed tab needs to come back, and the command that brings it back.
// No Herdr calls here, so tests can run it on plain data.

/** How many closed tabs are kept. */
export const KEEP = 20;

/** Terminal address -> Claude session id, for terminals running Claude now. The id
 *  comes from the `claude.session` label that ~/.claude/hooks/herdr-session-label.py sets. */
export function claudeSessions(agents, terminals) {
  const claude = new Set(agents.filter((a) => `${a.program?.key ?? ""} ${a.app ?? ""}`.toLowerCase().includes("claude")).map((a) => a.address));
  const out = {};
  for (const t of terminals) if (claude.has(t.address) && t.labels?.["claude.session"]) out[t.address] = t.labels["claude.session"];
  return out;
}

/** This machine's tabs with a terminal, by id: { space, spaceLabel, spaceName, name, folder,
 *  session }. spaceLabel is the space's shown name; the other names are null unless someone
 *  gave one. `session` is the first Claude pane's, and `folder` that pane's
 *  (else the first pane's). */
export function snapshot(spaces, panes, sessions) {
  const tabs = {};
  for (const s of spaces) {
    if (s.machine) continue;
    for (const t of s.tabs) {
      const ps = panes.filter((p) => p.tab === t.id && p.terminal);
      if (!ps.length) continue;
      const c = ps.find((p) => sessions[p.terminal]);
      tabs[t.id] = {
        space: s.id,
        spaceLabel: s.name,
        spaceName: s.named ? s.name : null,
        name: t.named ? t.name : null,
        folder: (c ?? ps[0]).cwd ?? (s.folder || null),
        session: c ? sessions[c.terminal] : null,
      };
    }
  }
  return tabs;
}

/** The tabs in `prev` that are no longer in any space. A tab that only lost its
 *  terminals (a mod pane is left) is still open. */
export const closedTabs = (prev, spaces) => {
  const open = new Set(spaces.flatMap((s) => s.tabs.map((t) => t.id)));
  return Object.keys(prev).filter((id) => !open.has(id)).map((id) => prev[id]);
};

/** [command, args] that reopens `e`: a tab in its space, else in a space on this machine with
 *  the same name (one an earlier reopen made), else in a new space. */
export function reopenCommand(e, spaces) {
  const args = {};
  if (e.folder) args.folder = e.folder;
  if (e.session) args.argv = ["claude", "--resume", e.session];
  const into = spaces.find((s) => s.id === e.space) ?? spaces.find((s) => !s.machine && s.name === e.spaceLabel);
  if (into) {
    if (e.name) args.name = e.name;
    return ["tab.new", { ...args, space: into.id }];
  }
  if (e.spaceName) args.name = e.spaceName;
  if (e.name) args.tab = e.name;
  return ["space.new", args];
}
