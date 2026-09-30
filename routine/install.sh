#!/usr/bin/env bash
# Set up an instance of the routine for one person on this computer.
#
#   routine/install.sh <instance directory> [--enable] [--shortcut '<Control><Alt>b']
#
#   --enable      install and start the daily timer (systemd user timer)
#   --shortcut    add a GNOME keyboard shortcut that runs the brief by hand
#
# Safe to run again: existing files in the instance are never overwritten.
set -euo pipefail

KIT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
INSTANCE=""; ENABLE=0; SHORTCUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --enable) ENABLE=1 ;;
    --shortcut) SHORTCUT="${2:?--shortcut needs a key, for example '<Control><Alt>b'}"; shift ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "install.sh: unknown option $1" >&2; exit 2 ;;
    *) INSTANCE="$1" ;;
  esac
  shift
done
[ -n "$INSTANCE" ] || { echo "install.sh: name the instance directory" >&2; exit 2; }
mkdir -p "$INSTANCE"; INSTANCE="$(cd "$INSTANCE" && pwd)"
case "$INSTANCE/" in "$KIT"/*) echo "install.sh: keep the instance outside the repository; it holds private data" >&2; exit 2 ;; esac

# ---- files
mkdir -p "$INSTANCE/memory" "$INSTANCE/runs" "$INSTANCE/secrets"
chmod 700 "$INSTANCE/secrets"
( cd "$KIT/templates" && find . -type f -print ) | while IFS= read -r f; do
  f="${f#./}"
  if [ -e "$INSTANCE/$f" ]; then echo "kept     $f"; else
    mkdir -p "$(dirname "$INSTANCE/$f")"; cp "$KIT/templates/$f" "$INSTANCE/$f"; echo "created  $f"
  fi
done
ln -sfn "$KIT/bin" "$INSTANCE/bin"
chmod +x "$KIT/bin/bp" "$KIT/bin/run.sh" "$KIT/bin/ledger.py"

# ---- checks, reported and not enforced
for c in python3 flock timeout claude; do
  command -v "$c" >/dev/null 2>&1 || PATH="$HOME/.local/bin:$PATH" command -v "$c" >/dev/null 2>&1 || echo "missing  $c (needed)"
done
command -v notify-send >/dev/null 2>&1 || echo "missing  notify-send (optional: desktop notifications)"

TIME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("daily_time","08:00"))' "$INSTANCE/config.json")"
case "$TIME" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "install.sh: daily_time in config.json must look like 08:00" >&2; exit 2 ;; esac

# ---- timer
if command -v systemctl >/dev/null 2>&1; then
  UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNITS"
  for u in blairplanner-routine.service blairplanner-routine.timer; do
    sed -e "s|@INSTANCE@|$INSTANCE|g" -e "s|@KIT@|$KIT|g" -e "s|@TIME@|$TIME|g" "$KIT/systemd/$u" > "$UNITS/$u"
  done
  systemctl --user daemon-reload
  # A timer that is already running keeps its old time until it is restarted.
  systemctl --user try-restart blairplanner-routine.timer 2>/dev/null || true
  if [ "$ENABLE" = 1 ]; then
    systemctl --user enable --now blairplanner-routine.timer
    echo "timer    on, daily at $TIME"
  else
    echo "timer    installed, not started (run again with --enable)"
  fi
else
  echo "timer    skipped: no systemd here. Schedule $INSTANCE/bin/run.sh yourself."
fi

# ---- keyboard shortcut (GNOME)
if [ -n "$SHORTCUT" ]; then
  if command -v gsettings >/dev/null 2>&1; then
    python3 - "$SHORTCUT" "$INSTANCE/bin/run.sh --manual" <<'PY'
import ast, subprocess, sys
key, command = sys.argv[1], sys.argv[2]
NAME = "Day Planner brief (run Claude routine)"
LIST = "org.gnome.settings-daemon.plugins.media-keys"
ITEM = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"
BASE = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/"
def get(*a): return subprocess.run(["gsettings", "get", *a], capture_output=True, text=True, check=True).stdout.strip()
def put(*a): subprocess.run(["gsettings", "set", *a], check=True)
raw = get(LIST, "custom-keybindings")
paths = [] if raw.startswith("@as") else list(ast.literal_eval(raw))
mine = None
for p in paths:
    if ast.literal_eval(get(f"{ITEM}:{p}", "name")) == NAME:
        mine = p
    elif ast.literal_eval(get(f"{ITEM}:{p}", "binding")).lower() == key.lower():
        sys.exit(f"shortcut {key} is already used by: {get(f'{ITEM}:{p}', 'name')}")
if mine is None:
    n = 0
    while f"{BASE}custom{n}/" in paths: n += 1
    mine = f"{BASE}custom{n}/"
    paths.append(mine)
put(f"{ITEM}:{mine}", "name", NAME)
put(f"{ITEM}:{mine}", "command", command)
put(f"{ITEM}:{mine}", "binding", key)
put(LIST, "custom-keybindings", str(paths))
print(f"shortcut {key} runs the brief")
PY
  else
    echo "shortcut skipped: no gsettings here. Bind a key to: $INSTANCE/bin/run.sh --manual"
  fi
fi

cat <<EOF2

Instance: $INSTANCE
Next:
  1. In the planner, open the account menu, Beta features, and switch on Claude's suggestions.
  2. $INSTANCE/bin/bp pair          link this computer to your planner account
  3. edit $INSTANCE/sources.md      say what to read, and what never to read
  4. $INSTANCE/bin/run.sh --dry-run try it without sending anything
EOF2
