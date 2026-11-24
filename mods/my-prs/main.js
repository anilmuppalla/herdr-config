// Unmerged PRs in the active space's Claude conversations: ones an agent created
// with `gh pr create`, then ones linked in your messages or the agent's replies.
// Remembered per space, so a PR stays listed after its agent exits or its
// conversation is cleared.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, agents, exec, theme, appHome } from "herdr";

const SCAN = `${appHome()}/mods/my-prs/scan.py`;
const SCAN_EVERY = 10000;
const INFO_TTL = 300000; // how long a PR's title and state (gh) are reused
const STATE = { OPEN: "Open", DRAFT: "Draft", MERGED: "Merged", CLOSED: "Closed" };

const load = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { return {}; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const short = (url) => { const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url); return m ? `${m[1]}#${m[2]}` : url; };
// An agent reads as its tab's name, or its own title when the tab only has a number.
const agentName = (a) => (!/^\d+$/.test(a.tab_name ?? "") && a.tab_name) || a.title || a.address;

export default class Prs extends View {
  init(_props, cx) {
    // "prs-v2": entries saved under "prs" counted links from tool output as referenced.
    this.prs = load("prs-v2"); // space id -> { url: { kind: "created" | "referenced", agent } }, oldest first
    this.info = load("info"); // url -> { title, state, at }
    this.refresh(cx);
    cx.timer.every(SCAN_EVERY, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    const space = spaces().find((s) => s.active);
    if (!space || this.scanning) return;
    this.scanned = space.id;
    const list = agents().filter((a) => a.space === space.id && a.app === "claude-code" && !a.address.includes("/"));
    const names = new Map(list.map((a) => [a.address, agentName(a)]));
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        if (list.length) {
          const r = await exec("python3", ["-I", SCAN, ...list.map((a) => a.address)], { timeout: 20000 });
          if (r.code === 0) this.merge(space.id, JSON.parse(r.stdout), names);
        }
        cx.notify();
        await this.lookup(space.id, cx);
      } catch {} // a failed scan shows what was found before; the next one retries
      finally { this.scanning = false; }
    });
  }

  // A PR seen as referenced and later created moves to Created, under the agent that created it.
  merge(space, found, names) {
    const known = (this.prs[space] ??= {});
    let changed = false;
    for (const kind of ["created", "referenced"]) {
      for (const { url, terminal } of found[kind] ?? []) {
        const old = known[url];
        if (old && (old.kind === "created" || kind === "referenced")) continue;
        known[url] = { kind, agent: names.get(terminal) ?? terminal };
        changed = true;
      }
    }
    if (changed) save("prs-v2", this.prs);
  }

  // Title and state from gh, one PR at a time; a merged PR never changes again.
  async lookup(space, cx) {
    for (const url of Object.keys(this.prs[space] ?? {})) {
      const old = this.info[url];
      if (old && (old.state === "MERGED" || Date.now() - old.at < INFO_TTL)) continue;
      const r = await exec("gh", ["pr", "view", url, "--json", "title,state,isDraft"], { timeout: 15000 }).catch(() => null);
      if (r?.code === 0) {
        const p = JSON.parse(r.stdout);
        this.info[url] = { title: p.title, state: p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state, at: Date.now() };
      } else this.info[url] = { ...old, at: Date.now() }; // keep what we had; try again after INFO_TTL
      cx.notify();
    }
    save("info", this.info);
  }

  row(url, pr, t) {
    const info = this.info[url] ?? {};
    const color = { OPEN: t.ansi2, DRAFT: t.dim, MERGED: t.ansi5, CLOSED: t.ansi1 }[info.state] ?? t.dim;
    return h_flex().id(`pr-${url}`).h(44).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(url)
      .on_click(() => { exec("open", [url]).catch(() => {}); })
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().min_w(0).truncate().child(info.title ?? short(url)))
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`${short(url)} · ${pr.agent}`)))
      .when(Boolean(info.state), (el) => el.child(div().flex_none().px(6).h(18).rounded(5).bg(color + "26")
        .text_size(10.5).text_color(color).flex().items_center().child(STATE[info.state] ?? info.state)));
  }

  section(label, entries, t) {
    if (!entries.length) return [];
    return [
      div().px(8).pt(8).pb(4).text_size(11).text_color(t.dim).child(`${label} ${entries.length}`),
      ...entries.map(([url, pr]) => this.row(url, pr, t)),
    ];
  }

  render(cx) {
    const t = theme(), space = spaces().find((s) => s.active);
    if (space && space.id !== this.scanned) this.refresh(cx);
    // Newest first: entries are stored in the order the conversations reached them.
    const all = Object.entries(this.prs[space?.id] ?? {}).reverse().filter(([url]) => this.info[url]?.state !== "MERGED");
    const created = all.filter(([, pr]) => pr.kind === "created"), referenced = all.filter(([, pr]) => pr.kind === "referenced");
    return v_flex().id("prs").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("PRs"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(space?.name ?? ""))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(all.length))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children([...this.section("Created", created, t), ...this.section("Referenced", referenced, t)])
          .when(!all.length, (el) => el.child(div().p(8).text_color(t.dim)
            .child(this.scanning ? "Reading conversations…" : "No unmerged PRs in this space's Claude conversations"))))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()));
  }
}
