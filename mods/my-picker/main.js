// Go to a tab. Drops from the Terminals layout's space chip (popup, at: "top"). Spaces with
// something that needs you come first, then idle spaces (no agent running)
// under an Idle heading. Type to filter (every word, see search.js; a pause also
// searches open agents' conversations), ↑/↓ and Enter to go, ctrl+d to close
// a tab, Esc to leave. Last rows: a new tab, a new worktree or space, browse worktrees, and a
// space on each connected machine.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, terminals, run, exec, hc, readTextFile, home, theme, settings, props, closeOverlay, openOverlay, shared, setShared } from "herdr";
import { words, listRows, picks, firstPick } from "./search.js";
import { searchTargets, searchConversations } from "./conversations.js";

const IO = { exec, hc, readTextFile, home };
/** How long typing must pause before conversations are searched. */
const PAUSE_MS = 250;

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// Space colors, kept by space id in shared "space.colors": a theme
// color name ("ansi6") or a picked #rrggbb. A space seen without one gets
// the theme color fewest spaces use, once; every mod does the same in the
// same order, so they agree, and adding or renaming spaces moves nothing.
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
function spaceColors() {
  const ids = new Set(spaces().map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
  for (const p of spaces()) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}
function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = spaceColors()[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

export default class Picker extends View {
  init(_props, cx) {
    this.filter = "";
    this.input = InputState.new({ placeholder: "Go to a tab, space or agent…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = firstPick(picks(this.rows()), this.filter);
      this.searchSoon(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(picks(this.rows())[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.at = null;
    this.scroll = 0;
    this.machines = [];
    this.seq = 0;
    this.conv = null;
    this.cache = {};
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  data() {
    return { spaces: spaces(), agents: agents(), panes: panes(), live: terminals().filter((x) => x.state === "live"), machines: this.machines };
  }

  rows() {
    return listRows(this.data(), this.filter, this.conv?.query === this.filter ? this.conv.hits : undefined);
  }

  // Once typing pauses, searches conversations (see searchTargets for which ones).
  // Typing never waits on it, and a result for an older query is dropped.
  searchSoon(cx) {
    this.pending?.cancel();
    const query = this.filter, seq = ++this.seq;
    const ws = words(query);
    if (!ws.length) return;
    this.pending = cx.timer.after(PAUSE_MS, (cx) =>
      cx.spawn(async (cx) => {
        const hits = await searchConversations(IO, searchTargets(this.data(), query), ws, this.cache);
        if (seq !== this.seq) return;
        const key = (r) => r && (r.ctx?.id ?? `${r.kind} ${r.machine ?? ""}`);
        const was = key(picks(this.rows())[this.at]);
        this.conv = { query, hits };
        const now = picks(this.rows());
        this.at = this.at < 0 ? firstPick(now, query) : now.findIndex((r) => key(r) === was);
        cx.notify();
      }),
    );
  }

  go(r) {
    if (!r) return;
    this.close();
    if (r.kind === "ctx") run("tab.select", { id: r.ctx.id });
    else if (r.kind === "new") run("tab.new");
    else if (r.kind === "worktree") openOverlay({ mod: "claude-worktree", kind: "dialog", width: 440, height: 320, props: { action: "new" } });
    else if (r.kind === "browse") openOverlay({ mod: "claude-worktree", kind: "dialog", width: 560, height: 480, props: { action: "open" } });
    else if (r.kind === "space") run("space.new", { machine: r.machine ?? "" });
  }

  glyph(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    return div().w(12).flex_none().text_color(t[st] ?? t.dim).child(st === "idle" ? "○" : st ? "●" : "·");
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = picks(rows);
    // Opens on where you are.
    if (this.at === null) this.at = Math.max(0, pickable.findIndex((r) => r.kind === "ctx" && r.w.active && r.ctx.active));
    this.at = Math.min(this.at, pickable.length - 1);
    const sel = pickable[this.at];
    // One continuous strip: each row (and the group title before it) at a fixed
    // y. Scrolling moves the strip only as far as it takes to keep the selected
    // row in view, so the arrows can't run the selection off the list.
    const H = { head: 29, idle: 33, new: 36, ctx: 32, space: 32 };
    const hOf = (r) => (r.snippet !== undefined ? 50 : H[r.kind] ?? 32);
    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += hOf(r); });
    const total = y;
    const height = Math.min(560, this.listHeight ?? 560);
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scroll) this.scroll = tops[si];
      if (tops[si] + hOf(sel) > this.scroll + height) this.scroll = tops[si] + hOf(sel) - height;
    }
    const place = (el, i) =>
      fixed
        ? el.absolute().left(0).right(0).top(tops[i] - this.scroll).bottom(height - (tops[i] + hOf(rows[i]) - this.scroll))
        : el;
    const visible = (i) => !fixed || (tops[i] + hOf(rows[i]) > this.scroll && tops[i] < this.scroll + height);

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex()
          .px(10)
          .pt(10)
          .pb(3)
          .gap(8)
          .items_center()
          .text_size(11)
          .font_semibold()
          .text_color(t.dim)
          .child(h_flex().size(18).rounded(5).bg(spaceColor(t, r.w)).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...r.w.name][0]?.toUpperCase() ?? "?"))
          .child(r.w.name);
      }
      if (r.kind === "idle") {
        return h_flex()
          .id("pk-idle")
          .mt(6)
          .px(10)
          .pt(8)
          .pb(2)
          .border_t(1)
          .border_color(t.border)
          .text_size(11)
          .font_semibold()
          .text_color(t.dim)
          .child("Idle");
      }
      if (r.kind === "none") return div().id("pk-none").px(14).h(32).flex().items_center().text_color(t.dim).child("No matches");
      const on = r === sel;
      if (r.kind === "new" || r.kind === "worktree" || r.kind === "browse" || r.kind === "space") {
        const label = { new: "New tab", worktree: "New worktree or space…", browse: "Browse worktrees…" }[r.kind] ?? `New space on ${r.machine}`;
        const icon = r.kind === "browse" ? "git-branch" : "plus";
        return h_flex()
          .id(r.kind === "space" ? `pk-space-${r.machine}` : `pk-${r.kind}`)
          .mx(4)
          .when(r.kind === "new", (el) => el.mt(4))
          .px(10)
          .h(32)
          .items_center()
          .rounded(7)
          .gap(8)
          .text_color(t.muted)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13).flex_none())
          .child(label);
      }
      const who = r.mine.map((a) => a.program?.name ?? "agent").join(" · ");
      const here = r.w.active && r.ctx.active;
      const conv = r.snippet !== undefined;
      const line = h_flex()
        .w_full()
        .gap(10)
        .items_center()
        .child(this.glyph(t, r.ctx.status))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(here, (d) => d.font_semibold()).child(r.label))
        .when(r.ctx.status === "blocked", (el) => el.child(div().text_size(11).text_color(t.blocked).child("needs you")))
        .when(r.ctx.status === "done", (el) => el.child(div().text_size(11).text_color(t.done).child("finished")))
        .when(conv, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("in conversation")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(who + (r.team ? `  +${r.team}` : "")));
      return v_flex()
        .id(`pk-${r.ctx.id}`)
        .mx(4)
        .px(10)
        .h(hOf(r))
        .rounded(7)
        .justify_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(line)
        .when(conv, (el) => el.child(div().pl(22).truncate().text_size(11).text_color(t.dim).child(r.snippet)));
    };

    return v_flex()
      .id("picker")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = (this.at + 1) % pickable.length;
        else if (k === "up") this.at = ((this.at < 0 ? pickable.length : this.at) + pickable.length - 1) % pickable.length;
        else if (k === "d" && e.modifiers.control) {
          if (sel?.kind === "ctx") {
            this.close();
            run("tab.close", { id: sel.ctx.id });
          }
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Go to…")).child(div().id("picker-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(
        h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("pk-list")
          .on_size_change((size, cx) => {
            this.listHeight = size.height / settings().zoom;
            cx.notify();
          })
          .h(Math.min(560, total))
          .min_h(0)
          .mb(6)
          .when(fixed, (el) =>
            el.overflow_hidden().on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
              // The selection follows the wheel, so the next frame doesn't scroll back to it.
              while (this.at < pickable.length - 1 && tops[rows.indexOf(pickable[this.at])] < this.scroll) this.at++;
              while (this.at > 0 && tops[rows.indexOf(pickable[this.at])] + (H[pickable[this.at].kind] ?? 32) > this.scroll + height) this.at--;
              cx.notify();
            }))
          .children(rows.map((r, i) => (visible(i) ? place(row(r), i) : null)).filter(Boolean)),
      );
  }
}
