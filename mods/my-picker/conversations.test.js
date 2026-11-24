import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentKind, projectDir, findTranscript, searchConversations, snippet } from "./conversations.js";

// A fake home with sample transcripts; `exec` runs the real commands on it, and
// `hc get` answers from `pids` (address → process ID) without touching terminals.
function sampleHome() {
  const home = mkdtempSync(join(tmpdir(), "picker-"));
  const put = (rel, text, ageSec = 0) => {
    const f = join(home, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text);
    const t = Date.now() / 1000 - ageSec;
    utimesSync(f, t, t);
    return f;
  };
  const pids = { a1: 111 };
  const io = {
    home: () => home,
    exec: (cmd, args) => new Promise((ok) => execFile(cmd, args, { maxBuffer: 8 << 20 }, (e, stdout, stderr) => ok({ code: e ? e.code ?? 1 : 0, stdout, stderr }))),
    hc: async ([, address]) => (pids[address] ? { code: 0, stdout: JSON.stringify({ foreground: { pid: pids[address] } }) } : { code: 1, stdout: "" }),
    readTextFile: async (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  };
  return { home, put, io };
}

test("agent kinds and Claude's project folder names", () => {
  assert.equal(agentKind({ program: { key: "claude" } }), "claude");
  assert.equal(agentKind({ program: { key: "program" }, app: "codex" }), "codex");
  assert.equal(agentKind({ program: { key: "nvim" }, app: null }), null);
  assert.equal(projectDir("/Users/a/my_proj/x.y"), "-Users-a-my-proj-x-y");
});

test("R3: Claude transcript by process ID, else the newest in its folder", async () => {
  const { home, put, io } = sampleHome();
  put(".claude/sessions/111.json", JSON.stringify({ sessionId: "s-old", cwd: "/w/one" }));
  const byPid = put(`.claude/projects/${projectDir("/w/one")}/s-old.jsonl`, "{}\n", 500);
  put(`.claude/projects/${projectDir("/w/one")}/s-new.jsonl`, "{}\n", 10);
  assert.equal(await findTranscript(io, { address: "a1", kind: "claude", cwd: "/w/one" }), byPid);
  // No sessions file for a2: the most recently modified transcript in its folder.
  put(`.claude/projects/${projectDir("/w/two")}/older.jsonl`, "{}\n", 900);
  const newest = put(`.claude/projects/${projectDir("/w/two")}/newer.jsonl`, "{}\n", 30);
  mkdirSync(join(home, ".claude/projects", projectDir("/w/two"), "newest-dir"));
  assert.equal(await findTranscript(io, { address: "a2", kind: "claude", cwd: "/w/two" }), newest);
  assert.equal(await findTranscript(io, { address: "a3", kind: "claude", cwd: "/w/none" }), null);
});

test("R3: Codex transcript is the newest whose first line has the terminal's folder", async () => {
  const { put, io } = sampleHome();
  const meta = (cwd) => JSON.stringify({ type: "session_meta", payload: { id: "x", cwd, instructions: "long ".repeat(500) } }) + "\n";
  put("sessions/ignored", "");
  put(".codex/sessions/2026/11/19/rollout-a.jsonl", meta("/w/one") + '{"msg":"old"}\n', 3600);
  const want = put(".codex/sessions/2026/11/20/rollout-b.jsonl", meta("/w/one") + '{"msg":"new"}\n', 60);
  put(".codex/sessions/2026/11/20/rollout-c.jsonl", meta("/w/two") + '{"cwd":"/w/one"}\n', 5);
  put(".codex/sessions/2026/10/01/rollout-d.jsonl", meta("/w/three"), 30 * 86400);
  const cache = {};
  assert.equal(await findTranscript(io, { kind: "codex", cwd: "/w/one" }, cache), want);
  assert.match(await findTranscript(io, { kind: "codex", cwd: "/w/two" }, cache), /rollout-c/);
  assert.equal(await findTranscript(io, { kind: "codex", cwd: "/w/three" }, cache), null); // older than CODEX_DAYS
  assert.equal(await findTranscript(io, { kind: "codex", cwd: null }, cache), null);
});

test("R3: every word must be in the conversation; snippets show the match", async () => {
  const { put, io } = sampleHome();
  put(".claude/sessions/111.json", JSON.stringify({ sessionId: "s1", cwd: "/w/one" }));
  put(`.claude/projects/${projectDir("/w/one")}/s1.jsonl`, '{"text":"We looked at the MCP\\nBrowser tool and its ground truth."}\n');
  put(".codex/sessions/2026/11/20/rollout-a.jsonl", JSON.stringify({ payload: { cwd: "/w/two" } }) + '\n{"text":"browser only"}\n');
  const targets = [
    { tab: "t1", address: "a1", kind: "claude", cwd: "/w/one" },
    { tab: "t2", address: "a2", kind: "codex", cwd: "/w/two" },
    { tab: "t3", address: "a3", kind: "codex", cwd: "/w/missing" },
  ];
  const cache = {};
  const hits = await searchConversations(io, targets, ["browser", "mcp"], cache);
  assert.deepEqual([...hits.keys()], ["t1"]);
  assert.match(hits.get("t1"), /MCP Browser tool/);
  assert.ok(!hits.get("t1").includes("\\n"));
  assert.deepEqual([...(await searchConversations(io, targets, ["browser"], cache)).keys()].sort(), ["t1", "t2"]);
  assert.equal((await searchConversations(io, targets, ["zebra"], cache)).size, 0);
});

test("snippets are short and marked when cut", () => {
  const text = "a".repeat(200) + " the needle is here " + "b".repeat(200);
  const s = snippet(text, ["needle"]);
  assert.ok(s.startsWith("…") && s.endsWith("…") && s.includes("needle") && s.length < 100);
});
