#!/usr/bin/env bash
# One run of the routine: preflight, routine agent, mentor agent, report, memory upkeep.
#
#   bin/run.sh                 timer run: only near the configured time, once a day
#   bin/run.sh --manual        started by hand (keyboard shortcut); always shows notifications
#   bin/run.sh --dry-run       everything except sending the report and updating the memory
#   bin/run.sh --skip-mentor   routine agent only
#
# The agents get no shell. Everything that talks to the planner, touches the ledger, or reads
# files outside the instance happens here, before and after them.
set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# The routine runs on the owner's Claude plan and nothing else. Credentials that would bill an
# API account or another provider are dropped here, and the sign-in method is checked below.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
      CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY

INSTANCE="${BP_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
KIT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
export BP_HOME="$INSTANCE"
cd "$INSTANCE"

DRY=0; MANUAL=0; MENTOR=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --manual) MANUAL=1 ;;
    --skip-mentor) MENTOR=0 ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown option $a" >&2; exit 2 ;;
  esac
done
# A person at a terminal is a manual run too, even without the flag.
if [ -t 1 ]; then MANUAL=1; fi

[ -f config.json ] || { echo "run.sh: $INSTANCE has no config.json" >&2; exit 2; }
cfg() { python3 - "$1" "${2-}" <<'PY'
import json, sys
key, default = sys.argv[1], sys.argv[2]
try:
    v = json.load(open("config.json")).get(key, default)
except Exception:
    v = default
print(str(v).lower() if isinstance(v, bool) else v)
PY
}
cfg_list() { python3 -c 'import json,sys
for x in json.load(open("config.json")).get(sys.argv[1], []): print(x)' "$1" 2>/dev/null || true; }

TZ_NAME="$(cfg timezone "")"; if [ -n "$TZ_NAME" ]; then export TZ="$TZ_NAME"; fi
DAILY="$(cfg daily_time 08:00)"
GRACE_MIN="$(cfg timer_grace_minutes 20)"
ROUTINE_MODEL="$(cfg routine_model opus)"
MENTOR_MODEL="$(cfg mentor_model fable)"
ROUTINE_MINUTES="$(cfg routine_minutes 35)"
MENTOR_MINUTES="$(cfg mentor_minutes 25)"
KEEP_DAYS="$(cfg keep_run_days 30)"
NEED_BROWSER="$(cfg require_browser true)"
KEEP_TRANSCRIPTS="$(cfg keep_transcripts false)"

notify() {  # title, body. BP_QUIET=1 silences notifications (used by the tests).
  if [ -n "${BP_QUIET:-}" ]; then return 0; fi
  command -v notify-send >/dev/null 2>&1 || return 0
  notify-send --app-name="Day Planner" --icon=x-office-calendar "$1" "${2-}" >/dev/null 2>&1 || true
}
say() {  # title, body: printed always, shown as a notification on manual runs
  echo "$1. ${2-}"
  if [ "$MANUAL" = 1 ]; then notify "$1" "${2-}"; fi
}

# ---------------------------------------------------------------- one run at a time
exec 9>"$INSTANCE/.run.lock"
if ! flock -n 9; then
  say "Brief is already running" "Wait for it to finish."
  exit 0
fi

DATE="$(date +%F)"
TRIGGER=timer; if [ "$MANUAL" = 1 ]; then TRIGGER=manual; fi

# ---------------------------------------------------------------- should a timer run happen?
if [ "$TRIGGER" = timer ]; then
  if compgen -G "runs/${DATE}_*/sent" >/dev/null; then
    exit 0   # today's brief already went out
  fi
  now_min=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))
  due_min=$(( 10#${DAILY%%:*} * 60 + 10#${DAILY##*:} ))
  if [ "$now_min" -gt $(( due_min + GRACE_MIN )) ] || [ "$now_min" -lt $(( due_min - 5 )) ]; then
    notify "Brief not run automatically" "It is past $DAILY. Run it with your keyboard shortcut when you want it."
    exit 0
  fi
fi

# ---------------------------------------------------------------- preflight (nothing written yet)
set +e
STATUS_OUT="$("$KIT/bin/bp" status 2>&1)"; BP_RC=$?
set -e
case "$BP_RC" in
  0) ;;
  3) say "Brief not run" "This computer is not linked to the planner. Run: bin/bp pair"; exit 0 ;;
  4) say "Brief not run" "The planner does not recognise this computer. Run: bin/bp pair --force"; exit 0 ;;
  5) say "Brief not run" "Claude's suggestions is switched off in the planner."; exit 0 ;;
  *) echo "$STATUS_OUT" >&2; notify "Brief failed" "Could not reach the planner."; exit 1 ;;
