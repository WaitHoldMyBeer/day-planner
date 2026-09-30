#!/usr/bin/env python3
"""audit: check what an agent did in a run against the reading rules.

    audit --stream FILE --role routine|mentor|repair --run RUNDIR [--home DIR]

Reads the event stream `claude -p --output-format stream-json` wrote for one agent and produces,
in RUNDIR:

    actions-<role>.jsonl   every tool call the agent made (name and input), without any result
    audit-<role>.json      counts, the pages visited, and the findings
    agent-<role>.json      the final result event, as `--output-format json` would have given it

The prompts tell the agents to read and never act; the permission rules enforce that for files
and for tools. They cannot enforce it inside the browser's script tool or for where a tab is
pointed. This program covers that part after the fact: it does not prevent a breach, it makes
sure one cannot go unnoticed.

A finding is a `breach` (a hard rule was broken) or a `warning` (worth a look). Exit codes:
0 no breach, 1 at least one breach, 2 usage, 4 the stream is missing or unreadable.

Configuration, from <home>/config.json:
    allowed_hosts     hosts a tab may be pointed at (default: none, so every visit is a breach)
    forbidden_urls    regular expressions no visited address may match

Standard library only.
"""
import argparse
import json
import os
import re
import sys
from urllib.parse import urlsplit, parse_qs

EXIT_BREACH, EXIT_USAGE, EXIT_INPUT = 1, 2, 4

NAVIGATE = "mcp__claude-in-chrome__navigate"
SCRIPT = "mcp__claude-in-chrome__javascript_tool"
FILE_TOOLS = ("Read", "Write", "Edit", "Glob", "Grep", "ToolSearch")
BROWSER_READ = tuple("mcp__claude-in-chrome__" + n for n in (
    "tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate",
    "get_page_text", "read_page", "find", "javascript_tool"))
MAIL_READ = ("mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread")

# What a page script may never contain. Patterns are matched against the script with comments
# and all whitespace removed, so they carry no spaces and no word boundaries; a rare false alarm
# (a function named `prefetch`) is the price of not being fooled by spacing.
# Each entry: (rule, pattern, what it would do).
SCRIPT_RULES = (
    ("acts", r"\.click\(", "clicks"),
    ("acts", r"\.submit\(|requestSubmit", "submits a form"),
    ("acts", r"dispatchEvent|\.focus\(|execCommand|\.select\(", "drives the page"),
    ("acts", r"\.(value|checked|selected)=(?![=>])", "fills a field"),
    ("network", r"fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource", "makes a network request"),
    ("storage", r"document\.cookie|localStorage|sessionStorage|indexedDB|caches\.", "touches cookies or storage"),
    ("changes", r"\.(innerHTML|outerHTML|textContent|innerText)=(?![=>])", "rewrites the page"),
    ("changes", r"appendChild|insertBefore|insertAdjacent|replaceChild|\.remove\(|removeChild|setAttribute"
                r"|removeAttribute|classList\.(add|remove|toggle)", "changes the page"),
    ("leaves", r"location(\.href)?=(?![=>])|location\.(assign|replace|reload)|window\.open"
               r"|history\.(pushState|replaceState|back|forward|go)", "navigates"),
    ("code", r"eval\(|newFunction|import\(|importScripts|createElement\([\'\"]script", "runs further code"),
)
SCRIPT_WARNINGS = (
    ("scrolls", r"scrollTo|scrollBy|scrollIntoView|scrollTop=(?![=>])", "scrolls, which can load more or mark items seen"),
    ("dialog", r"alert\(|confirm\(|prompt\(|\.print\(", "opens a dialog"),
    ("hidden", r"[\'\"`]\+[\'\"`]|fromCharCode|atob\(", "builds text from pieces, which can hide a call"),
)
WAIT = re.compile(r"awaitnewPromise\(\(?\w+\)?=>setTimeout\(\w+,\d{1,5}\)\);?")
# Addresses that change what the owner sees later.
URL_RULES = (
    ("mail.google.com", lambda u: "view" in u["query"] and "pt" in u["query"]["view"],
     "opened Gmail's print view, which freezes the tab"),
    # A conversation's address ends in its id: 16 hex characters, or a long mixed-case token.
    ("mail.google.com", lambda u: re.search(r"/([0-9a-f]{16}|[A-Za-z0-9_-]{24,})$", u["fragment"].split("?")[0]) is not None,
     "opened a Gmail conversation, which marks it read"),
    ("piazza.com", lambda u: "cid" in u["query"] or "/post/" in u["path"],
     "opened a Piazza post, which marks it read"),
)


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _char(m):
    try:
        return chr(int(m.group(1) or m.group(2) or m.group(3), 16))
    except (ValueError, OverflowError):
        return m.group(0)


