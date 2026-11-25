// Remembers tabs as they close and reopens the last one on my-reopen.reopen
// (cmd-shift-t). A Claude tab comes back as `claude --resume <session>`.
// Draws nothing: it sits in my-layout as an empty floating block.

import { View } from "gpui-kit";
import { spaces, panes, agents, terminals, machines, run, nextCommand, notify, checking } from "herdr";
import { KEEP, claudeSessions, snapshot, closedTabs, reopenCommand } from "./reopen.js";

const load = () => { try { return JSON.parse(localStorage.getItem("closed") ?? "[]"); } catch { return []; } };
const save = (list) => { try { localStorage.setItem("closed", JSON.stringify(list)); } catch {} };

export default class Reopen extends View {
  init(_props, cx) {
    this.tabs = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        cx.notify(); // ends this loop if a newer build replaced this copy
        if (c === "reopen") this.reopen();
      }
    });
  }

  reopen() {
    const list = load();
    const e = list.pop();
    if (!e) return notify({ title: "No closed tab to reopen", level: "info", timeout: 2000 });
    save(list);
    const [name, args] = reopenCommand(e, spaces());
    run(name, args);
  }

  render() {
    if (checking() || machines().find((m) => m.name === null)?.layout !== "ready") return "";
    const now = snapshot(spaces(), panes(), claudeSessions(agents(), terminals()));
    if (this.tabs) {
      const closed = closedTabs(this.tabs, spaces());
      if (closed.length) save([...load(), ...closed].slice(-KEEP));
    }
    this.tabs = now;
    return "";
  }
}
