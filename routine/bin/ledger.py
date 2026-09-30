#!/usr/bin/env python3
"""ledger: the routine's memory of what it has already seen and reported.

    ledger merge --run RUNDIR [--date YYYY-MM-DD]          fold a run's candidates and planner context in
    ledger record-run --run-id ID --status S --trigger T   add or replace a run record
           [--started ISO] [--finished ISO] [--candidates N] [--reported N]
           [--coverage-file FILE] [--date YYYY-MM-DD]
    ledger since [--min-hours 36] [--max-days 7] [--now ISO]   print the timestamp to look back to
    ledger prune [--now ISO]                                drop stale items, cap the ledger at 2000
    ledger show [--json] [--limit N]                        print the ledger
    ledger check                                            validate the state file; never writes

State lives in <home>/memory/state.json. <home> is --home, else $BP_HOME, else the current
directory. This program is the only writer of that file; the routine and mentor agents only
read it. Every write is validated first, then goes to a temp file in the same directory that
replaces the old file atomically. A state file that is not valid JSON or has the wrong shape
is never overwritten: every command refuses it and exits 3. `ledger check` lists the problems.

Rules worth knowing:
  - times_seen counts distinct run dates on which the item was a candidate, so re-merging a
    run on the same date changes nothing. Merging a run dated before the newest last_seen in
    the ledger is refused (exit 6), because it would move items backwards.
  - A candidate field that is absent or invalid leaves the stored value as it was (null on a
    new item); invalid values are named on stderr. Entries without a valid fingerprint, and
    repeats of a fingerprint within one run, are skipped and counted.
  - status comes only from the planner context: RUNDIR/context.json, else
    RUNDIR/inputs/context.json (where run.sh saves it). An item missing from the context keeps
    its last known status. An item the context has but the ledger lacks is added with
    times_seen 0.
  - record-run still records the run when its coverage file is missing or unusable; it warns
    and stores coverage as null.
  - Timestamps without an offset are read as local time; dates taken from a timestamp are
    its calendar date in its own offset.

Exit codes: 0 ok, 1 internal error (a write that would fail validation), 2 usage,
3 state file invalid or unreadable (left untouched), 4 input file missing or invalid,
5 cannot write the state file or take its lock, 6 run older than the ledger.

Standard library only. See routine/SPEC.md section 3 for fingerprints and suggestions.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
import re
import sys
import tempfile
import time

VERSION = 1
EXIT_INTERNAL, EXIT_USAGE, EXIT_STATE, EXIT_INPUT, EXIT_WRITE, EXIT_STALE = 1, 2, 3, 4, 5, 6

FINGERPRINT = re.compile(r"^[a-z0-9][a-z0-9:._@-]{2,159}$")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DECISIONS = ("keep", "brief", "drop")
STATUSES = ("new", "accepted", "dismissed")
PRIORITIES = ("high", "medium", "low")
RUN_STATUSES = ("ok", "failed", "partial")
TRIGGERS = ("timer", "manual")
COVERAGE = ("ok", "partial", "skipped", "error")

ITEM_KEYS = frozenset(("title", "kind", "due", "first_seen", "last_seen", "times_seen",
                       "last_reported", "decision", "status", "priority"))
RUN_KEYS = frozenset(("date", "run_id", "status", "trigger", "started", "finished",
                      "candidates", "reported", "coverage"))
CANDIDATE_FIELDS = ("title", "kind", "due", "priority", "decision")
CONTEXT_FIELDS = ("title", "kind", "due", "priority")

MAX_RUNS = 90
MAX_ITEMS = 2000
DUE_GRACE_DAYS = 30
UNSEEN_DAYS = 60
LOCK_TIMEOUT_S = 30.0
MAX_LISTED_PROBLEMS = 50


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def warn(message):
    print("ledger: warning:", message, file=sys.stderr)


# ---------------------------------------------------------------------- time

def parse_instant(value):
    """ISO 8601 timestamp -> aware datetime. Offsets and Z accepted; naive means local time."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"not a timestamp: {value!r}")
    s = value.strip()
    if s[-1] in "Zz":
        s = s[:-1] + "+00:00"
    t = dt.datetime.fromisoformat(s)
    try:
        t = t if t.tzinfo is not None else t.astimezone()
        t.astimezone(dt.timezone.utc)  # years 1 and 9999 with an offset cannot be compared
    except OverflowError:
        raise ValueError(f"timestamp out of range: {value!r}")
    return t


