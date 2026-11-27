import { test } from "node:test";
import assert from "node:assert/strict";
import { place, parseCheckout, closed, inUse, worktreeRecord, keptIgnored } from "./cleanup.js";

const local = new Set([null]);

test("place uses the first terminal's live folder, null without one", () => {
  const s = { id: "sp1", folder: "/made", tabs: [{ id: "tb1" }] };
  assert.equal(place(s, [{ tab: "tb1", terminal: "t1", cwd: "/now" }]), "/now");
  assert.equal(place(s, [{ tab: "tb1", terminal: null, cwd: "/mod" }]), null);
  assert.equal(place(s, [{ tab: "other", terminal: "t2", cwd: "/x" }]), null);
});

test("parseCheckout finds a linked worktree and keeps paths exact", () => {
  assert.deepEqual(parseCheckout("/r/.claude/worktrees/w \n\n/r/.git\n", "/r/.claude/worktrees/w "),
    { top: "/r/.claude/worktrees/w ", tops: ["/r/.claude/worktrees/w "], main: "/r" });
  assert.equal(parseCheckout("/r\n\n/r/.git\n", "/r"), null); // the main checkout
});

test("parseCheckout also gives the root as Herdr spells it", () => {
  const c = parseCheckout("/private/tmp/w\napps/web/\n/private/tmp/r/.git\n", "/tmp/w/apps/web");
  assert.deepEqual(c.tops, ["/private/tmp/w", "/tmp/w"]);
});

test("closed lists every gone space on a loaded machine, worktree or not", () => {
  const known = { sp1: { machine: null }, sp2: { machine: null }, sp3: { machine: "vps" } };
  assert.deepEqual(closed(known, [{ id: "sp2" }], local), ["sp1"]);
});

test("inUse sees any terminal on that machine, not only a space's first", () => {
  const spaces = [{ id: "sp1", machine: null, tabs: [{ id: "tb1" }] }, { id: "v/sp2", machine: "vps", tabs: [{ id: "v/tb2" }] }];
  const panes = [{ tab: "tb1", terminal: "t1", cwd: "/r" }, { tab: "tb1", terminal: "t2", cwd: "/w/src" }, { tab: "v/tb2", terminal: "v/t3", cwd: "/x" }];
  assert.equal(inUse(["/w"], null, spaces, panes), true);
  assert.equal(inUse(["/wx"], null, spaces, panes), false);
  assert.equal(inUse(["/x"], null, spaces, panes), false); // that one is on vps
  assert.equal(inUse(["/x"], "vps", spaces, panes), true);
});

test("worktreeRecord matches the exact path and reads detached", () => {
  const out = "worktree /r\0HEAD a\0branch refs/heads/main\0\0worktree /w \0HEAD b\0detached\0\0";
  assert.deepEqual(worktreeRecord(out, "/w "), { detached: true });
  assert.equal(worktreeRecord(out, "/w"), null);
  assert.deepEqual(worktreeRecord(out, "/r"), { detached: false });
});

test("keptIgnored skips folders a build recreates", () => {
  assert.deepEqual(keptIgnored("node_modules/\0apps/web/.next/\0.env\0apps/api/.env.local\0__pycache__/\0"), [".env", "apps/api/.env.local"]);
  assert.deepEqual(keptIgnored(""), []);
});