esac

command -v claude >/dev/null 2>&1 || { say "Brief failed" "The claude command was not found."; exit 1; }
AUTH="$(claude auth status 2>/dev/null < /dev/null | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin); print("plan" if d.get("loggedIn") and d.get("authMethod") == "claude.ai" else "other")
except Exception:
    print("unknown")' 2>/dev/null || echo unknown)"
if [ "$AUTH" != plan ]; then
  say "Brief not run" "Claude Code is not signed in with a Claude plan. Run: claude auth login"
  exit 1
fi

BROWSER=false
if pgrep -f '(^|/)(chrome|google-chrome|google-chrome-stable|chromium|chromium-browser)( |$)' >/dev/null 2>&1; then BROWSER=true; fi
if [ "$BROWSER" = false ] && [ "$NEED_BROWSER" = true ]; then
  notify "Brief not run" "Chrome is not open. Open it, then run the brief with your keyboard shortcut."
  echo "Chrome is not open; nothing was run."
  exit 0
fi

# ---------------------------------------------------------------- the run directory
STAMP="$(date +%H%M)"
RUN_ID="${DATE}T$(date +%H:%M)"
RUN_DIR="runs/${DATE}_${STAMP}"
mkdir -p "$RUN_DIR/inputs/local" "$RUN_DIR/inputs/previous" memory
LOG="$RUN_DIR/log.txt"
STARTED="$(date -Iseconds)"
N_CAND=0; N_SUGG=0; N_HIGH=0; COVERAGE_FILE=""

log() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" >> "$LOG"; }
record() {  # status
  if [ "$DRY" = 1 ]; then return 0; fi
  local cov=(); if [ -n "$COVERAGE_FILE" ]; then cov=(--coverage-file "$COVERAGE_FILE"); fi
  python3 "$KIT/bin/ledger.py" record-run --run-id "$RUN_ID" --status "$1" --trigger "$TRIGGER" \
    --started "$STARTED" --finished "$(date -Iseconds)" \
    --candidates "$N_CAND" --reported "$N_SUGG" "${cov[@]}" >> "$LOG" 2>&1 || log "could not record the run"
}
fail() { log "failed: $1"; record failed; notify "Brief failed" "$1"; echo "run.sh: $1 (log: $INSTANCE/$LOG)" >&2; exit 1; }

log "run $RUN_ID trigger=$TRIGGER dry=$DRY instance=$INSTANCE kit=$KIT browser=$BROWSER"
printf '%s\n' "$STATUS_OUT" >> "$LOG"
say "Brief started" "Reading your sources. This takes several minutes."