def squeeze(js):
    """A script with comments and whitespace removed, so copies compare equal.

    Escapes such as \\u200b are replaced by the characters they stand for: an agent that copies a
    snippet may write either form, and an escape must not hide a word from the rules below.
    """
    js = re.sub(r"\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})", _char, js)
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    js = re.sub(r"(^|[\s;{}(,])//[^\n]*", r"\1", js)
    return re.sub(r"\s+", "", js)


def load_snippets(home):
    """name -> compiled pattern matching the squeezed snippet, with its constants left open."""
    out = {}
    folder = os.path.join(home, "snippets")
    if not os.path.isdir(folder):
        return out
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".js"):
            continue
        with open(os.path.join(folder, name), encoding="utf-8") as f:
            body = squeeze(f.read())
        pattern = re.escape(body)
        # The constants an agent may set are the capitalised ones at the top of a snippet (OFFSET,
        # ID, MESSAGE, ITEM, CHANNELS, SELECTOR). Any plain value is accepted in their place: a
        # number, null, true or false, or a quoted text that cannot end its own quotes.
        pattern = re.sub(r"const([A-Z][A-Z_]*)=(?:'[^']*'|(?:\\-)?\d+|null|true|false);",
                         lambda m: "const" + m.group(1) + r"=(?:'[^'\\;]{0,200}'|-?\d{1,7}|null|true|false);", pattern)
        out[name] = re.compile(pattern)
    return out


def check_script(text, snippets):
    """(label, findings) for one script. Known snippets are cut out before the rest is judged."""
    rest = squeeze(text or "")
    used = []
    for name, pattern in snippets.items():
        rest, n = pattern.subn(";", rest)
        if n:
            used.append(name)
    # Waiting for a page to settle is the one thing agents routinely add around a snippet.
    rest = WAIT.sub(";", rest).strip(";")
    findings = []
    if rest:
        for rule, pattern, what in SCRIPT_RULES:
            if re.search(pattern, rest):
                findings.append(("breach", f"script-{rule}", f"a page script {what}"))
        for rule, pattern, what in SCRIPT_WARNINGS:
            if re.search(pattern, rest):
                findings.append(("warning", f"script-{rule}", f"a page script {what}"))
    label = "+".join(used) if used else "own"
    if used and rest:
        label += "+own"
    return label, findings


def parse_url(url):
    p = urlsplit(url if re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I) else "https://" + url)
    return {"scheme": p.scheme.lower(), "host": (p.hostname or "").lower(), "path": p.path or "/",
            "query": parse_qs(p.query, keep_blank_values=True), "fragment": p.fragment or ""}


def check_url(url, allowed_hosts, forbidden):
    if url in ("back", "forward"):
        return None, []
    u = parse_url(url)
    shown = {"host": u["host"], "path": u["path"]}
    findings = []
    if u["scheme"] != "https":
        findings.append(("breach", "visit-scheme", f"visited a {u['scheme']} address on {u['host'] or 'no host'}"))
    if u["host"] not in allowed_hosts:
        findings.append(("breach", "visit-host", f"visited {u['host'] or url[:60]}, which is not a listed source"))
    for pattern in forbidden:
        if pattern.search(url):
            findings.append(("breach", "visit-forbidden", f"visited an address the owner excluded ({u['host']}{u['path']})"))
            break
    for host, test, what in URL_RULES:
        if u["host"] == host and test(u):
            findings.append(("breach", "visit-marks", what))
    if re.search(r"(^|\.)instructure\.com$|^canvas\.", u["host"]):
        if not u["path"].startswith("/api/v1/"):
            if re.search(r"/(discussion_topics|announcements|conversations)(/|$)", u["path"]):
                findings.append(("breach", "visit-marks", "opened a Canvas announcement or inbox page, which marks it read"))
        elif re.search(r"^/api/v1/conversations/\d+", u["path"]) and u["query"].get("auto_mark_as_read") != ["false"]:
            findings.append(("breach", "visit-marks", "requested one Canvas conversation, which marks it read"))
    return shown, findings


