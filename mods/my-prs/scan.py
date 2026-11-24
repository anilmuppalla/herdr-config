"""List the GitHub PRs in the Claude conversations of the given Herdr terminals.

Usage: python3 -I scan.py <terminal address>...
Prints {"created": [{url, terminal}], "referenced": [{url, terminal}]}. A PR is
"created" when its URL came back from a Bash call that ran `gh pr create`, and
"referenced" when its link is written in your messages or the agent's replies.
"""

from __future__ import annotations  # Herdr may run macOS's Python 3.9

import glob
import json
import os
import re
import subprocess
import sys

PR_URL = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")
# `gh pr create` run as a command (line start or after ; & | ( `), not quoted inside another.
GH_PR_CREATE = re.compile(r"(?:^|[;&|(`])\s*gh\s+pr\s+create\b", re.M)
SESSIONS = os.path.expanduser("~/.claude/sessions")
PROJECTS = os.path.expanduser("~/.claude/projects")


def transcript_for(terminal: str) -> str | None:
    """terminal -> its foreground Claude process -> that session's transcript file."""
    result = subprocess.run(["hc", "get", terminal, "--json"], capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        return None
    pid = (json.loads(result.stdout).get("foreground") or {}).get("pid")
    try:
        with open(f"{SESSIONS}/{pid}.json") as f:
            session_id = json.load(f)["sessionId"]
    except (OSError, ValueError, KeyError):
        return None
    found = glob.glob(f"{PROJECTS}/*/{session_id}.jsonl")
    return found[0] if found else None


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def urls(value) -> list[str]:
    return [f"https://github.com/{o}/{r}/pull/{n}" for text in strings(value) for o, r, n in PR_URL.findall(text)]


def scan(path: str) -> tuple[list[str], list[str]]:
    created, referenced, creating = [], [], set()
    with open(path, errors="replace") as f:
        for line in f:
            # Most lines mention no PR; skip parsing them.
            if "/pull/" not in line and "gh pr create" not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("type") not in ("user", "assistant") or entry.get("isMeta"):
                continue
            content = (entry.get("message") or {}).get("content")
            blocks = content if isinstance(content, list) else [content]
            for block in blocks:
                # Referenced: links written in your messages or the agent's replies,
                # not links that only showed up in tool output (searches, reads).
                if isinstance(block, str) or (isinstance(block, dict) and block.get("type") == "text"):
                    referenced += urls(block)
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use" and GH_PR_CREATE.search(str((block.get("input") or {}).get("command", ""))):
                    creating.add(block.get("id"))
                if block.get("type") == "tool_result" and block.get("tool_use_id") in creating:
                    created += urls(block.get("content"))
    return created, referenced


def main() -> int:
    created, referenced = {}, {}
    for terminal in sys.argv[1:]:
        path = transcript_for(terminal)
        if not path:
            continue
        made, seen = scan(path)
        for url in made:
            created.setdefault(url, terminal)
        for url in seen:
            referenced.setdefault(url, terminal)
    print(json.dumps({
        "created": [{"url": u, "terminal": t} for u, t in created.items()],
        "referenced": [{"url": u, "terminal": t} for u, t in referenced.items() if u not in created],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