def parse_day(value):
    """YYYY-MM-DD -> date. Raises ValueError."""
    if not isinstance(value, str) or not DAY.fullmatch(value):
        raise ValueError(f"not a YYYY-MM-DD date: {value!r}")
    return dt.date.fromisoformat(value)


def local_now():
    return dt.datetime.now().astimezone().replace(microsecond=0)


def day_prefix(value):
    """The YYYY-MM-DD a run id or timestamp starts with, or None."""
    if isinstance(value, str) and len(value) >= 10:
        try:
            return parse_day(value[:10]).isoformat()
        except ValueError:
            return None
    return None


# --------------------------------------------------------------- state file

def empty_state():
    return {"version": VERSION, "items": {}, "runs": []}


def state_path(home):
    return os.path.join(home, "memory", "state.json")


def dump(state):
    return json.dumps(state, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _check_instant(v, where, errs):
    try:
        parse_instant(v)
    except ValueError:
        errs.append(f"{where} must be an ISO 8601 timestamp or null, found {v!r}")


def _check_day(v, where, errs):
    try:
        parse_day(v)
        return True
    except ValueError:
        errs.append(f"{where} must be YYYY-MM-DD, found {v!r}")
        return False


def validate_item(fp, it):
    where = f"items[{fp!r}]"
    errs = []
    if not FINGERPRINT.fullmatch(fp):
        errs.append(f"{where}: key is not a valid fingerprint")
    if not isinstance(it, dict):
        return errs + [f"{where}: not an object"]
    missing, extra = sorted(ITEM_KEYS - set(it)), sorted(set(it) - ITEM_KEYS)
    if missing:
        errs.append(f"{where}: missing {', '.join(missing)}")
    if extra:
        errs.append(f"{where}: unknown keys {', '.join(extra)}")
    if "title" in it and not isinstance(it["title"], str):
        errs.append(f"{where}.title must be a string")
    if "kind" in it and it["kind"] is not None and not (isinstance(it["kind"], str) and it["kind"]):
        errs.append(f"{where}.kind must be a non-empty string or null")
    if it.get("due") is not None:
        _check_instant(it["due"], f"{where}.due", errs)
    days_ok = all([_check_day(it[k], f"{where}.{k}", errs) for k in ("first_seen", "last_seen") if k in it])
    if days_ok and "first_seen" in it and "last_seen" in it and it["first_seen"] > it["last_seen"]:
        errs.append(f"{where}: first_seen is after last_seen")
    if "times_seen" in it and not (_is_int(it["times_seen"]) and it["times_seen"] >= 0):
        errs.append(f"{where}.times_seen must be an integer >= 0")
    if it.get("last_reported") is not None:
        _check_day(it["last_reported"], f"{where}.last_reported", errs)
    for key, allowed in (("decision", DECISIONS), ("status", STATUSES), ("priority", PRIORITIES)):
        if key in it and it[key] is not None and it[key] not in allowed:
            errs.append(f"{where}.{key} must be one of {', '.join(allowed)} or null, found {it[key]!r}")
    return errs


def validate_run(i, r):
    where = f"runs[{i}]"
    if not isinstance(r, dict):
        return [f"{where}: not an object"]
    errs = []
    missing, extra = sorted(RUN_KEYS - set(r)), sorted(set(r) - RUN_KEYS)
    if missing:
        errs.append(f"{where}: missing {', '.join(missing)}")
    if extra:
        errs.append(f"{where}: unknown keys {', '.join(extra)}")
    if "date" in r:
        _check_day(r["date"], f"{where}.date", errs)
    if "run_id" in r and not (isinstance(r["run_id"], str) and r["run_id"].strip()):
        errs.append(f"{where}.run_id must be a non-empty string")
    if "status" in r and r["status"] not in RUN_STATUSES:
        errs.append(f"{where}.status must be one of {', '.join(RUN_STATUSES)}, found {r['status']!r}")
    if "trigger" in r and r["trigger"] not in TRIGGERS:
        errs.append(f"{where}.trigger must be one of {', '.join(TRIGGERS)}, found {r['trigger']!r}")
    for key in ("started", "finished"):
        if r.get(key) is not None:
            _check_instant(r[key], f"{where}.{key}", errs)
    for key in ("candidates", "reported"):
        if r.get(key) is not None and not (_is_int(r[key]) and r[key] >= 0):
            errs.append(f"{where}.{key} must be an integer >= 0 or null")
    cov = r.get("coverage")
    if cov is not None:
        if not isinstance(cov, dict):
            errs.append(f"{where}.coverage must be an object or null")
        else:
            for src, st in sorted(cov.items()):
                if st not in COVERAGE:
                    errs.append(f"{where}.coverage[{src!r}] must be one of {', '.join(COVERAGE)}")
    return errs


def validate(state):
    """Every problem with the state's shape, as a list of strings. Empty means valid."""
    if not isinstance(state, dict):
        return ["the top level is not an object"]
    errs = []
    extra = sorted(set(state) - {"version", "items", "runs"})
    if extra:
        errs.append(f"unknown top-level keys: {', '.join(extra)}")
    v = state.get("version")
    if not (_is_int(v) and v == VERSION):
        errs.append(f"version must be {VERSION}, found {v!r}")
    items = state.get("items")
    if not isinstance(items, dict):
        errs.append("items must be an object keyed by fingerprint")
    else:
        for fp in sorted(items):
            errs += validate_item(fp, items[fp])
    runs = state.get("runs")
    if not isinstance(runs, list):
        errs.append("runs must be a list")
    else:
        seen = set()
        for i, r in enumerate(runs):
            errs += validate_run(i, r)
            rid = r.get("run_id") if isinstance(r, dict) else None
            if isinstance(rid, str):
                if rid in seen:
                    errs.append(f"runs[{i}]: duplicate run_id {rid!r}")
                seen.add(rid)
    return errs


def _problem_list(problems):
    shown = problems[:MAX_LISTED_PROBLEMS]
    text = "\n  - " + "\n  - ".join(shown)
    if len(problems) > len(shown):
        text += f"\n  ... and {len(problems) - len(shown)} more"
    return text


def load_state(home):
    """The ledger at <home>. Missing or empty file -> empty ledger. Anything invalid -> Fail(3)."""
    path = state_path(home)
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return empty_state()
    except OSError as e:
        raise Fail(EXIT_STATE, f"cannot read {path}: {e}")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise Fail(EXIT_STATE, f"{path} is not UTF-8 ({e}). It was left untouched.")
    if not text.strip():
        return empty_state()
    try:
        state = json.loads(text)
    except ValueError as e:
        raise Fail(EXIT_STATE, f"{path} is not valid JSON ({e}). It was left untouched; "
                               f"fix or move it aside, then run again.")
    problems = validate(state)
    if problems:
        raise Fail(EXIT_STATE, f"{path} is not a valid ledger ({len(problems)} problems). "
                               f"It was left untouched:" + _problem_list(problems))
    return state


def _current_mode(path):
    try:
        return os.stat(path).st_mode & 0o777
    except FileNotFoundError:
        mask = os.umask(0)
        os.umask(mask)
        return 0o666 & ~mask


def save_state(home, state):
    """Validate, then replace the state file atomically. Returns False when nothing changed."""
    problems = validate(state)
    if problems:
        raise Fail(EXIT_INTERNAL, "internal error: refusing to write a ledger that fails validation:"
                                  + _problem_list(problems))
    path = state_path(home)
    text = dump(state)
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    except (OSError, ValueError):
        pass
    directory = os.path.dirname(path)
    try:
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".state.json.", suffix=".tmp", dir=directory)
    except OSError as e:
        raise Fail(EXIT_WRITE, f"cannot write in {directory}: {e}")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, _current_mode(path))
        os.replace(tmp, path)
    except BaseException as e:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        if isinstance(e, OSError):
            raise Fail(EXIT_WRITE, f"cannot write {path}: {e}. The previous file is unchanged.")
        raise
    with contextlib.suppress(OSError):
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    return True


