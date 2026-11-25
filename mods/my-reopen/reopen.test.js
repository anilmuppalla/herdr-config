import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeSessions, snapshot, closedTabs, reopenCommand } from "./reopen.js";

const spaces = [
  { id: "sp1", name: "research", named: true, folder: "", machine: null, tabs: [
    { id: "tb1", name: "notes", named: true },
    { id: "tb2", name: "2", named: false },
    { id: "tb4", name: "3", named: false },
  ] },
  { id: "vps/sp2", name: "box", named: false, folder: "", machine: "vps", tabs: [{ id: "vps/tb3", name: "1", named: false }] },
];
const panes = [
  { pane: "p1", tab: "tb1", terminal: "t1", cwd: "/r" },
  { pane: "p2", tab: "tb1", terminal: null, mod: "files" },
  { pane: "p3", tab: "tb1", terminal: "t2", cwd: "/r/sub" },
  { pane: "p4", tab: "tb2", terminal: "t3", cwd: "/x" },
  { pane: "p5", tab: "tb4", terminal: null, mod: "board" },
];

test("claudeSessions keeps labels only on terminals running Claude now", () => {
  const agents = [{ address: "t2", app: "claude-code", program: { key: "claude" } }, { address: "t4", app: "codex", program: { key: "codex" } }];
  const terms = [
    { address: "t1", labels: { "claude.session": "old" } }, // Claude exited: shell only
    { address: "t2", labels: { "claude.session": "abc" } },
    { address: "t4", labels: {} },
  ];
  assert.deepEqual(claudeSessions(agents, terms), { t2: "abc" });
});

test("snapshot keeps this machine's terminal tabs, resuming the first Claude pane in its folder", () => {
  assert.deepEqual(snapshot(spaces, panes, { t2: "abc" }), {
    tb1: { space: "sp1", spaceLabel: "research", spaceName: "research", name: "notes", folder: "/r/sub", session: "abc" },
    tb2: { space: "sp1", spaceLabel: "research", spaceName: "research", name: null, folder: "/x", session: null },
  });
  assert.equal(snapshot(spaces, panes, {}).tb1.folder, "/r");
});

test("closedTabs finds tabs that are gone, not ones left with only a mod pane", () => {
  const before = snapshot(spaces, panes, {});
  assert.deepEqual(closedTabs(before, [{ ...spaces[0], tabs: [spaces[0].tabs[1]] }]), [before.tb1]);
  // tb1's terminals closed but its files pane is still open: tb1 is still a tab.
  assert.deepEqual(closedTabs(before, spaces), []);
});

test("reopenCommand makes a tab in the old space, or a new space when it is gone", () => {
  const e = { space: "sp1", spaceLabel: "research", spaceName: "research", name: "notes", folder: "/r", session: "abc" };
  assert.deepEqual(reopenCommand(e, spaces),
    ["tab.new", { folder: "/r", argv: ["claude", "--resume", "abc"], name: "notes", space: "sp1" }]);
  assert.deepEqual(reopenCommand(e, []),
    ["space.new", { folder: "/r", argv: ["claude", "--resume", "abc"], name: "research", tab: "notes" }]);
  assert.deepEqual(reopenCommand({ ...e, name: null, session: null }, spaces), ["tab.new", { folder: "/r", space: "sp1" }]);
  // Its space closed and an earlier reopen made a new one with the same name: go there.
  const remade = [{ id: "sp9", name: "research", machine: null, tabs: [] }];
  assert.deepEqual(reopenCommand({ ...e, space: "gone" }, remade)[1].space, "sp9");
});
