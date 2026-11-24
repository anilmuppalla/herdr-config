// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props as rawProps, closeOverlay, theme, spaces, panes, exec, home, focused, readTextFile, pickFolder } from "herdr";

// Opened from a key (mod.open) there are no props: make a new worktree of the focused space.
const props = () => {
  const p = rawProps() ?? {};
  return p.space || p.folder ? p : { ...p, action: p.action ?? "new", space: focused()?.space };
};

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <main checkout>/.claude/worktrees/<branch, slashes as dashes>,
// where the Claude desktop app also keeps its worktrees.
const ROOT = (main) => `${main}/.claude/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const ADJECTIVES = ["brave", "calm", "eager", "fond", "gentle", "happy", "jolly", "keen", "lively", "merry", "nimble", "proud", "quiet", "swift", "witty", "zesty"];
const NOUNS = ["cello", "chord", "drum", "fiddle", "flute", "harp", "lute", "oboe", "piano", "rhythm", "sitar", "tempo", "tuba", "verse", "viola", "waltz"];
const pickOne = (words) => words[Math.floor(Math.random() * words.length)];
const hex6 = () => Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, "0");
// A worktree name like Claude desktop's: adjective-noun-6 hex digits.
const generatedName = () => `${pickOne(ADJECTIVES)}-${pickOne(NOUNS)}-${hex6()}`;
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// Space names set from the list's Rename, by worktree path, for when it's reopened.
const savedNames = () => {
  try { return JSON.parse(localStorage.getItem("names") ?? "{}"); } catch { return {}; }
};
function saveName(path, name) {
  const names = savedNames();
  if (name) names[path] = name; else delete names[path];
  localStorage.setItem("names", JSON.stringify(names));
}

// The Claude desktop app's local environments, most recently used first: { name, cwd }.
async function claudeFolders(userHome) {
  const text = await readTextFile(`${userHome}/Library/Application Support/Claude/ccd-session-presets.json`).catch(() => null);
  let data;
  try { data = JSON.parse(text ?? "{}"); } catch { return []; }
  const presets = Object.values(data.byAccount ?? {})
    .flatMap((account) => account.presets ?? [])
    .filter((preset) => preset.target?.kind === "local" && preset.target.cwd)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  const seen = new Set();
  return presets
    .filter((preset) => !seen.has(preset.target.cwd) && seen.add(preset.target.cwd))
    .map((preset) => ({ name: preset.name || preset.target.cwd.split("/").pop(), cwd: preset.target.cwd }));
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "space name (optional)" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.act = null; // the list's right-click: { c, mode: "menu" | "rename" | "remove", ... }
    this.renameInput = InputState.new({ value: "", placeholder: "space name" });
    this.renameInput.on("submit", (_e, cx) => this.applyRename(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus(); // the root is mounted from the first frame: keep the keyboard here while loading
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.worktree = true; // the checkbox; it only applies when the folder is in git
    // Showing the folder list instead of the form. Browsing with no space or folder starts there.
    this.picking = this.opening && !this.on && !this.space();
    this.pickAt = 0;
    if (props()?.action !== "remove" && !this.picking) this.input.focus();
    this.folders = [];
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        if (!this.on && (props().action === "new" || this.opening)) this.folders = await claudeFolders(this.userHome);
        this.repo = repo;
        cx.notify();
        // The list (and with it the filter input) only mounts once loading is
        // done, so the keyboard must move there now — a focus call made while
        // loading lands on nothing and the dialog stays keyboard-dead.
        this.handle.focus();
        if (props().action !== "remove" && !this.picking && (!this.opening || this.list)) cx.timer.after(100, () => this.input.focus());
        if (props().branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // A worktree is wanted and possible: the chosen folder is in git.
  wantsWorktree() {
    return this.worktree && Boolean(this.repo);
  }

  blocked() {
    // The list's filter field submits on Enter too; Enter there opens a row, never creates.
    if (this.opening) return true;
    if (props()?.action === "remove") return !this.repo || !this.repo.linked;
    return this.repo === undefined || this.picking;
  }

  go(cx) {
    if (this.busy || this.blocked()) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  // Leaves the folder list, switching to `folder` when one was chosen.
  async choose(folder, cx) {
    this.picking = false;
    this.error = "";
    if (folder && folder !== this.folder) {
      this.folder = folder;
      this.repo = undefined;
      this.list = undefined;
      this.at = 0;
      cx.notify();
      const repo = await repoOf(folder, this.on).catch(() => null);
      // Browsing lists the chosen repo's worktrees.
      const list = this.opening && repo ? await checkouts(repo, this.on) : undefined;
      if (this.folder === folder) [this.repo, this.list] = [repo, list];
    }
    cx.notify();
    if (this.opening && !this.list) this.handle.focus(); else this.input.focus();
  }

  pickRow(index, cx) {
    const folder = this.folders[index];
    cx.spawn(async (cx) => this.choose(folder ? folder.cwd : await pickFolder({ prompt: "Choose" }), cx));
  }

  async work(cx) {
    if (this.busy || this.blocked()) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  // One space per checkout: switches to the space already on `path` (adding a tab
  // when an agent was asked for), else makes one named `name` (unnamed: null).
  // `fresh` always makes a new space, even when one is already on `path`.
  show(path, name, list, fresh = false) {
    const p = props();
    // Outside git there are no checkouts to tell apart: only the same folder counts.
    const there = fresh ? null : list.length
      ? spaceOf(path, list, this.on, spaces(), panes())
      : spaces().find((s) => (s.machine ?? null) === (this.on ?? null) && place(s) === path);
    if (!there) return run("space.new", { ...(name ? { name } : {}), folder: path, machine: this.on ?? "", tab: p.tab, argv: p.argv });
    run("space.select", { id: there.id });
    if (p.argv) run("tab.new", { space: there.id, folder: path, argv: p.argv });
  }

  async create() {
    const list = this.repo ? await checkouts(this.repo, this.on) : [];
    if (!this.wantsWorktree()) {
      const fallback = this.repo?.linked ? `${this.repo.name} / ${this.repo.top.split("/").pop()}` : null;
      // A typed name asks for a new space in this folder (topic spaces); empty reuses one.
      this.show(this.repo?.top ?? this.folder, this.text.trim() || fallback, list, Boolean(this.text.trim()));
      return "";
    }
    // The typed space name also names the folder and its claude/<name> branch (Claude
    // desktop's form); nothing typed: a generated name. A `branch` prop asks for that branch.
    const typed = this.text.trim();
    const asked = props()?.branch?.trim();
    let name = asked ? slug(asked) : (typed && slug(typed.toLowerCase())) || generatedName();
    let branch = asked || `claude/${name}`;
    const taken = async (n) => list.some((c) => c.path === `${ROOT(this.repo.main)}/${n}`)
      || (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/claude/${n}`], this.on)).ok;
    // A typed name never reopens an old branch or folder: it gets a suffix instead.
    if (!asked && typed && (await taken(name))) {
      name = `${name}-${hex6()}`;
      branch = `claude/${name}`;
    }
    // A branch some checkout already has opens there; git can't check it out twice.
    const held = list.find((c) => c.branch === branch);
    if (held) {
      this.show(held.path, held.main ? null : `${this.repo.name} / ${held.path.split("/").pop()}`, list);
      return "";
    }
    const path = `${ROOT(this.repo.main)}/${name}`;
    const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
    // A new branch starts from the remote's default branch, fetched now, never from
    // whatever this space has checked out. No remote: the local main.
    const head = exists ? null : await git(this.repo.main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], this.on);
    const base = head?.ok ? head.out : "main";
    if (head?.ok) await git(this.repo.main, ["fetch", "origin", base.replace(/^origin\//, "")], this.on, 600_000);
    // --no-track: the new branch's upstream is set on its first push, not to main.
    const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "--no-track", "-b", branch, path, base];
    const r = await git(this.repo.top, add, this.on, 600_000);
    if (!r.ok) return r.err || "git worktree add failed.";
    // The typed name, kept for when it's reopened; else "repo / worktree" so every panel says both.
    if (typed && !asked) saveName(path, typed);
    this.show(path, typed && !asked ? typed : `${this.repo.name} / ${name}`, list);
    return "";
  }

  // Closed worktrees first (the ones to reopen), then those with a space.
  shown() {
    const f = this.text.trim().toLowerCase();
    const all = this.list ?? [];
    const spaceList = spaces(), paneList = panes();
    const hasSpace = (c) => (spaceOf(c.path, all, this.on, spaceList, paneList) ? 1 : 0);
    return all
      .filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f))
      .map((c) => ({ c, open: hasSpace(c) }))
      .sort((a, b) => a.open - b.open)
      .map(({ c }) => c);
  }

  // The name a worktree's space gets: what it was renamed to here, else "repo / folder".
  spaceName(c) {
    if (c.main) return null;
    return savedNames()[c.path] ?? `${this.repo.name} / ${c.path.split("/").pop()}`;
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else run("space.new", { ...(c.main ? {} : { name: this.spaceName(c) }), folder: c.path, machine: this.on ?? "" });
  }

  // Right-click on a row: the actions for that worktree.
  startAct(c, cx) {
    this.act = { c, mode: "menu" };
    this.handle.focus();
    cx.notify();
  }

  endAct(cx) {
    this.act = null;
    this.input.focus();
    cx.notify();
  }

  startRename(cx) {
    const c = this.act.c;
    const there = spaceOf(c.path, this.list, this.on, spaces(), panes());
    this.act = { c, mode: "rename" };
    this.renameInput.set_value(there?.name ?? this.spaceName(c) ?? "");
    this.renameInput.focus();
    cx.notify();
  }

  // Renames its space if open, and keeps the name for when it's reopened.
  applyRename(cx) {
    const c = this.act?.c;
    const name = this.renameInput.value().trim();
    if (!c || !name) return;
    const there = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (there) run("space.rename", { id: there.id, name });
    saveName(c.path, name);
    this.endAct(cx);
  }

  // Reads what removing would lose before asking.
  async startRemove(cx) {
    const c = this.act.c;
    this.act = { c, mode: "remove", checked: false };
    cx.notify();
    const status = await git(c.path, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    const { mods, unpushed } = await submodules(c.path, this.on).catch(() => ({ mods: [], unpushed: [] }));
    if (this.act?.c !== c) return;
    this.act = { ...this.act, checked: true, dirty: status.ok && status.out !== "", mods, unpushed, error: status.ok ? "" : status.err };
    cx.notify();
  }

  async confirmRemove(cx) {
    const { c, dirty, mods } = this.act;
    this.act = { ...this.act, busy: true, error: "" };
    cx.notify();
    const there = spaceOf(c.path, this.list, this.on, spaces(), panes());
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    if (there) run("space.close", { id: there.id, confirmed: true });
    const r = await git(this.repo.main, ["worktree", "remove", ...(dirty || mods.length > 0 ? ["--force"] : []), c.path], this.on, 600_000);
    if (!r.ok) {
      this.act = { ...this.act, busy: false, error: r.err || "git worktree remove failed." };
      return cx.notify();
    }
    saveName(c.path, null);
    this.list = await checkouts(this.repo, this.on);
    this.at = Math.min(this.at, Math.max(0, this.shown().length - 1));
    this.endAct(cx);
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const force = this.dirty || mods.length > 0;
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on, 600_000);
    return r.ok ? "" : r.err || "git worktree remove failed.";
  }

  key(e, cx) {
    if (this.picking) {
      const count = this.folders.length + 1; // the last row is Browse…
      if (e.key === "escape") cx.spawn(async (cx) => this.choose(null, cx));
      else if (e.key === "enter") this.pickRow(this.pickAt, cx);
      else if (e.key === "down" || e.key === "up") this.pickAt = (this.pickAt + (e.key === "down" ? 1 : count - 1)) % count;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (this.act) {
      if (e.key === "escape") return this.endAct(cx);
      if (e.key === "enter" && this.act.mode === "remove" && this.act.checked && !this.act.busy) cx.spawn(async (cx) => this.confirmRemove(cx));
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "escape") return this.close();
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    // With the name field focused, its own submit handles Enter.
    if (e.key === "enter" && (props()?.action === "remove" || !this.inputFocused)) return this.go(cx);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.at = i; this.startAct(c, cx); })
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().gap(10).items_center()
        .child(div().font_semibold().text_color(t.foreground).child(this.on && r ? `Open worktree of ${r.name}` : "Open worktree of"))
        .when(!this.on, (el) => el.child(this.folderButton(t)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(this.act ? this.actPanel(t) : h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 right-click rename or remove \u00b7 esc close"));
  }

  // The right-clicked worktree's actions, under the list.
  actPanel(t) {
    const { c, mode } = this.act;
    const there = spaceOf(c.path, this.list ?? [], this.on, spaces(), panes());
    const label = there?.name ?? this.spaceName(c) ?? c.branch ?? "main checkout";
    const cancel = this.button("act-cancel", "Cancel", null, t, (cx) => this.endAct(cx));
    const panel = v_flex().flex_none().gap(8).p(10).rounded(8).border(1).border_color(t.input);
    const error = this.act.error ? div().text_color(t.blocked).child(this.act.error) : null;
    if (mode === "rename") {
      return panel
        .child(div().text_size(12).text_color(t.muted).child(there ? "Rename its space" : "Name its space when reopened"))
        .child(h_flex().gap(8).items_center()
          .child(Input.new(this.renameInput).flex_1().h(28).px(8).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
          .child(cancel)
          .child(this.button("act-save", "Rename", t.accent, t, (cx) => this.applyRename(cx))));
    }
    if (mode === "remove") {
      const { checked, dirty, unpushed = [], busy } = this.act;
      return panel
        .child(div().text_color(t.foreground).child(`Remove ${label}?`))
        .child(div().text_size(12).text_color(t.muted).child(`Deletes ${tilde(c.path, this.userHome ?? "")}${there ? " and closes its space" : ""}. The branch stays.`))
        .when(Boolean(dirty), (el) => el.child(div().text_size(12).text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
        .when(unpushed.length > 0, (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Submodule ${unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
        .when(Boolean(error), (el) => el.child(error))
        .child(h_flex().justify_end().gap(8).items_center()
          .when(!checked || busy, (el) => el.child(div().text_size(11).text_color(t.dim).child(busy ? "removing\u2026" : "checking\u2026")))
          .child(cancel)
          .when(checked && !busy, (el) => el.child(this.button("act-remove", "Remove", t.blocked, t, (cx) => cx.spawn(async (cx) => this.confirmRemove(cx))))));
    }
    return panel
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(label))
        .child(cancel)
        .child(this.button("act-rename", "Rename", null, t, (cx) => this.startRename(cx)))
        .when(!c.main, (el) => el.child(this.button("act-remove-ask", "Remove", t.blocked, t, (cx) => cx.spawn(async (cx) => this.startRemove(cx))))))
      .when(c.main, (el) => el.child(div().text_size(12).text_color(t.dim).child("The main checkout can't be removed.")));
  }

  // The folder list: Claude desktop's environments, then Browse….
  renderPick(t) {
    const row = (label, sub, i, chosen) => {
      const on = i === this.pickAt;
      return h_flex()
        .id(`folder-${i}`)
        .flex_none()
        .h(sub ? 40 : 30)
        .px(10)
        .gap(8)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pickRow(i, cx))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(label))
          .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim).child(sub))))
        .when(chosen, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("current")));
    };
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex()
        .gap(6)
        .items_center()
        .child(h_flex()
          .id("folder-back")
          .size(22)
          .flex_none()
          .items_center()
          .justify_center()
          .rounded(5)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .tooltip("Back")
          .on_click((_e, cx) => cx.spawn(async (cx) => this.choose(null, cx)))
          .child(svg("mods/workspace-chrome/chevron-left.svg").size(14)))
        .child(div().font_semibold().text_color(t.foreground).child("Choose a folder")))
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id("folder-list")
              .size_full()
              .overflow_y_scroll()
              .children(this.folders.map((f, i) => row(f.name, tilde(f.cwd, this.userHome), i, f.cwd === this.folder)))
              .child(row("Browse…", "", this.folders.length, false)),
          )
          .child(Scrollbar.vertical("folder-list").absolute().inset_0()),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↑↓ choose · ↵ select · esc back"));
  }

  // The folder to start from: opens the folder list (Claude desktop's environments; this machine only).
  folderButton(t) {
    return h_flex()
      .id("folder")
      .h(26)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(t.input)
      .cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => {
        this.picking = true;
        this.pickAt = Math.max(0, this.folders.findIndex((f) => f.cwd === this.folder));
        this.handle.focus();
        cx.notify();
      })
      .child(div().text_color(t.foreground).child(this.repo?.name || (this.folder ?? "").split("/").pop() || "Folder"))
      .child(div().text_size(10).text_color(t.dim).child("▾"));
  }

  render(cx) {
    const t = theme();
    if (this.picking) return this.renderPick(t);
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const s = this.space();
    const r = this.repo;
    const worktree = this.wantsWorktree();
    const title = remove ? `Remove worktree ${s?.name ?? ""}?` : worktree ? "New worktree" : "New space";
    const folderText = this.folder ? tilde(this.folder, this.userHome) : "This folder";
    const detail =
      r === undefined
        ? "…"
        : remove
          ? r === null
            ? `${folderText} is not in a git repository.`
            : !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`
          : worktree
            ? `Creates a worktree in ${tilde(ROOT(r.main), this.userHome)}/ from the latest origin/main and opens it in a new space. Leave the name empty for a generated one.`
            : `Opens a new space in ${folderText}.${r === null ? " It isn't a git repository, so it can't have worktrees." : ""}`;
    const blocked = this.blocked();
    // The folder to start from and the Worktree checkbox.
    const picker = h_flex()
      .gap(12)
      .items_center()
      .when(!this.on, (el) => el.child(this.folderButton(t)))
      .child(h_flex()
        .id("worktree-toggle")
        .gap(6)
        .items_center()
        .when(Boolean(r), (el) => el.cursor_pointer().on_click((_e, cx) => {
          this.worktree = !this.worktree;
          this.input.focus();
          cx.notify();
        }))
        .child(div().size(14).rounded(3).border(1).border_color(worktree ? t.accent : t.input).when(worktree, (el) => el.bg(t.accent)))
        .child(div().text_color(r ? t.foreground : t.dim).child("Worktree")));
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .when(!remove, (el) => el.child(picker))
      .child(div().text_color(t.muted).child(detail))
      .when(remove && this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(remove && this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(!remove && !blocked, (el) =>
        el.child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .items_center()
          .gap(8)
          .when(this.busy, (el) => el.child(h_flex().gap(6).text_size(11).text_color(t.dim)
            .child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
            .child("working…")))
          .when(!this.busy, (el) => el
            .child(this.button("cancel", blocked ? "Close" : "Cancel", null, t, () => this.close()))
            .when(!blocked, (el) => el.child(this.button("confirm", remove ? "Remove" : worktree ? "Create" : "Open", remove ? t.blocked : t.accent, t, (cx) => this.go(cx))))),
      );
  }

  // A footer button; `fill` makes it the primary one.
  button(id, label, fill, t, act) {
    return h_flex()
      .id(`button-${id}`)
      .h(28)
      .px(12)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(12.5)
      .when(Boolean(fill), (el) => el.bg(fill).text_color("#ffffff").hover((st) => st.opacity(0.9)))
      .when(!fill, (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((st) => st.bg(t.hover)))
      .on_click((_e, cx) => act(cx))
      .child(label);
  }
}
