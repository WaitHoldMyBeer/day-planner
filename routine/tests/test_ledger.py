"""Tests for routine/bin/ledger.py.

Run from the repository root:  python3 -m unittest discover -s routine/tests -v
"""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "bin", "ledger.py"))

sys.dont_write_bytecode = True  # keep routine/bin free of __pycache__
_spec = importlib.util.spec_from_file_location("ledger", SCRIPT)
ledger = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ledger)

NOW = "2026-10-01T08:00:00-07:00"


def cand(fp, title="Item", kind="canvas", due=None, priority="medium", decision="keep", **extra):
    c = {"fingerprint": fp, "title": title, "source": {"kind": kind, "label": "L", "url": None},
         "due": due, "priority": priority, "decision": decision, "reason": "r"}
    c.update(extra)
    return c


def item(**over):
    """A valid ledger item; first_seen defaults to last_seen."""
    it = {"title": "T", "kind": "mail", "due": None, "last_seen": "2026-09-01", "times_seen": 1,
          "last_reported": None, "decision": "keep", "status": None, "priority": "low"}
    it.update(over)
    it.setdefault("first_seen", it["last_seen"])
    return it


def run_rec(run_id, status="ok", started=None, date=None, trigger="timer"):
    return {"date": date or run_id[:10], "run_id": run_id, "status": status, "trigger": trigger,
            "started": started, "finished": None, "candidates": None, "reported": None,
            "coverage": None}


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = tmp.name
        self.mem = os.path.join(self.home, "memory")
        self.path = os.path.join(self.mem, "state.json")
        self._runs = 0

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ledger.main(["--home", self.home, *argv])
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        code, out, err = self.cli(*argv)
        self.assertEqual(code, 0, f"{argv} failed: {err}")
        return out

    def rundir(self, candidates, context=None, run_id="2026-09-27T08:00", bare=False, context_in_inputs=False):
        self._runs += 1
        d = os.path.join(self.home, "runs", f"r{self._runs}")
        os.makedirs(os.path.join(d, "inputs"))
        doc = candidates if bare else {"runId": run_id, "candidates": candidates}
        with open(os.path.join(d, "candidates.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f)
        if context is not None:
            where = os.path.join(d, "inputs" if context_in_inputs else "", "context.json")
            with open(where, "w", encoding="utf-8") as f:
                json.dump({"enabled": True, "todos": [], "suggestions": context}, f)
        return d

    def merge(self, candidates, date, context=None, **kw):
        return self.ok("merge", "--run", self.rundir(candidates, context, **kw), "--date", date)

    def state(self):
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def raw(self):
        with open(self.path, "rb") as f:
            return f.read()

    def write_state(self, state):
        os.makedirs(self.mem, exist_ok=True)
        ledger.save_state(self.home, state)

    def write_raw(self, data):
        os.makedirs(self.mem, exist_ok=True)
        with open(self.path, "wb") as f:
            f.write(data)

    def assert_no_temp_files(self):
        self.assertEqual(sorted(os.listdir(self.mem)), ["state.json"])


class MergeTests(Base):
    def test_merge_creates_items(self):
        out = self.merge([cand("canvas:assignment:1:2", "MATH 170A HW 1", due="2026-09-29T23:59:00-07:00",
                               priority="high", decision="keep"),
                          cand("mail:school:abc", "Reply to TA", kind="mail", decision="brief")], "2026-09-27")
        self.assertIn("new 2, updated 0, unchanged 0, skipped 0", out)
        items = self.state()["items"]
        self.assertEqual(items["canvas:assignment:1:2"], {
            "title": "MATH 170A HW 1", "kind": "canvas", "due": "2026-09-29T23:59:00-07:00",
            "first_seen": "2026-09-27", "last_seen": "2026-09-27", "times_seen": 1,
            "last_reported": "2026-09-27", "decision": "keep", "status": None, "priority": "high"})
        self.assertIsNone(items["mail:school:abc"]["last_reported"])
        self.assertEqual(items["mail:school:abc"]["decision"], "brief")

    def test_merge_updates_on_a_later_date(self):
        fp = "canvas:assignment:1:2"
        self.merge([cand(fp, "HW 1", due="2026-09-29T23:59:00-07:00", decision="keep")], "2026-09-27")
        out = self.merge([cand(fp, "HW 1 (extended)", due="2026-10-02T23:59:00-07:00", priority="low",
                               decision="drop")], "2026-09-28")
        self.assertIn("new 0, updated 1", out)
        it = self.state()["items"][fp]
        self.assertEqual((it["title"], it["due"], it["priority"], it["decision"]),
                         ("HW 1 (extended)", "2026-10-02T23:59:00-07:00", "low", "drop"))
        self.assertEqual((it["first_seen"], it["last_seen"], it["times_seen"]), ("2026-09-27", "2026-09-28", 2))
        self.assertEqual(it["last_reported"], "2026-09-27")  # not kept on the 28th

    def test_remerging_the_same_run_is_idempotent(self):
        d = self.rundir([cand("canvas:assignment:1:2"), cand("mail:a:1", decision="drop")])
        self.ok("merge", "--run", d, "--date", "2026-09-27")
        first = self.raw()
        out = self.ok("merge", "--run", d, "--date", "2026-09-27")
        self.assertEqual(self.raw(), first)
        self.assertIn("new 0, updated 0, unchanged 2, skipped 0", out)
        self.assertEqual(self.state()["items"]["canvas:assignment:1:2"]["times_seen"], 1)

    def test_times_seen_counts_distinct_dates(self):
        fp = "piazza:abc:12"
        for date in ("2026-09-27", "2026-09-27", "2026-09-28", "2026-09-30", "2026-09-30"):
            self.merge([cand(fp)], date)
        it = self.state()["items"][fp]
        self.assertEqual((it["times_seen"], it["first_seen"], it["last_seen"]), (3, "2026-09-27", "2026-09-30"))

    def test_bad_fingerprints_are_skipped_and_counted(self):
        code, out, err = self.cli("merge", "--run", self.rundir([
            cand("canvas:assignment:1:2"),
            cand("Canvas:Upper:1"),                # uppercase
            cand("ab"),                            # too short
            cand("mail:a:1\n"),                    # trailing newline ($ alone would accept it)
            {"title": "no fingerprint"},
            "not an object",
            cand("canvas:assignment:1:2", "dup"),  # repeat within the run
        ]), "--date", "2026-09-27")
        self.assertEqual(code, 0)
        self.assertIn("new 1, updated 0, unchanged 0, skipped 6", out)
        self.assertEqual(list(self.state()["items"]), ["canvas:assignment:1:2"])
        self.assertEqual(self.state()["items"]["canvas:assignment:1:2"]["title"], "Item")
        self.assertIn("no valid fingerprint", err)

    def test_bare_list_unknown_keys_and_date_from_run_id(self):
        out = self.ok("merge", "--run", self.rundir([cand("ucsd:deadline:2026-10-09:drop", alsoSeenIn=["x"],
                                                          evidence="e")], bare=True), "--date", "2026-09-27")
        self.assertIn("new 1", out)
        d = self.rundir([cand("calendar:evt1")], run_id="2026-09-28T07:06")
        self.ok("merge", "--run", d)  # no --date: taken from runId
        self.assertEqual(self.state()["items"]["calendar:evt1"]["last_seen"], "2026-09-28")

    def test_invalid_field_values_are_ignored_not_stored(self):
        code, _, err = self.cli("merge", "--run", self.rundir(
            [cand("mail:a:1", due="next tuesday", priority="URGENT", decision="Keep"),
             cand("mail:a:2", due="0001-01-01T00:00:00+01:00")]), "--date", "2026-09-27")
        self.assertEqual(code, 0)
        it = self.state()["items"]["mail:a:1"]
        self.assertEqual((it["due"], it["priority"], it["decision"]), (None, None, "keep"))
        self.assertIsNone(self.state()["items"]["mail:a:2"]["due"])  # out of range: not comparable
        self.assertIn("ignoring due", err)
        self.assertEqual(ledger.validate(self.state()), [])

    def test_context_sets_status_and_creates_missing_items(self):
        self.merge([cand("canvas:assignment:1:2"), cand("mail:a:1")], "2026-09-27")
        ctx = [
            {"fingerprint": "canvas:assignment:1:2", "title": "x", "status": "accepted", "priority": "high",
             "source": {"kind": "canvas", "label": "L"}, "due": None, "updatedAt": "2026-09-27T16:00:00Z"},
            {"fingerprint": "gradescope:9:7", "title": "Lab 1", "status": "dismissed", "priority": "low",
             "source": {"kind": "gradescope", "label": "L"}, "due": "2026-09-25T23:59:00Z",
             "dismissedReason": "not mine", "updatedAt": "2026-09-20T15:00:00Z"},
            {"fingerprint": "mail:a:1", "status": "archived"},     # unknown status: skipped
            {"fingerprint": "BAD", "status": "new"},               # bad fingerprint: skipped
        ]
        out = self.merge([], "2026-09-28", context=ctx)
        self.assertIn("context: 1 status changes, 1 added, 2 skipped", out)
        items = self.state()["items"]
        self.assertEqual(items["canvas:assignment:1:2"]["status"], "accepted")
        self.assertEqual(items["canvas:assignment:1:2"]["title"], "Item")  # context only sets status
        self.assertIsNone(items["mail:a:1"]["status"])
        self.assertEqual(items["gradescope:9:7"], {
            "title": "Lab 1", "kind": "gradescope", "due": "2026-09-25T23:59:00Z",
            "first_seen": "2026-09-20", "last_seen": "2026-09-20", "times_seen": 0,
            "last_reported": None, "decision": None, "status": "dismissed", "priority": "low"})
        # Seen as a candidate later: counted once, planner status kept.
        self.merge([cand("gradescope:9:7", "Lab 1", kind="gradescope", decision="drop")], "2026-09-29")
        it = self.state()["items"]["gradescope:9:7"]
        self.assertEqual((it["times_seen"], it["first_seen"], it["last_seen"], it["status"]),
                         (1, "2026-09-20", "2026-09-29", "dismissed"))

    def test_context_item_seen_as_candidate_on_the_same_day_counts_once(self):
        self.merge([], "2026-09-28", context=[{"fingerprint": "mail:x:1", "status": "new", "title": "A"}])
        self.assertEqual(self.state()["items"]["mail:x:1"]["times_seen"], 0)
        self.assertEqual(self.state()["items"]["mail:x:1"]["first_seen"], "2026-09-28")  # no updatedAt
        self.merge([cand("mail:x:1")], "2026-09-28")
        self.merge([cand("mail:x:1")], "2026-09-28")
        self.assertEqual(self.state()["items"]["mail:x:1"]["times_seen"], 1)

    def test_context_is_found_under_inputs(self):
        self.merge([cand("mail:a:1")], "2026-09-27")
        self.merge([], "2026-09-28", context=[{"fingerprint": "mail:a:1", "status": "dismissed"}],
                   context_in_inputs=True)
        self.assertEqual(self.state()["items"]["mail:a:1"]["status"], "dismissed")

    def test_an_older_run_is_refused(self):
        self.merge([cand("mail:a:1")], "2026-09-28")
        before = self.raw()
        code, _, err = self.cli("merge", "--run", self.rundir([cand("mail:a:1")]), "--date", "2026-09-27")
        self.assertEqual(code, ledger.EXIT_STALE)
        self.assertIn("backwards", err)
        self.assertEqual(self.raw(), before)

    def test_unreadable_inputs_fail_without_writing(self):
        d = self.rundir([])
        with open(os.path.join(d, "candidates.json"), "w") as f:
            f.write("{truncated")
        code, _, err = self.cli("merge", "--run", d, "--date", "2026-09-27")
        self.assertEqual(code, ledger.EXIT_INPUT)
        self.assertFalse(os.path.exists(self.path))
        code, _, _ = self.cli("merge", "--run", os.path.join(self.home, "nope"), "--date", "2026-09-27")
        self.assertEqual(code, ledger.EXIT_INPUT)
        d = self.rundir([cand("mail:a:1")])
        with open(os.path.join(d, "context.json"), "w") as f:
            f.write("not json")
        code, _, _ = self.cli("merge", "--run", d, "--date", "2026-09-27")
        self.assertEqual(code, ledger.EXIT_INPUT)
        self.assertFalse(os.path.exists(self.path))  # nothing half-merged


class StateFileTests(Base):
    def test_corrupt_json_is_refused_and_left_untouched(self):
        corrupt = b'{"version": 1, "items": {"mail:a:1": {"title": "x"'
        self.write_raw(corrupt)
        for argv in (["merge", "--run", self.rundir([cand("mail:b:2")]), "--date", "2026-09-27"],
                     ["record-run", "--run-id", "2026-09-27T08:00", "--status", "ok", "--trigger", "timer"],
                     ["prune", "--now", NOW], ["since", "--now", NOW], ["show"], ["check"]):
            code, out, err = self.cli(*argv)
            self.assertEqual(code, ledger.EXIT_STATE, argv)
            self.assertIn("not valid JSON", err)
            self.assertEqual(out, "")
        self.assertEqual(self.raw(), corrupt)
        self.assert_no_temp_files()

    def test_wrong_shape_is_refused_and_left_untouched(self):
        for doc in ({"version": 1, "items": [], "runs": []},
                    {"version": 2, "items": {}, "runs": []},
                    {"version": 1, "items": {"mail:a:1": item(times_seen="2")}, "runs": []},
                    [1, 2, 3]):
            data = (json.dumps(doc) + "\n").encode()
            self.write_raw(data)
            code, _, err = self.cli("merge", "--run", self.rundir([cand("mail:b:2")]), "--date", "2026-09-27")
            self.assertEqual(code, ledger.EXIT_STATE, doc)
            self.assertIn("not a valid ledger", err)
            self.assertEqual(self.raw(), data)
            self.assert_no_temp_files()

    def test_missing_directory_and_empty_file_are_an_empty_ledger(self):
        self.assertFalse(os.path.exists(self.mem))
        self.merge([cand("mail:a:1")], "2026-09-27")
        self.assertIn("mail:a:1", self.state()["items"])
        self.write_raw(b"  \n")
        self.merge([cand("mail:b:2")], "2026-09-27")
        self.assertEqual(list(self.state()["items"]), ["mail:b:2"])

    def test_file_format_is_stable_and_readable(self):
        self.merge([cand("mail:a:1", "Café réunion — 数学"), cand("canvas:q:1:1")], "2026-09-27")
        text = self.raw().decode("utf-8")
        self.assertTrue(text.endswith("}\n"))
        self.assertIn("Café réunion — 数学", text)  # ensure_ascii=False
        self.assertEqual(text, json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n")

    def test_writes_leave_no_temp_files(self):
        self.merge([cand("mail:a:1")], "2026-09-27")
        self.ok("record-run", "--run-id", "2026-09-27T08:00", "--status", "ok", "--trigger", "timer")
        self.ok("prune", "--now", NOW)
        self.assert_no_temp_files()

    def test_a_failed_replace_cleans_up_and_keeps_the_old_file(self):
        self.merge([cand("mail:a:1")], "2026-09-27")
        before = self.raw()
        with mock.patch.object(ledger.os, "replace", side_effect=OSError(28, "No space left on device")):
            code, _, err = self.cli("merge", "--run", self.rundir([cand("mail:b:2")]), "--date", "2026-09-28")
        self.assertEqual(code, ledger.EXIT_WRITE)
        self.assertIn("previous file is unchanged", err)
        self.assertEqual(self.raw(), before)
        self.assert_no_temp_files()

    def test_an_invalid_state_is_never_written(self):
        state = ledger.empty_state()
        state["items"]["mail:a:1"] = item(status="maybe")
        with self.assertRaises(ledger.Fail) as cm:
            ledger.save_state(self.home, state)
        self.assertEqual(cm.exception.code, ledger.EXIT_INTERNAL)
        self.assertFalse(os.path.exists(self.path))


class SinceTests(Base):
    def since(self, runs, *extra):
        if runs is not None:
            state = ledger.empty_state()
            state["runs"] = runs
            self.write_state(state)
        return self.ok("since", "--now", NOW, *extra)

    def test_no_runs_looks_back_max_days(self):
        self.assertEqual(self.since(None), "2026-09-24T08:00:00-07:00\n")
        self.assertEqual(self.since([]), "2026-09-24T08:00:00-07:00\n")

    def test_recent_run_is_floored_at_min_hours(self):
        out = self.since([run_rec("2026-09-30T22:00", started="2026-09-30T22:00:05-07:00")])
        self.assertEqual(out, "2026-09-29T20:00:00-07:00\n")

    def test_old_run_is_capped_at_max_days(self):
        out = self.since([run_rec("2026-09-10T08:00", started="2026-09-10T08:00:00-07:00")])
        self.assertEqual(out, "2026-09-24T08:00:00-07:00\n")

    def test_run_inside_the_window_is_used_as_is(self):
        out = self.since([run_rec("2026-09-27T08:00", started="2026-09-27T15:00:03Z")])
        self.assertEqual(out, "2026-09-27T08:00:03-07:00\n")  # Z converted to the offset of --now

    def test_failed_runs_are_ignored_and_partial_counts(self):
        runs = [run_rec("2026-09-26T08:00", started="2026-09-26T08:00:00-07:00"),
                run_rec("2026-09-27T08:00", status="partial", started="2026-09-27T08:00:00-07:00"),
                run_rec("2026-09-28T08:00", status="failed", started="2026-09-28T08:00:00-07:00"),
                run_rec("2026-09-28T09:00", status="ok", started=None)]
        self.assertEqual(self.since(runs), "2026-09-27T08:00:00-07:00\n")

    def test_custom_bounds_and_z_now(self):
        self.write_state(ledger.empty_state())
        out = self.ok("since", "--now", "2026-10-01T15:00:00Z", "--max-days", "2")
        self.assertEqual(out, "2026-09-29T15:00:00+00:00\n")
        for bad in (["--min-hours", "200", "--max-days", "7"], ["--max-days", "nan"], ["--max-days", "0"],
                    ["--min-hours", "-1"], ["--max-days", "1e9"]):
            code, out, _ = self.cli("since", "--now", NOW, *bad)
            self.assertEqual((code, out), (ledger.EXIT_USAGE, ""), bad)

    def test_compute_since_directly(self):
        now = ledger.parse_instant(NOW)
        state = {"version": 1, "items": {}, "runs": [run_rec("2026-09-29T08:00", started="2026-09-29T08:00:00-07:00")]}
        self.assertEqual(ledger.compute_since(state, now, 36, 7).isoformat(), "2026-09-29T08:00:00-07:00")
        self.assertEqual(ledger.compute_since(state, now, 60, 7).isoformat(), "2026-09-28T20:00:00-07:00")
        self.assertEqual(ledger.compute_since(state, now, 12, 1).isoformat(), "2026-09-30T08:00:00-07:00")


class PruneTests(Base):
    def test_age_rules_and_protection_of_new(self):
        state = ledger.empty_state()
        state["items"] = {
            "due:old:1": item(due="2026-08-31T07:00:00-07:00", last_seen="2026-09-30"),   # 31 days past due
            "due:recent:1": item(due="2026-09-02T08:00:00-07:00"),                        # 29 days
            "due:zulu:1": item(due="2026-08-31T14:00:00Z"),                               # 31 days, Z
            "nodue:old:1": item(last_seen="2026-07-31"),                                  # 62 days unseen
            "nodue:edge:1": item(last_seen="2026-08-02"),                                 # 60 days: kept
            "new:old:1": item(status="new", due="2026-01-01T00:00:00Z", last_seen="2026-02-01"),
            "new:unseen:1": item(status="new", first_seen="2026-01-01", last_seen="2026-01-01"),
            "dismissed:old:1": item(status="dismissed", last_seen="2026-06-01"),
        }
        self.write_state(state)
        out = self.ok("prune", "--now", NOW)
        self.assertEqual(out, "pruned 4: 2 due over 30 days ago, 2 unseen for over 60 days, "
                              "0 over the 2000 cap; 4 remain\n")
        self.assertEqual(sorted(self.state()["items"]),
                         ["due:recent:1", "new:old:1", "new:unseen:1", "nodue:edge:1"])

    def test_cap_removes_oldest_and_new_items_last(self):
        base = dt.date(2026, 9, 1)
        state = ledger.empty_state()
        for i in range(ledger.MAX_ITEMS + 5):
            day = (base + dt.timedelta(days=i % 30)).isoformat()
            state["items"][f"mail:x:{i:05d}"] = item(first_seen="2026-09-01", last_seen=day,
                                                     status="new" if i < 2002 else "accepted")
        # The three non-new items are the most recently seen, yet they go first.
        for i in (2002, 2003, 2004):
            state["items"][f"mail:x:{i:05d}"]["last_seen"] = "2026-09-30"
        self.write_state(state)
        removed = ledger.prune_state(ledger.load_state(self.home), ledger.parse_instant(NOW))
        self.assertEqual(removed["cap"][:3], ["mail:x:02002", "mail:x:02003", "mail:x:02004"])
        self.assertEqual(removed["cap"][3:], ["mail:x:00000", "mail:x:00030"])  # oldest new items
        out = self.ok("prune", "--now", NOW)
        self.assertIn("pruned 5:", out)
        self.assertIn("5 over the 2000 cap; 2000 remain", out)
        self.assertEqual(len(self.state()["items"]), ledger.MAX_ITEMS)


class RecordRunTests(Base):
    def test_append_then_replace_by_id(self):
        out = self.ok("record-run", "--run-id", "2026-09-27T08:00", "--status", "failed", "--trigger", "timer",
                      "--started", "2026-09-27T08:00:03-07:00")
        self.assertIn("recorded run 2026-09-27T08:00", out)
        cov = os.path.join(self.home, "brief.json")
        with open(cov, "w") as f:
            json.dump({"date": "2026-09-27", "coverage": [
                {"source": "Main mail", "status": "ok", "detail": "38 threads"},
                {"source": "Gradescope", "status": "skipped", "detail": "Not signed in"},
                {"source": "Broken", "status": "fine"}]}, f)
        out = self.ok("record-run", "--run-id", "2026-09-27T08:00", "--status", "ok", "--trigger", "manual",
                      "--started", "2026-09-27T08:00:03-07:00", "--finished", "2026-09-27T08:14:40-07:00",
                      "--candidates", "31", "--reported", "7", "--coverage-file", cov)
        self.assertIn("replaced run", out)
        runs = self.state()["runs"]
        self.assertEqual(runs, [{
            "date": "2026-09-27", "run_id": "2026-09-27T08:00", "status": "ok", "trigger": "manual",
            "started": "2026-09-27T08:00:03-07:00", "finished": "2026-09-27T08:14:40-07:00",
            "candidates": 31, "reported": 7, "coverage": {"Main mail": "ok", "Gradescope": "skipped"}}])

    def test_keeps_only_the_90_most_recent(self):
        state = ledger.empty_state()
        start = dt.datetime(2026, 6, 1, 8, 0, tzinfo=dt.timezone(dt.timedelta(hours=-7)))
        for i in range(95):
            t = start + dt.timedelta(days=i)
            ledger.record_run(state, run_rec(t.strftime("%Y-%m-%dT%H:%M"), started=t.isoformat()))
        self.assertEqual(len(state["runs"]), 90)
        self.assertEqual(state["runs"][0]["run_id"], "2026-06-06T08:00")
        self.write_state(state)
        out = self.ok("record-run", "--run-id", "2026-09-05T08:00", "--status", "ok", "--trigger", "timer",
                      "--started", "2026-09-05T08:00:00-07:00")
        self.assertIn("90 runs kept, 1 oldest dropped", out)
        runs = self.state()["runs"]
        self.assertEqual((len(runs), runs[0]["run_id"], runs[-1]["run_id"]),
                         (90, "2026-06-07T08:00", "2026-09-05T08:00"))

    def test_bad_coverage_file_still_records_the_run(self):
        code, _, err = self.cli("record-run", "--run-id", "x-1", "--status", "partial", "--trigger", "timer",
                                "--coverage-file", os.path.join(self.home, "missing.json"), "--date", "2026-09-27")
        self.assertEqual(code, 0)
        self.assertIn("coverage not recorded", err)
        self.assertEqual(self.state()["runs"][0]["coverage"], None)
        self.assertEqual(self.state()["runs"][0]["date"], "2026-09-27")

    def test_bad_arguments_are_usage_errors(self):
        with contextlib.redirect_stderr(io.StringIO()):
            for argv in (["--status", "done", "--trigger", "timer"],
                         ["--status", "ok", "--trigger", "timer", "--started", "yesterday"],
                         ["--status", "ok", "--trigger", "timer", "--candidates", "-1"]):
                with self.assertRaises(SystemExit) as cm:
                    ledger.main(["--home", self.home, "record-run", "--run-id", "r", *argv])
                self.assertEqual(cm.exception.code, ledger.EXIT_USAGE)
        self.assertFalse(os.path.exists(self.path))


class ShowAndCheckTests(Base):
    def test_show_table_newest_first_and_json(self):
        self.merge([cand("mail:old:1", "Old thing")], "2026-09-20")
        self.merge([cand("canvas:new:1", "New  thing\nsecond line", due="2026-10-01T23:59:00-07:00")], "2026-09-27")
        out = self.ok("show")
        lines = out.splitlines()
        self.assertTrue(lines[0].startswith("FINGERPRINT"))
        self.assertTrue(lines[1].startswith("canvas:new:1"))
        self.assertTrue(lines[1].endswith("New thing second line"))
        self.assertTrue(lines[2].startswith("mail:old:1"))
        self.assertEqual(lines[-1], "2 items (showing 2), 0 runs")
        self.assertIn("showing 1", self.ok("show", "--limit", "1"))
        self.assertEqual(self.ok("show", "--json").encode("utf-8"), self.raw())

    def test_check_good_missing_and_bad(self):
        self.assertIn("does not exist yet", self.ok("check"))
        self.merge([cand("mail:a:1")], "2026-09-27")
        self.assertIn("1 items, 0 runs", self.ok("check"))
        state = self.state()
        state["items"]["mail:a:1"]["status"] = "maybe"
        state["items"]["NOT A FINGERPRINT"] = item()
        state["runs"].append({"run_id": "x"})
        data = json.dumps(state).encode()
        self.write_raw(data)
        mtime = os.stat(self.path).st_mtime_ns
        code, out, err = self.cli("check")
        self.assertEqual((code, out), (ledger.EXIT_STATE, ""))
        for needle in ("status must be one of", "not a valid fingerprint", "runs[0]: missing"):
            self.assertIn(needle, err)
        self.assertEqual(self.raw(), data)
        self.assertEqual(os.stat(self.path).st_mtime_ns, mtime)


class EndToEndTests(Base):
    """The script as run.sh runs it: a separate process, home from --home or $BP_HOME."""

    def proc(self, *argv, env_home=False):
        env = {k: v for k, v in os.environ.items() if k != "BP_HOME"}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if env_home:
            env["BP_HOME"] = self.home
        else:
            argv = ("--home", self.home) + argv
        return subprocess.run([SCRIPT, *argv], capture_output=True, text=True, env=env,
                              cwd=tempfile.gettempdir(), timeout=60)

    def test_script_is_executable(self):
        self.assertTrue(os.access(SCRIPT, os.X_OK))
        with open(SCRIPT, encoding="utf-8") as f:
            self.assertEqual(f.readline(), "#!/usr/bin/env python3\n")

    def test_merge_record_since_show_via_subprocess(self):
        d = self.rundir([cand("canvas:assignment:1:2", "HW 1"), cand("x", "bad")])
        r = self.proc("merge", "--run", d, "--date", "2026-09-27")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.count("\n"), 1)
        self.assertIn("new 1, updated 0, unchanged 0, skipped 1", r.stdout)
        r = self.proc("record-run", "--run-id", "2026-09-27T08:00", "--status", "ok", "--trigger", "timer",
                      "--started", "2026-09-27T08:00:03-07:00", env_home=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.proc("since", "--now", "2026-09-30T08:00:00-07:00", env_home=True)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "2026-09-27T08:00:03-07:00\n", ""))
        r = self.proc("show")
        self.assertIn("canvas:assignment:1:2", r.stdout)
        self.assert_no_temp_files()

    def test_corrupt_state_via_subprocess(self):
        self.write_raw(b"\x00\x01garbage")
        before = self.raw()
        r = self.proc("check")
        self.assertEqual(r.returncode, ledger.EXIT_STATE)
        self.assertTrue(r.stderr.startswith("ledger: "))
        r = self.proc("since", env_home=True)
        self.assertEqual((r.returncode, r.stdout), (ledger.EXIT_STATE, ""))
        self.assertEqual(self.raw(), before)

    def test_missing_home_is_a_usage_error(self):
        r = subprocess.run([sys.executable, SCRIPT, "--home", os.path.join(self.home, "absent"), "check"],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, ledger.EXIT_USAGE)
        self.assertIn("does not exist", r.stderr)


if __name__ == "__main__":
    unittest.main()
