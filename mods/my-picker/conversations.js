// Finds and searches the transcripts of open Claude Code and Codex terminals on
// this machine. Herdr's calls come in as `io` ({ exec, hc, readTextFile, home }),
// so tests can run this on sample files in a temporary folder.

import { hasAll } from "./search.js";

/** How much of each transcript's end is searched (exec output stops at 8 MiB). */
export const TAIL_BYTES = 4 << 20;
/** Only Codex transcripts modified in this many days are looked through. */
export const CODEX_DAYS = 7;
/** About how many characters a snippet shows after the match. */
export const SNIPPET_CHARS = 70;

/** "claude", "codex", or null for other agents. */
export function agentKind(a) {
  const k = `${a.program?.key ?? ""} ${a.app ?? ""}`.toLowerCase();
  return k.includes("claude") ? "claude" : k.includes("codex") ? "codex" : null;
}

/** Claude Code's folder under ~/.claude/projects for a working folder. */
export const projectDir = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// A command's output, or "" when it can't run.
async function out(io, cmd, args) {
  try {
    return (await io.exec(cmd, args, { timeout: 15000 })).stdout ?? "";
  } catch {
    return "";
  }
}
const lines = (s) => s.split("\n").filter(Boolean);

/** A terminal's transcript ({ address, kind, cwd }), or null. Claude: through
 *  its process's ~/.claude/sessions/<pid>.json; without one (and for Codex),
 *  the most recently modified transcript started in the terminal's folder. */
export async function findTranscript(io, t, cache = {}) {
  const home = io.home();
  if (t.kind === "claude") {
    try {
      const pid = JSON.parse((await io.hc(["get", t.address, "--json"])).stdout)?.foreground?.pid;
      const s = pid ? JSON.parse((await io.readTextFile(`${home}/.claude/sessions/${pid}.json`)) ?? "null") : null;
      if (s?.sessionId) return `${home}/.claude/projects/${projectDir(s.cwd ?? t.cwd ?? "")}/${s.sessionId}.jsonl`;
    } catch {}
    if (!t.cwd) return null;
    const dir = `${home}/.claude/projects/${projectDir(t.cwd)}`;
    const name = lines(await out(io, "ls", ["-t", dir])).find((n) => n.endsWith(".jsonl"));
    return name ? `${dir}/${name}` : null;
  }
  if (!t.cwd) return null;
  cache.codex ??= codexIndex(io, home);
  return (await cache.codex).find((x) => x.cwd === t.cwd)?.file ?? null;
}

// Recent Codex transcripts, newest first, each with the folder in its first "cwd".
async function codexIndex(io, home) {
  const find = [`${home}/.codex/sessions`, "-name", "rollout-*.jsonl", "-mtime", `-${CODEX_DAYS}`, "-exec", "ls", "-t", "{}", "+"];
  const files = lines(await out(io, "find", find));
  if (!files.length) return [];
  const cwds = new Map();
  for (const l of lines(await out(io, "grep", ["-m1", "-o", "-H", '"cwd":"[^"]*"', ...files]))) {
    const at = l.indexOf(':"cwd":"');
    if (at > 0 && !cwds.has(l.slice(0, at))) cwds.set(l.slice(0, at), l.slice(at + 8, -1));
  }
  return files.map((file) => ({ file, cwd: cwds.get(file) }));
}

/** A short piece of `text` around the first word, without JSON escapes. */
export function snippet(text, ws) {
  const i = text.toLowerCase().indexOf(ws[0]);
  const s = text.slice(Math.max(0, i - 20), i + SNIPPET_CHARS).replace(/\\[nrt]/g, " ").replace(/\\"/g, '"');
  return `${i > 20 ? "…" : ""}${s.replace(/\s+/g, " ").trim()}…`;
}

/** Tabs whose terminal's conversation has every word: Map tab id → snippet.
 *  `cache` keeps transcript paths and text for one picker. */
export async function searchConversations(io, targets, ws, cache = {}) {
  cache.paths ??= new Map();
  cache.texts ??= new Map();
  const hits = new Map();
  await Promise.all(
    targets.map(async (t) => {
      if (!cache.paths.has(t.address)) cache.paths.set(t.address, findTranscript(io, t, cache));
      const path = await cache.paths.get(t.address);
      if (!path) return;
      if (!cache.texts.has(path)) cache.texts.set(path, out(io, "tail", ["-c", String(TAIL_BYTES), path]));
      const text = await cache.texts.get(path);
      if (!hits.has(t.tab) && hasAll(text, ws)) hits.set(t.tab, snippet(text, ws));
    }),
  );
  return hits;
}