def events(path):
    try:
        with open(path, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except ValueError:
                    raise Fail(EXIT_INPUT, f"{path}: line {n} is not JSON")
    except OSError as e:
        raise Fail(EXIT_INPUT, f"cannot read {path}: {e.strerror}")


def audit(stream, role, home):
    cfg = {}
    try:
        with open(os.path.join(home, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        pass
    allowed_hosts = {str(h).lower() for h in cfg.get("allowed_hosts", [])}
    try:
        forbidden = [re.compile(p) for p in cfg.get("forbidden_urls", [])]
    except re.error as e:
        raise Fail(EXIT_USAGE, f"config.json: forbidden_urls holds a bad pattern: {e}")
    expected = set(FILE_TOOLS) | set(BROWSER_READ) | set(MAIL_READ) | {str(t) for t in cfg.get("extra_allowed_tools", [])}
    snippets = load_snippets(home)

    actions, findings, visits = [], [], []
    calls, scripts, denied_ids = {}, {}, set()
    names = {}
    init, result = {}, None
    for e in events(stream):
        kind = e.get("type")
        if kind == "system" and e.get("subtype") == "init":
            init = e
        elif kind == "result":
            result = e
        elif kind in ("assistant", "user"):
            content = (e.get("message") or {}).get("content")
            for b in content if isinstance(content, list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_use":
                    names[b.get("id")] = b.get("name")
                    actions.append({"id": b.get("id"), "tool": b.get("name"), "input": b.get("input")})
                elif b.get("type") == "tool_result" and b.get("is_error"):
                    text = json.dumps(b.get("content"))[:400]
                    if "denied" in text.lower() or "don't ask mode" in text.lower():
                        denied_ids.add(b.get("tool_use_id"))

    for a in actions:
        tool, data = a["tool"] or "?", a["input"] if isinstance(a["input"], dict) else {}
        a["denied"] = a["id"] in denied_ids
        calls[tool] = calls.get(tool, 0) + 1
        if a["denied"]:
            target = data.get("file_path") or data.get("url") or ""
            findings.append(("warning", "refused", f"tried {tool}{' on ' + str(target)[:80] if target else ''} and was refused"))
            continue
        if tool not in expected:
            findings.append(("breach", "tool", f"used {tool}, which is not a reading tool"))
        if tool == NAVIGATE:
            shown, found = check_url(str(data.get("url", "")), allowed_hosts, forbidden)
            if shown:
                visits.append(shown)
            findings += found
        elif tool == SCRIPT:
            label, found = check_script(str(data.get("text", "")), snippets)
            scripts[label] = scripts.get(label, 0) + 1
            findings += found
            a["script"] = label

    source = init.get("apiKeySource")
    if init and source not in (None, "none"):
        findings.append(("breach", "billing", f"the run was billed to a key ({source}), not to the Claude plan"))

    seen, unique = set(), []
    for f in findings:
        if f not in seen:
            seen.add(f)
            unique.append({"severity": f[0], "rule": f[1], "detail": f[2]})
    pages = {}
    for v in visits:
        key = v["host"] + v["path"]
        pages[key] = pages.get(key, 0) + 1
    report = {
        "role": role,
        "model": init.get("model"),
        "signIn": "Claude plan" if source in (None, "none") and init else (source or "unknown"),
        "finished": result is not None,
        "turns": (result or {}).get("num_turns"),
        "minutes": round(((result or {}).get("duration_ms") or 0) / 60000, 1),
        "calls": dict(sorted(calls.items())),
        "scripts": dict(sorted(scripts.items())),
        "pages": dict(sorted(pages.items())),
        "breaches": sum(1 for f in unique if f["severity"] == "breach"),
        "warnings": sum(1 for f in unique if f["severity"] == "warning"),
        "findings": unique,
    }
    return report, actions, result


def main(argv=None):
    p = argparse.ArgumentParser(prog="audit", description="check what an agent did in a run")
    p.add_argument("--stream", required=True)
    p.add_argument("--role", required=True, choices=("routine", "mentor", "repair"))
    p.add_argument("--run", required=True, metavar="RUNDIR")
    p.add_argument("--home", default=os.environ.get("BP_HOME") or os.getcwd())
    args = p.parse_args(argv)
    try:
        if not os.path.isdir(args.run):
            raise Fail(EXIT_USAGE, f"{args.run} is not a directory")
        report, actions, result = audit(args.stream, args.role, os.path.abspath(args.home))
        with open(os.path.join(args.run, f"actions-{args.role}.jsonl"), "w", encoding="utf-8") as f:
            for a in actions:
                f.write(json.dumps(a, ensure_ascii=False) + "\n")
        with open(os.path.join(args.run, f"audit-{args.role}.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        with open(os.path.join(args.run, f"agent-{args.role}.json"), "w", encoding="utf-8") as f:
            json.dump(result or {"is_error": True, "result": "The agent did not finish."}, f, ensure_ascii=False)
    except Fail as e:
        print(f"audit: {e}", file=sys.stderr)
        return e.code
    print(f"audit {args.role}: {sum(report['calls'].values())} tool calls, {len(report['pages'])} pages, "
          f"{report['breaches']} breaches, {report['warnings']} warnings, sign-in: {report['signIn']}")
    for f in report["findings"]:
        print(f"  {f['severity']}: {f['detail']}")
    return EXIT_BREACH if report["breaches"] else 0


if __name__ == "__main__":
    sys.exit(main())