@contextlib.contextmanager
def locked(home):
    """Exclusive lock on <home>/memory for one read-modify-write (a timer run and a manual run
    can overlap). flock on the directory itself, so no lock file is left behind."""
    directory = os.path.join(home, "memory")
    try:
        os.makedirs(directory, exist_ok=True)
        fd = os.open(directory, os.O_RDONLY)
    except OSError as e:
        raise Fail(EXIT_WRITE, f"cannot open {directory}: {e}")
    try:
        deadline = time.monotonic() + LOCK_TIMEOUT_S
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise Fail(EXIT_WRITE, f"another ledger process has held {directory} "
                                           f"for {LOCK_TIMEOUT_S:.0f} s; try again")
                time.sleep(0.1)
        yield
    finally:
        os.close(fd)


def resolve_home(args):
    home = os.path.abspath(getattr(args, "home", None) or os.environ.get("BP_HOME") or os.getcwd())
    if not os.path.isdir(home):
        raise Fail(EXIT_USAGE, f"home directory {home} does not exist")
    return home


def read_json(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise Fail(EXIT_INPUT, f"{what} not found: {path}")
    except (OSError, ValueError) as e:
        raise Fail(EXIT_INPUT, f"cannot read {what} {path}: {e}")


# -------------------------------------------------------------------- merge

def new_item(day):
    return {"title": "", "kind": None, "due": None, "first_seen": day, "last_seen": day,
            "times_seen": 0, "last_reported": None, "decision": None, "status": None,
            "priority": None}


def read_fields(entry, where, wanted, on_warn):
    """The fields in `wanted` that `entry` carries with a usable value, normalised."""
    out = {}

    def bad(key, value):
        on_warn(f"{where}: ignoring {key} {value!r}")

    if "title" in wanted and "title" in entry:
        if isinstance(entry["title"], str):
            out["title"] = entry["title"]
        else:
            bad("title", entry["title"])
    src = entry.get("source")
    if "kind" in wanted and isinstance(src, dict) and "kind" in src:
        k = src["kind"]
        if k is None:
            out["kind"] = None
        elif isinstance(k, str) and k.strip():
            out["kind"] = k.strip()
        else:
            bad("source.kind", k)
    if "due" in wanted and "due" in entry:
        d = entry["due"]
        if d is None:
            out["due"] = None
        else:
            try:
                parse_instant(d)
                out["due"] = d.strip()
            except ValueError:
                bad("due", d)
    for key, allowed in (("priority", PRIORITIES), ("decision", DECISIONS)):
        if key in wanted and key in entry:
            v = entry[key]
            if v is None:
                out[key] = None
            elif isinstance(v, str) and v.strip().lower() in allowed:
                out[key] = v.strip().lower()
            else:
                bad(key, v)
    return out


def _fingerprint(entry):
    fp = entry.get("fingerprint") if isinstance(entry, dict) else None
    return fp if isinstance(fp, str) and FINGERPRINT.fullmatch(fp) else None


def merge_run(state, candidates, context, day, on_warn=warn):
    """Fold one run into `state` in place. `context` is a list of planner suggestions or None.
    Returns the counts printed in the summary line."""
    items = state["items"]
    d = day.isoformat()
    newest = max((it["last_seen"] for it in items.values()), default=None)
    if newest is not None and d < newest:
        raise Fail(EXIT_STALE, f"the ledger already holds items seen on {newest}; merging a run "
                               f"dated {d} would move them backwards. Nothing was changed.")
    n = {"new": 0, "updated": 0, "unchanged": 0, "skipped": 0,
         "status_changed": 0, "context_added": 0, "context_skipped": 0}

    seen = set()
    for i, c in enumerate(candidates):
        where = f"candidates[{i}]"
        fp = _fingerprint(c)
        if fp is None:
            n["skipped"] += 1
            raw = c.get("fingerprint") if isinstance(c, dict) else c
            on_warn(f"{where}: skipped, no valid fingerprint ({raw!r})")
            continue
        if fp in seen:
            n["skipped"] += 1
            on_warn(f"{where}: skipped, {fp} already appeared in this run")
            continue
        seen.add(fp)
        fields = read_fields(c, where, CANDIDATE_FIELDS, on_warn)
        item = items.get(fp)
        before = None if item is None else dict(item)
        if item is None:
            item = items[fp] = new_item(d)
        # times_seen == 0: the item came from the planner context and was never a candidate.
        if item["times_seen"] == 0 or item["last_seen"] < d:
            item["times_seen"] += 1
        item["last_seen"] = d
        item.update(fields)
        if fields.get("decision") == "keep":
            item["last_reported"] = d
        if before is None:
            n["new"] += 1
        else:
            n["updated" if item != before else "unchanged"] += 1

    for j, s in enumerate(context or []):
        where = f"context.suggestions[{j}]"
        fp = _fingerprint(s)
        st = s.get("status") if isinstance(s, dict) else None
        st = st.strip().lower() if isinstance(st, str) else st
        if fp is None or st not in STATUSES:
            n["context_skipped"] += 1
            on_warn(f"{where}: skipped, needs a valid fingerprint and a status of {', '.join(STATUSES)}")
            continue
        item = items.get(fp)
        if item is None:
            first = d
            try:
                first = min(parse_instant(s.get("updatedAt")).date().isoformat(), d)
            except ValueError:
                pass
            item = items[fp] = new_item(first)
            item.update(read_fields(s, where, CONTEXT_FIELDS, on_warn))
            item["status"] = st
            n["context_added"] += 1
        elif item["status"] != st:
            item["status"] = st
            n["status_changed"] += 1
    return n


def cmd_merge(args):
    home = resolve_home(args)
    rundir = args.run
    if not os.path.isdir(rundir):
        raise Fail(EXIT_INPUT, f"run directory not found: {rundir}")
    doc = read_json(os.path.join(rundir, "candidates.json"), "candidates file")
    if isinstance(doc, list):
        candidates, run_id = doc, None
    elif isinstance(doc, dict) and isinstance(doc.get("candidates"), list):
        candidates, run_id = doc["candidates"], doc.get("runId")
    else:
        raise Fail(EXIT_INPUT, "candidates.json must be a list, or an object with a candidates list")
    context = None
    # run.sh saves the planner context as inputs/context.json; a copy at the top level wins.
    ctx_path = next((p for p in (os.path.join(rundir, "context.json"),
                                 os.path.join(rundir, "inputs", "context.json")) if os.path.exists(p)), None)
    if ctx_path:
        ctx = read_json(ctx_path, "context file")
        if isinstance(ctx, list):
            context = ctx
        elif isinstance(ctx, dict) and isinstance(ctx.get("suggestions"), list):
            context = ctx["suggestions"]
        elif isinstance(ctx, dict) and "suggestions" not in ctx:
            warn("context.json has no suggestions list; no statuses applied")
            context = []
        else:
            raise Fail(EXIT_INPUT, "context.json: suggestions must be a list")
    day = args.date or (parse_day(day_prefix(run_id)) if day_prefix(run_id) else local_now().date())

    with locked(home):
        state = load_state(home)
        n = merge_run(state, candidates, context, day)
        save_state(home, state)

    label = f" (run {run_id})" if isinstance(run_id, str) and run_id else ""
    line = (f"merge {day.isoformat()}{label}: new {n['new']}, updated {n['updated']}, "
            f"unchanged {n['unchanged']}, skipped {n['skipped']}; ")
    if context is None:
        line += "no context.json"
    else:
        line += (f"context: {n['status_changed']} status changes, {n['context_added']} added, "
                 f"{n['context_skipped']} skipped")
    print(line)
    return 0


# --------------------------------------------------------------- record-run

def _run_order(r):
    started = ""
    if r.get("started"):
        started = parse_instant(r["started"]).astimezone(dt.timezone.utc).isoformat()
    return (r["date"], started, r["run_id"])


def record_run(state, run):
    """Add `run`, replacing any run with the same run_id; keep the MAX_RUNS most recent.
    Returns (replaced, dropped, kept)."""
    runs = [r for r in state["runs"] if r["run_id"] != run["run_id"]]
    replaced = len(runs) != len(state["runs"])
    runs.append(run)
    runs.sort(key=_run_order)
    dropped = max(0, len(runs) - MAX_RUNS)
    state["runs"] = runs[dropped:]
    return replaced, dropped, any(r is run for r in state["runs"])


def coverage_from(doc, on_warn=warn):
    """A brief's coverage list (SPEC section 3) as {source: status}; None when there is none.
    A report wrapping the brief, or a bare list, is accepted too."""
    if isinstance(doc, dict) and "coverage" not in doc and isinstance(doc.get("brief"), dict):
        doc = doc["brief"]
    cov = doc.get("coverage") if isinstance(doc, dict) else doc
    if not isinstance(cov, list):
        on_warn("the coverage file has no coverage list; coverage not recorded")
        return None
    out = {}
    for i, c in enumerate(cov):
        src = c.get("source") if isinstance(c, dict) else None
        st = c.get("status") if isinstance(c, dict) else None
        st = st.strip().lower() if isinstance(st, str) else st
        if not (isinstance(src, str) and src.strip()) or st not in COVERAGE:
            on_warn(f"coverage[{i}]: skipped, needs a source and a status of {', '.join(COVERAGE)}")
            continue
        out[src.strip()] = st
    return out


def cmd_record_run(args):
    home = resolve_home(args)
    run_id = args.run_id.strip()
    if not run_id:
        raise Fail(EXIT_USAGE, "--run-id must not be empty")
    coverage = None
    if args.coverage_file:
        # Recording the run matters more than its coverage: a bad coverage file is a warning.
        try:
            coverage = coverage_from(read_json(args.coverage_file, "coverage file"))
        except Fail as e:
            warn(f"{e}; coverage not recorded")
    day = args.date
    if day is None:
        prefix = day_prefix(run_id)
        if prefix:
            day = parse_day(prefix)
        elif args.started:
            day = parse_instant(args.started).date()
        else:
            day = local_now().date()
    run = {"date": day.isoformat(), "run_id": run_id, "status": args.status, "trigger": args.trigger,
           "started": args.started, "finished": args.finished, "candidates": args.candidates,
           "reported": args.reported, "coverage": coverage}
    with locked(home):
        state = load_state(home)
        replaced, dropped, kept = record_run(state, run)
        save_state(home, state)
    verb = "replaced" if replaced else "recorded"
    line = f"{verb} run {run_id} ({args.status}, {args.trigger}); {len(state['runs'])} runs kept"
    if dropped:
        line += f", {dropped} oldest dropped"
    if not kept:
        line += "; this run was older than all kept runs and was not kept"
    print(line)
    return 0


# -------------------------------------------------------------------- since

def compute_since(state, now, min_hours=36.0, max_days=7.0):
    """started of the newest ok/partial run, clamped to [now - max_days, now - min_hours]."""
    upper = now - dt.timedelta(hours=min_hours)
    lower = now - dt.timedelta(days=max_days)
    newest = None
    for r in state["runs"]:
        if r["status"] in ("ok", "partial") and r.get("started"):
            t = parse_instant(r["started"])
            if newest is None or t > newest:
                newest = t
    result = lower if newest is None else min(max(newest, lower), upper)
    return result.astimezone(now.tzinfo)


def cmd_since(args):
    home = resolve_home(args)
    if not (0 <= args.min_hours <= 24 * 3660 and 0 < args.max_days <= 3660):  # also rejects NaN
        raise Fail(EXIT_USAGE, "--min-hours must be >= 0 and --max-days between 0 and 3660")
    if args.min_hours > args.max_days * 24:
        raise Fail(EXIT_USAGE, "--min-hours reaches further back than --max-days")
    state = load_state(home)
    now = args.now or local_now()
    try:
        since = compute_since(state, now, args.min_hours, args.max_days)
    except OverflowError:
        raise Fail(EXIT_USAGE, f"--now {now.isoformat()} minus --max-days is out of range")
    print(since.isoformat())
    return 0


# -------------------------------------------------------------------- prune

def prune_state(state, now):
    """Remove stale items in place. Returns {"due": [...], "unseen": [...], "cap": [...]}."""
    items = state["items"]
    today = now.date()
    removed = {"due": [], "unseen": [], "cap": []}
    for fp in sorted(items):
        it = items[fp]
        if it["status"] == "new":
            continue  # the user has not dealt with it yet
        if it["due"] is not None:
            if now - parse_instant(it["due"]) > dt.timedelta(days=DUE_GRACE_DAYS):
                removed["due"].append(fp)
        elif (today - parse_day(it["last_seen"])).days > UNSEEN_DAYS:
            removed["unseen"].append(fp)
    for fp in removed["due"] + removed["unseen"]:
        del items[fp]
    excess = len(items) - MAX_ITEMS
    if excess > 0:
        order = sorted(items, key=lambda fp: (items[fp]["status"] == "new", items[fp]["last_seen"], fp))
        removed["cap"] = order[:excess]
        for fp in removed["cap"]:
            del items[fp]
    return removed


def cmd_prune(args):
    home = resolve_home(args)
    now = args.now or local_now()
    with locked(home):
        state = load_state(home)
        removed = prune_state(state, now)
        save_state(home, state)
    total = sum(len(v) for v in removed.values())
    print(f"pruned {total}: {len(removed['due'])} due over {DUE_GRACE_DAYS} days ago, "
          f"{len(removed['unseen'])} unseen for over {UNSEEN_DAYS} days, "
          f"{len(removed['cap'])} over the {MAX_ITEMS} cap; {len(state['items'])} remain")
    return 0


# --------------------------------------------------------------- show, check

def cmd_show(args):
    home = resolve_home(args)
    state = load_state(home)
    if args.json:
        sys.stdout.write(dump(state))
        return 0
    items = state["items"]
    order = sorted(items, key=lambda fp: (-dt.date.fromisoformat(items[fp]["last_seen"]).toordinal(), fp))
    shown = order[:args.limit] if args.limit else order
    header = ("FINGERPRINT", "STATUS", "DECISION", "DUE", "LAST SEEN", "TITLE")
    rows = [(fp, items[fp]["status"] or "-", items[fp]["decision"] or "-", items[fp]["due"] or "-",
             items[fp]["last_seen"], " ".join(items[fp]["title"].split()) or "-") for fp in shown]
    if rows:
        widths = [max(len(r[i]) for r in rows + [header]) for i in range(5)]
        for r in [header] + rows:
            print("  ".join(r[i].ljust(widths[i]) for i in range(5)) + "  " + r[5])
    else:
        print("no items")
    runs = state["runs"]
    tail = f"; last run {runs[-1]['run_id']} {runs[-1]['status']}" if runs else ""
    print(f"{len(items)} items (showing {len(rows)}), {len(runs)} runs{tail}")
    return 0


def cmd_check(args):
    home = resolve_home(args)
    path = state_path(home)
    state = load_state(home)
    if not os.path.exists(path):
        print(f"ok: {path} does not exist yet (an empty ledger)")
    else:
        print(f"ok: {path}: {len(state['items'])} items, {len(state['runs'])} runs")
    return 0


# --------------------------------------------------------------------- main

def _arg_day(value):
    try:
        return parse_day(value)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e))