# The reading snippets are copied in so the agents never need a path outside the instance.
rm -rf snippets; mkdir -p snippets; cp "$KIT"/snippets/* snippets/
for f in playbook.md playbook-changelog.md questions.md feedback.md memory/notes.md memory/courses.md; do
  if [ ! -f "$f" ]; then : > "$f"; fi
done

"$KIT/bin/bp" context --out "$RUN_DIR/inputs/context.json" >> "$LOG" 2>&1 || fail "Could not fetch the planner context."
python3 "$KIT/bin/ledger.py" check >> "$LOG" 2>&1 || fail "The memory ledger is damaged (memory/state.json). Nothing was changed."
python3 "$KIT/bin/ledger.py" show --json > "$RUN_DIR/inputs/ledger.json" 2>> "$LOG" || fail "Could not read the memory ledger."
SINCE="$(python3 "$KIT/bin/ledger.py" since 2>> "$LOG")" || fail "Could not compute the look-back time."

# Copies of local files the owner listed, so the agents never read outside the instance.
python3 - "$RUN_DIR/inputs/local" <<'PY' >> "$LOG" 2>&1 || true
import json, os, shutil, sys
dest = sys.argv[1]
for p in json.load(open("config.json")).get("local_inputs", []):
    src = os.path.expanduser(p)
    if os.path.isfile(src) and os.path.getsize(src) < 512_000:
        shutil.copyfile(src, os.path.join(dest, os.path.basename(src)))
        print("copied", src)
    else:
        print("skipped", src)
PY

# The mentor's feedback from earlier runs: the latest for the routine agent, the last three for the mentor.
i=0
while IFS= read -r d; do
  if [ -z "$d" ] || [ "$d" = "$RUN_DIR" ] || [ ! -f "$d/mentor-feedback.md" ]; then continue; fi
  i=$((i+1)); if [ "$i" -gt 3 ]; then break; fi
  cp "$d/mentor-feedback.md" "$RUN_DIR/inputs/previous/${i}-$(basename "$d")-feedback.md"
  if [ -f "$d/mentor.json" ]; then cp "$d/mentor.json" "$RUN_DIR/inputs/previous/${i}-$(basename "$d")-mentor.json"; fi
  if [ "$i" = 1 ]; then cp "$d/mentor-feedback.md" "$RUN_DIR/inputs/mentor-feedback.md"; fi
done < <(ls -1d runs/20*_* 2>/dev/null | sort -r)

python3 - "$RUN_DIR" "$RUN_ID" "$DATE" "$SINCE" "$TRIGGER" "$BROWSER" <<'PY'
import json, os, sys, datetime
run_dir, run_id, date, since, trigger, browser = sys.argv[1:7]
cfg = json.load(open("config.json"))
files = sorted(os.path.relpath(os.path.join(r, f), run_dir)
               for r, _, fs in os.walk(os.path.join(run_dir, "inputs")) for f in fs)
json.dump({
    "runId": run_id, "date": date, "since": since, "trigger": trigger,
    "now": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "timezone": cfg.get("timezone"), "browserAvailable": browser == "true",
    "runDir": run_dir, "inputFiles": files + ["inputs/preflight.json"],
}, open(f"{run_dir}/inputs/preflight.json", "w"), indent=2)
PY

run_block() {
  cat <<EOF


## RUN

- RUN_DIR: \`$RUN_DIR\`
- Date: $DATE, run id \`$RUN_ID\`, trigger: $TRIGGER
- Look back to: $SINCE
- Browser available: $BROWSER
- Inputs are in \`$RUN_DIR/inputs/\`; \`preflight.json\` there lists every input file.
EOF
}

# ---------------------------------------------------------------- tool permissions
# Three layers. `--tools` leaves the agents six built-in tools: no shell, no sub-agents, no web
# fetch. `--permission-mode dontAsk` refuses every tool call that is not on the allow list, and
# every file outside the instance. The deny list holds even if an allow rule is ever loosened.
# `--setting-sources project` keeps the owner's global Claude settings from widening any of it.
BUILTIN=(Read Write Edit Glob Grep ToolSearch)
READ_TOOLS=(
  ToolSearch
  mcp__claude_ai_Gmail__search_threads mcp__claude_ai_Gmail__get_thread
  mcp__claude-in-chrome__tabs_context_mcp mcp__claude-in-chrome__tabs_create_mcp
  mcp__claude-in-chrome__tabs_close_mcp mcp__claude-in-chrome__navigate
  mcp__claude-in-chrome__get_page_text mcp__claude-in-chrome__read_page
  mcp__claude-in-chrome__find mcp__claude-in-chrome__javascript_tool
)
NEVER=(
  Bash Agent Task WebFetch WebSearch NotebookEdit
  "Read(secrets/**)" "Edit(secrets/**)" "Edit(bin/**)" "Edit(snippets/**)" "Edit(.claude/**)"
  "Edit(config.json)" "Edit(sources.md)" "Edit(CLAUDE.md)" "Edit(memory/state.json)"
  mcp__claude_ai_Gmail__send_message mcp__claude_ai_Gmail__reply mcp__claude_ai_Gmail__forward
  mcp__claude_ai_Gmail__create_draft mcp__claude_ai_Gmail__update_draft mcp__claude_ai_Gmail__delete_draft
  mcp__claude_ai_Gmail__trash_message mcp__claude_ai_Gmail__trash_thread
  mcp__claude_ai_Gmail__untrash_message mcp__claude_ai_Gmail__untrash_thread
  mcp__claude_ai_Gmail__label_message mcp__claude_ai_Gmail__label_thread
  mcp__claude_ai_Gmail__unlabel_message mcp__claude_ai_Gmail__unlabel_thread
  mcp__claude_ai_Gmail__update_message_labels mcp__claude_ai_Gmail__create_label
  mcp__claude_ai_Gmail__update_label mcp__claude_ai_Gmail__delete_label
  mcp__claude_ai_Gmail__mark_message_spam mcp__claude_ai_Gmail__mark_thread_spam
  mcp__claude_ai_Gmail__unmark_message_spam mcp__claude_ai_Gmail__unmark_thread_spam
  mcp__claude_ai_Gmail__apply_sensitive_message_label mcp__claude_ai_Gmail__apply_sensitive_thread_label
  mcp__claude_ai_Google_Calendar__create_event mcp__claude_ai_Google_Calendar__update_event
  mcp__claude_ai_Google_Calendar__delete_event mcp__claude_ai_Google_Calendar__respond_to_event
  mcp__claude-in-chrome__computer mcp__claude-in-chrome__form_input
  mcp__claude-in-chrome__file_upload mcp__claude-in-chrome__upload_image
  mcp__claude-in-chrome__gif_creator mcp__claude-in-chrome__shortcuts_execute
  mcp__claude-in-chrome__shortcuts_list mcp__claude-in-chrome__resize_window
  mcp__claude-in-chrome__switch_browser mcp__claude-in-chrome__select_browser
)
mapfile -t EXTRA_ALLOW < <(cfg_list extra_allowed_tools)
mapfile -t EXTRA_DENY < <(cfg_list extra_disallowed_tools)

ROUTINE_ALLOW=("${READ_TOOLS[@]}" "${EXTRA_ALLOW[@]}" "Edit($RUN_DIR/**)")
ROUTINE_DENY=("${NEVER[@]}" "${EXTRA_DENY[@]}" "Edit(playbook.md)" "Edit(playbook-changelog.md)"
  "Edit(questions.md)" "Edit(feedback.md)" "Edit(memory/**)")
MENTOR_ALLOW=("${READ_TOOLS[@]}" "${EXTRA_ALLOW[@]}" "Edit($RUN_DIR/**)" "Edit(playbook.md)"
  "Edit(playbook-changelog.md)" "Edit(questions.md)" "Edit(feedback.md)" "Edit(memory/notes.md)"
  "Edit(memory/courses.md)")
MENTOR_DENY=("${NEVER[@]}" "${EXTRA_DENY[@]}")
REPAIR_ALLOW=("Edit($RUN_DIR/**)")

BREACHES=0
agent() {  # name, model, minutes, prompt-file, allow-array-name, deny-array-name, browser
  local name="$1" model="$2" minutes="$3" prompt_file="$4" browser="$7"
  local -n allow_ref="$5" deny_ref="$6"
  local extra=()
  if [ "$browser" = true ]; then extra+=(--chrome); fi
  log "agent $name: model=$model limit=${minutes}m browser=$browser"
  local rc=0 stream="$RUN_DIR/stream-$name.jsonl"
  timeout --signal=TERM --kill-after=30 "${minutes}m" \
    claude -p "$(cat "$prompt_file"; run_block)" \
      --model "$model" "${extra[@]}" --setting-sources project --no-session-persistence \
      --tools "${BUILTIN[@]}" --permission-mode dontAsk --output-format stream-json --verbose \
      --allowedTools "${allow_ref[@]}" --disallowedTools "${deny_ref[@]}" \
      < /dev/null > "$stream" 2>> "$LOG" || rc=$?
  # Every tool call the agent made, checked against the reading rules (see bin/audit.py).
  local arc=0
  python3 "$KIT/bin/audit.py" --stream "$stream" --role "$name" --run "$RUN_DIR" >> "$LOG" 2>&1 || arc=$?
  if [ "$arc" = 1 ]; then BREACHES=$((BREACHES + 1)); log "agent $name: the audit found a breach"; fi
  if [ "$arc" -gt 1 ]; then log "agent $name: the audit could not run (exit $arc)"; fi
  if [ "$KEEP_TRANSCRIPTS" != true ]; then rm -f "$stream"; fi
  python3 - "$RUN_DIR/agent-$name.json" "$name" >> "$LOG" 2>&1 <<'PY' || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    denied = sorted({x.get("tool_name", "?") for x in d.get("permission_denials", [])})
    print(f"agent {sys.argv[2]}: turns={d.get('num_turns')} error={d.get('is_error')} "
          f"minutes={round((d.get('duration_ms') or 0) / 60000, 1)} denied={denied}")
    print("agent said:", (d.get("result") or "")[:600].replace("\n", " | "))
except Exception as e:
    print(f"agent {sys.argv[2]}: no readable result ({e})")
PY
  return "$rc"
}

# ---------------------------------------------------------------- routine agent
agent routine "$ROUTINE_MODEL" "$ROUTINE_MINUTES" "$KIT/prompts/routine.md" ROUTINE_ALLOW ROUTINE_DENY "$BROWSER" \
  || log "routine agent exited non-zero"
[ -s "$RUN_DIR/candidates.json" ] || fail "The routine agent produced no candidates file."
[ -s "$RUN_DIR/report.json" ] || fail "The routine agent produced no report."

if ! "$KIT/bin/bp" report "$RUN_DIR/report.json" --check > "$RUN_DIR/check-routine.txt" 2>&1; then
  log "report.json failed validation; one repair attempt"
  {
    echo "The file \`$RUN_DIR/report.json\` failed the planner's validation. Fix only what the errors"
    echo "below name, keep everything else as it is, and change no other file."
    echo; echo '```'; cat "$RUN_DIR/check-routine.txt"; echo '```'
  } > "$RUN_DIR/repair-prompt.md"
  agent repair "$ROUTINE_MODEL" 5 "$RUN_DIR/repair-prompt.md" REPAIR_ALLOW ROUTINE_DENY false || true
  "$KIT/bin/bp" report "$RUN_DIR/report.json" --check >> "$LOG" 2>&1 \
    || fail "The routine's report is not valid (see $RUN_DIR/check-routine.txt)."
fi

# ---------------------------------------------------------------- mentor agent
FINAL="$RUN_DIR/report.json"
MENTOR_STATE=skipped
if [ "$MENTOR" = 1 ]; then
  agent mentor "$MENTOR_MODEL" "$MENTOR_MINUTES" "$KIT/prompts/mentor.md" MENTOR_ALLOW MENTOR_DENY "$BROWSER" \
    || log "mentor agent exited non-zero"
  if [ -s "$RUN_DIR/report.final.json" ] && "$KIT/bin/bp" report "$RUN_DIR/report.final.json" --check >> "$LOG" 2>&1; then
    FINAL="$RUN_DIR/report.final.json"; MENTOR_STATE=done
  else
    log "mentor produced no valid final report; using the routine's report, marked as not double-checked"
  fi
fi
# The report that goes out: the mentor's if it produced a valid one, else the routine's marked as
# not double-checked; with a note when the audit found that a reading rule was broken.
python3 - "$RUN_DIR" "$FINAL" "$MENTOR_STATE" <<'PY'
import datetime, glob, json, sys
run_dir, final, mentor_state = sys.argv[1:4]
r = json.load(open(final))
brief = r.setdefault("brief", {})
# The time on the brief is the runner's clock, not an agent's estimate.
brief["generatedAt"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
if mentor_state == "skipped":
    brief["mentor"] = {"status": "skipped", "corrections": 0,
        "notes": ["The second check did not run today, so this list was not double-checked."]}
found = []
for path in sorted(glob.glob(f"{run_dir}/audit-*.json")):
    try:
        found += [f["detail"] for f in json.load(open(path)).get("findings", []) if f.get("severity") == "breach"]
    except Exception:
        pass
if found:
    m = brief.get("mentor") or {"status": "skipped", "corrections": 0, "notes": []}
    more = f", and {len(found) - 1} more" if len(found) > 1 else ""
    note = f"Audit: during this run {found[0]}{more}. That breaks a reading rule. Details are in the run folder on your computer."
    m["notes"] = [note[:400]] + list(m.get("notes") or [])[:4]
    brief["mentor"] = m
json.dump(r, open(f"{run_dir}/report.send.json", "w"), indent=2, ensure_ascii=False)
PY
FINAL="$RUN_DIR/report.send.json"
"$KIT/bin/bp" report "$FINAL" --check >> "$LOG" 2>&1 || fail "The final report is not valid."

read -r N_CAND N_SUGG N_HIGH < <(python3 - "$RUN_DIR/candidates.json" "$FINAL" <<'PY'
import json, sys
try:
    c = json.load(open(sys.argv[1])); r = json.load(open(sys.argv[2]))
    cands = c.get("candidates", []) if isinstance(c, dict) else c
    s = r.get("suggestions", [])
    print(len(cands), len(s), sum(1 for x in s if x.get("priority") == "high"))
except Exception:
    print(0, 0, 0)
PY
)
if python3 -c 'import json,sys; json.dump(json.load(open(sys.argv[1])).get("brief", {}), open(sys.argv[2], "w"))' \
  "$FINAL" "$RUN_DIR/brief.final.json" 2>> "$LOG"; then COVERAGE_FILE="$RUN_DIR/brief.final.json"; fi

# ---------------------------------------------------------------- send, remember, tidy
if [ "$DRY" = 1 ]; then
  log "dry run: report not sent, memory not updated ($FINAL)"
else
  if ! "$KIT/bin/bp" report "$FINAL" > "$RUN_DIR/sent.txt" 2>&1; then
    cat "$RUN_DIR/sent.txt" >> "$LOG"; fail "The planner did not accept the report."
  fi
  cat "$RUN_DIR/sent.txt" >> "$LOG"; date -Iseconds > "$RUN_DIR/sent"
  python3 "$KIT/bin/ledger.py" merge --run "$RUN_DIR" --date "$DATE" >> "$LOG" 2>&1 || log "ledger merge failed"
  python3 "$KIT/bin/ledger.py" prune >> "$LOG" 2>&1 || log "ledger prune failed"
fi
find runs -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$KEEP_DAYS" -exec rm -rf {} + 2>> "$LOG" || true

STATUS=ok; if [ "$MENTOR_STATE" = skipped ] && [ "$MENTOR" = 1 ]; then STATUS=partial; fi
log "finished: $STATUS. $N_SUGG suggestions ($N_HIGH high), $N_CAND candidates, mentor $MENTOR_STATE, audit breaches=$BREACHES, dry=$DRY"
record "$STATUS"
CHECKED=""; if [ "$MENTOR_STATE" = skipped ]; then CHECKED=" Not double-checked today."; fi
if [ "$BREACHES" -gt 0 ]; then CHECKED="$CHECKED The audit flagged a broken reading rule; see the brief."; fi
if [ "$DRY" = 1 ]; then
  notify "Brief ready (dry run)" "$N_SUGG suggestions, $N_HIGH high priority. Nothing was sent.$CHECKED"
else
  notify "Brief ready" "$N_SUGG suggestions, $N_HIGH high priority.$CHECKED Open Day Planner to see them."
fi
echo "$RUN_DIR: $N_SUGG suggestions ($N_HIGH high) from $N_CAND candidates, mentor $MENTOR_STATE"
