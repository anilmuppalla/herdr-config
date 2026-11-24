import { test } from "node:test";
import assert from "node:assert/strict";
import { words, hasAll, tabLabel, listRows, picks, firstPick } from "./search.js";

const tab = (id, name, named = true) => ({ id, name, named, status: null });
const data = {
  spaces: [
    { id: "s1", name: "demo-project", status: "working", tabs: [tab("t1", "MCP browser"), tab("t2", "2", false)] },
    { id: "s2", name: "research", status: null, tabs: [tab("t3", "notes"), tab("t4", "4", false)] },
  ],
  agents: [
    { address: "a1", pane: "p1", tab: "t1", title: "✳ Fix the picker", program: { name: "Claude Code" } },
    { address: "a2", pane: "p2", tab: "t2", title: "⠂ Slack thread on MCP eval ground truth", program: { name: "Claude Code" } },
    { address: "a3", pane: "p3", tab: "t3", title: "codex", program: { name: "Codex" } },
  ],
  panes: [
    { pane: "p1", tab: "t1", cwd: "/code/glock", branch: "main", title: "Fix the picker", focused: true },
    { pane: "p2", tab: "t2", cwd: "/code/browser-notes", branch: "feat/mcp", title: "Slack thread", focused: true },
    { pane: "p3", tab: "t3", cwd: "/code/research", branch: null, title: "codex", focused: true },
  ],
  live: [],
  machines: [],
};
const tabIds = (rows) => rows.filter((r) => r.kind === "ctx").map((r) => r.ctx.id);

test("R1: every word must match, in any order and case", () => {
  assert.deepEqual(words("  MCP   Browser "), ["mcp", "browser"]);
  assert.ok(hasAll("Space MCP browser", words("browser mcp")));
  assert.ok(hasAll("Space MCP browser", words("BROWSER Space")));
  assert.ok(!hasAll("Space MCP", words("mcp browser")));
  assert.deepEqual(tabIds(listRows(data, "browser MCP")), ["t1", "t2"]);
  assert.deepEqual(tabIds(listRows(data, "GLOCK picker")), ["t1"]);
  assert.deepEqual(tabIds(listRows(data, "mcp research")), []);
});

test("R1: an empty query lists everything, idle spaces under Idle", () => {
  const rows = listRows(data, "  ");
  assert.deepEqual(tabIds(rows), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(rows.map((r) => r.kind).slice(0, 5), ["head", "ctx", "ctx", "idle", "head"]);
});

test("R2: folders, branches, titles and agent names match; name matches come first", () => {
  assert.deepEqual(tabIds(listRows(data, "feat/mcp")), ["t2"]);
  assert.deepEqual(tabIds(listRows(data, "/code/research")), ["t3"]);
  assert.deepEqual(tabIds(listRows(data, "codex")), ["t3"]);
  assert.deepEqual(tabIds(listRows(data, "claude code")), ["t1", "t2"]);
  assert.deepEqual(tabIds(listRows(data, "slack thread")), ["t2"]);
  // t2 (first space) matches "notes" only by folder; t3 (second space) by its name, so it leads.
  const rows = listRows(data, "notes");
  assert.deepEqual(tabIds(rows), ["t3", "t2"]);
  assert.deepEqual(rows.slice(0, 4).map((r) => r.kind + (r.w?.id ?? "")), ["heads2", "ctxs2", "heads1", "ctxs1"]);
  // A space-name match ("research") beats a folder match elsewhere too.
  assert.deepEqual(tabIds(listRows({ ...data, spaces: [...data.spaces].reverse() }, "research")), ["t3", "t4"]);
});

test("R3: conversation-only matches come last with their snippet", () => {
  const conv = new Map([["t4", "…we chose the thread…"], ["t2", "unused: t2 matches on its title"]]);
  const rows = listRows(data, "thread", conv).filter((r) => r.kind === "ctx");
  assert.deepEqual(rows.map((r) => r.ctx.id), ["t2", "t4"]);
  assert.equal(rows[0].snippet, undefined);
  assert.equal(rows[1].snippet, "…we chose the thread…");
  const late = listRows(data, "zebra", new Map([["t3", "zebra too"], ["t1", "a zebra"]]));
  assert.deepEqual(tabIds(late), ["t1", "t3"]);
  assert.ok(late.filter((r) => r.kind === "ctx").every((r) => r.snippet));
  assert.ok(!late.some((r) => r.kind === "none"));
});

test("R4: no matches shows No matches and selects nothing", () => {
  const rows = listRows(data, "nothing here");
  assert.deepEqual(rows.map((r) => r.kind), ["none", "new", "worktree", "browse"]);
  const pickable = picks(rows);
  assert.deepEqual(pickable.map((r) => r.kind), ["new", "worktree", "browse"]);
  assert.equal(firstPick(pickable, "nothing here"), -1);
  assert.equal(pickable[firstPick(pickable, "nothing here")], undefined);
  assert.equal(firstPick(picks(listRows(data, "mcp")), "mcp"), 0);
  assert.equal(firstPick(picks(listRows(data, "")), ""), 0);
  assert.ok(!picks(listRows(data, "")).some((r) => r.kind === "head" || r.kind === "idle"));
});

test("R6: unnamed tabs show their agent's title, else their number", () => {
  const ctx = tab("t9", "3", false);
  const a = { pane: "pa", title: "✳ First agent" };
  const b = { pane: "pb", title: "⠐ Slack thread on MCP eval ground truth" };
  assert.equal(tabLabel(ctx, [a, b], [{ pane: "pb", focused: true }]), "Slack thread on MCP eval ground truth");
  assert.equal(tabLabel(ctx, [a, b], [{ pane: "pc", focused: true }]), "First agent");
  assert.equal(tabLabel(ctx, [a, b], []), "First agent");
  assert.equal(tabLabel(ctx, [], []), "3");
  assert.equal(tabLabel(ctx, [{ pane: "pa", title: "  " }], []), "3");
  assert.equal(tabLabel(tab("t9", "Named"), [a], []), "Named");
  const labels = listRows(data, "").filter((r) => r.kind === "ctx").map((r) => r.label);
  assert.deepEqual(labels, ["MCP browser", "Slack thread on MCP eval ground truth", "notes", "4"]);
});