def _arg_instant(value):
    try:
        return parse_instant(value)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"not an ISO 8601 timestamp: {value!r} ({e})")


def _arg_timestamp_text(value):
    _arg_instant(value)
    return value.strip()


def _arg_count(value):
    try:
        n = int(value)
    except ValueError:
        n = -1
    if n < 0:
        raise argparse.ArgumentTypeError(f"must be an integer >= 0: {value!r}")
    return n


def _arg_positive(value):
    n = _arg_count(value)
    if n == 0:
        raise argparse.ArgumentTypeError("must be at least 1")
    return n


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--home", default=argparse.SUPPRESS,
                        help="instance directory holding memory/ (default: $BP_HOME, else the current directory)")
    ap = argparse.ArgumentParser(prog="ledger", parents=[common],
                                 description="The routine's memory of candidates and runs.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("merge", parents=[common], help="fold a run's candidates and context into the ledger")
    p.add_argument("--run", required=True, metavar="RUNDIR", help="directory with candidates.json [and context.json]")
    p.add_argument("--date", type=_arg_day, help="run date (default: from runId, else today)")
    p.set_defaults(fn=cmd_merge)

    p = sub.add_parser("record-run", parents=[common], help="add or replace a run record")
    p.add_argument("--run-id", required=True)
    p.add_argument("--status", required=True, choices=RUN_STATUSES)
    p.add_argument("--trigger", required=True, choices=TRIGGERS)
    p.add_argument("--started", type=_arg_timestamp_text, metavar="ISO")
    p.add_argument("--finished", type=_arg_timestamp_text, metavar="ISO")
    p.add_argument("--candidates", type=_arg_count, metavar="N")
    p.add_argument("--reported", type=_arg_count, metavar="N")
    p.add_argument("--coverage-file", metavar="FILE", help="a brief (JSON) whose coverage list is stored")
    p.add_argument("--date", type=_arg_day, help="run date (default: from --run-id, else --started, else today)")
    p.set_defaults(fn=cmd_record_run)

    p = sub.add_parser("since", parents=[common], help="print the timestamp the next run should look back to")
    p.add_argument("--min-hours", type=float, default=36.0)
    p.add_argument("--max-days", type=float, default=7.0)
    p.add_argument("--now", type=_arg_instant, metavar="ISO")
    p.set_defaults(fn=cmd_since)

    p = sub.add_parser("prune", parents=[common], help="drop stale items and cap the ledger")
    p.add_argument("--now", type=_arg_instant, metavar="ISO")
    p.set_defaults(fn=cmd_prune)

    p = sub.add_parser("show", parents=[common], help="print the ledger")
    p.add_argument("--json", action="store_true", help="the whole state file as JSON")
    p.add_argument("--limit", type=_arg_positive, metavar="N", help="at most N table rows")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("check", parents=[common], help="validate the state file; never writes")
    p.set_defaults(fn=cmd_check)
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except Fail as e:
        print("ledger:", e, file=sys.stderr)
        return e.code


if __name__ == "__main__":
    sys.exit(main())
