// Removes a space's git worktree when the space closes (cmd-w on its last tab,
// the menu's Close, the sidebar). Uses `git worktree remove` without --force, so
// a worktree with uncommitted or untracked files is kept, and the branch stays.
// It also keeps a worktree that another terminal still uses, one with ignored
// files a build doesn't recreate (an .env), and a detached one whose commits are
// on no branch. Draws nothing: it sits in my-layout as an empty floating block.

import { View } from "gpui-kit";
import { spaces, panes, machines, exec, notify, checking } from "herdr";
import { place, parseCheckout, closed, inUse, worktreeRecord, keptIgnored } from "./cleanup.js";

const name = (top) => top.split("/").pop();
const git = (args, on, timeout) => exec("git", args, { on: on ?? undefined, timeout }).catch(() => null);
const kept = (top, body) => notify({ title: `Kept worktree ${name(top)}`, body, level: "warning" });

export default class WorktreeCleanup extends View {
  init() {
    // space id -> { machine, folder, w }: w is the linked worktree its first terminal
    // was last seen in, null for none, undefined while git is checking.
    this.known = {};
    this.removing = new Set(); // "<machine>|<top>" being removed
  }

  async check(id, folder, machine, cx) {
    const r = await git(["-C", folder, "rev-parse", "--show-toplevel", "--show-prefix", "--path-format=absolute", "--git-common-dir"], machine);
    const k = this.known[id];
    if (!k || k.folder !== folder) return; // closed or moved on while git ran
    if (!r) delete this.known[id]; // machine unreachable: try again on a later render
    else {
      const c = r.code === 0 ? parseCheckout(r.stdout, folder) : null;
      k.w = c && { ...c, machine };
    }
    cx.notify();
  }

  async remove(w, cx) {
    const { top, main, machine } = w;
    const list = await git(["-C", main, "worktree", "list", "--porcelain", "-z"], machine);
    if (list?.code !== 0) return kept(top, "Couldn't list the repo's worktrees.");
    const rec = worktreeRecord(list.stdout, top);
    if (!rec) return; // already removed
    if (rec.detached) {
      const on = await git(["-C", top, "for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)"], machine);
      if (on?.code !== 0 || !on.stdout.trim()) return kept(top, "Its detached HEAD has commits on no branch.");
    }
    const ign = await git(["-C", top, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], machine);
    if (ign?.code !== 0) return kept(top, "Couldn't list its ignored files.");
    const lose = keptIgnored(ign.stdout);
    if (lose.length) return kept(top, `It has ignored files: ${lose.slice(0, 3).join(", ")}${lose.length > 3 ? ", ..." : ""}`);
    cx.notify(); // ends this task if a newer build replaced this copy
    // Look again now: a terminal may have opened there, or the machine dropped, while git ran.
    if (!machines().some((m) => m.name === machine && m.layout === "ready")) return;
    if (inUse(w.tops, machine, spaces(), panes())) return;
    const r = await git(["-C", main, "worktree", "remove", top], machine, 600_000);
    if (r?.code === 0) notify({ title: `Removed worktree ${name(top)}`, body: "Its branch is kept.", level: "info", timeout: 3000 });
    else kept(top, (r?.stderr || "git worktree remove failed.").trim().split("\n")[0]);
  }

  render(cx) {
    if (checking()) return "";
    const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name));
    const all = spaces(), ps = panes();
    for (const s of all) {
      const machine = s.machine ?? null;
      const folder = ready.has(machine) && place(s, ps);
      if (!folder || this.known[s.id]?.folder === folder) continue;
      this.known[s.id] = { machine, folder, w: undefined };
      cx.spawn(async (cx) => this.check(s.id, folder, machine, cx));
    }
    for (const id of closed(this.known, all, ready)) {
      const w = this.known[id].w;
      delete this.known[id];
      const key = w && `${w.machine}|${w.top}`;
      if (!w || this.removing.has(key) || inUse(w.tops, w.machine, all, ps)) continue;
      this.removing.add(key);
      cx.spawn(async (cx) => {
        try { await this.remove(w, cx); } finally { this.removing.delete(key); }
      });
    }
    return "";
  }
}
