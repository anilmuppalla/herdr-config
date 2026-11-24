// The picker's list, built from plain data so `node --test` can run it (no
// "herdr" import here). main.js passes Herdr's spaces, agents and panes in.

/** The query's words, lowercased. */
export const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** True when every word appears somewhere in `text`, in any order and case. */
export function hasAll(text, ws) {
  const t = text.toLowerCase();
  return ws.every((w) => t.includes(w));
}

/** What a tab is called: its name when someone named it, else the terminal
 *  title of the agent in its focused pane (or its first agent), else its number. */
export function tabLabel(ctx, mine, tabPanes) {
  if (ctx.named) return ctx.name;
  const focus = tabPanes.find((p) => p.focused);
  const a = mine.find((x) => x.pane === focus?.pane) ?? mine[0];
  return (a?.title ?? "").replace(/^[\p{So}\s]+/u, "").trim() || ctx.name;
}

/** 0 when every word is in the space or tab name, 1 when every word is in those
 *  plus agent names and the panes' folders, branches and titles, else null. */
export function fieldRank(spaceName, ctx, mine, tabPanes, ws) {
  const names = `${spaceName} ${ctx.name}`;
  if (hasAll(names, ws)) return 0;
  const other = [...mine.map((a) => a.program?.name ?? ""), ...tabPanes.flatMap((p) => [p.cwd ?? "", p.branch ?? "", p.title ?? ""])];
  return hasAll(`${names} ${other.join(" ")}`, ws) ? 1 : null;
}

const NOT_PICKABLE = new Set(["head", "idle", "none"]);
/** The rows arrows and Enter move through. */
export const picks = (rows) => rows.filter((r) => !NOT_PICKABLE.has(r.kind));

/** The selected row's index after the query changes: the first tab, or with a
 *  query and no tab matching, -1 (nothing selected, so Enter does nothing). */
export function firstPick(pickable, query) {
  const i = pickable.findIndex((r) => r.kind === "ctx");
  return query.trim() ? i : Math.max(0, i);
}

/** Every row of the list. `conv` maps tab id → snippet for tabs whose
 *  conversation has every word of `query`. With no query: spaces that need
 *  you, then idle ones under "Idle". With one: name matches, then other-field
 *  matches, then conversation matches ("No matches" when none). */
export function listRows({ spaces, agents, panes, live, machines }, query, conv = new Map()) {
  const ws = words(query);
  const teamOf = (addrs) => {
    let n = 0;
    const walk = (a) => live.filter((x) => x.parent === a).forEach((k) => (n++, walk(k.address)));
    addrs.forEach(walk);
    return n;
  };
  const tiers = [[], [], []];
  for (const w of spaces) {
    const per = [[], [], []];
    for (const ctx of w.tabs) {
      const mine = agents.filter((a) => a.tab === ctx.id);
      const tabPanes = panes.filter((p) => p.tab === ctx.id);
      let rank = fieldRank(w.name, ctx, mine, tabPanes, ws);
      const snippet = rank === null ? conv.get(ctx.id) : undefined;
      if (snippet !== undefined) rank = 2;
      if (rank === null) continue;
      per[rank].push({ w, ctx, mine, label: tabLabel(ctx, mine, tabPanes), snippet, team: teamOf(mine.map((a) => a.address)) });
    }
    per.forEach((ctxs, i) => ctxs.length && tiers[i].push({ w, ctxs }));
  }
  const busy = (gs) => gs.filter((p) => p.w.status).sort((a, b) => (b.w.status === "blocked") - (a.w.status === "blocked"));
  const quiet = (gs) => gs.filter((p) => !p.w.status);
  const out = [];
  const add = (p) => {
    out.push({ kind: "head", w: p.w });
    for (const c of p.ctxs) out.push({ kind: "ctx", ...c });
  };
  if (!ws.length) {
    busy(tiers[0]).forEach(add);
    // Spaces with no agent running, always listed under their own heading.
    if (quiet(tiers[0]).length) {
      out.push({ kind: "idle" });
      quiet(tiers[0]).forEach(add);
    }
  } else {
    for (const t of tiers) [...busy(t), ...quiet(t)].forEach(add);
    if (!out.length) out.push({ kind: "none" });
  }
  out.push({ kind: "new" });
  out.push({ kind: "worktree" });
  out.push({ kind: "browse" });
  for (const m of machines) out.push({ kind: "space", machine: m });
  return out;
}
