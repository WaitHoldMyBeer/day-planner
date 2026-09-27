# Claude's suggestions: the routine

A daily routine that runs on your own computer, under your own Claude plan. It reads the places
where tasks reach you, works out what needs your attention, and puts what is not yet on your to-do
list into the planner's **Claude's suggestions** tab, with a brief sorted into high, medium and low.

The planner's server never talks to Claude and holds no Claude credentials. Each person who wants
this feature runs the routine themselves, signed in to their own plan.

```
08:00 timer or your shortcut
        │
   bin/run.sh ── preflight: linked? feature on? signed in with a plan? Chrome open?
        │
        ├─ routine agent (Opus)     reads the sources, writes candidates.json + report.json
        ├─ mentor agent (Fable)     re-checks the sources, corrects the report, updates the playbook
        ├─ bin/bp report            sends the corrected report to the planner
        └─ bin/ledger.py            records what was seen, so tomorrow does not repeat it
```

## What you need

- Linux with `python3` (3.10 or later), `flock`, `timeout`; `systemd` for the timer and
  `notify-send` for notifications.
- [Claude Code](https://claude.com/claude-code) signed in with a Claude plan (`claude auth login`).
  The runner refuses to start on an API key or another provider.
- Chrome with the Claude extension, for every source that is a website. Gmail through the Claude
  connector needs no browser.
- An account on the planner, with **Claude's suggestions** switched on: account menu →
  **Beta features**.

## Set up

```bash
routine/install.sh ~/planner-routine            # creates the instance, never overwrites
~/planner-routine/bin/bp pair                   # prints a code; approve it in the planner
$EDITOR ~/planner-routine/sources.md            # what to read, how, and what never to read
~/planner-routine/bin/run.sh --dry-run          # a full run that sends nothing
routine/install.sh ~/planner-routine --enable --shortcut '<Control><Alt>b'
```

The instance directory holds your private state and lives outside this repository. Its key file
(`secrets/routine.key`) links one computer to one planner account; the planner stores only a hash
of it, and **Linked computers** in the planner's account menu can unlink it at any time.

## When it runs

| Trigger | Behaviour |
|---|---|
| Timer, at `daily_time` | Runs once. Does nothing if today's brief already went out, if Chrome is closed, or if it starts more than `timer_grace_minutes` late (a computer woken at noon runs nothing; you get a notification instead). |
| Shortcut, or `bin/run.sh --manual` | Runs whenever you ask, as often as you ask. |
| `--dry-run` | Reads everything, sends nothing, leaves the ledger untouched. The mentor may still record lessons. |
| `--skip-mentor` | The brief is marked as not double-checked. |

Switching the feature off in the planner stops the routine at its next start: the server answers
`disabled` and nothing is read.

## What the agents may do

The two agents run headless with three layers of restriction, set in `bin/run.sh`:

1. **Tools.** Six built-in tools: read, write and edit files, find files, search files, look up
   tools. No shell, no sub-agents, no web fetch.
2. **Deny by default.** Every tool call not on the allow list is refused without asking. The allow
   list is: search and read Gmail; open, navigate, read and close their own browser tab; run a
   script in that tab; write inside this run's directory. The mentor may also write the playbook,
   its changelog, the notes and the questions. Files outside the instance cannot be read.
3. **Deny list.** Sending, drafting, labelling and deleting mail, calendar changes, clicking and
   typing in the browser, uploads, and edits to the prompts, snippets, sources, config, key and
   ledger are refused even if an allow rule is loosened by mistake. Add your own connectors'
   servers to `extra_disallowed_tools` in `config.json`.

Your global Claude Code settings are not loaded, so nothing there can widen this.

What the layers do **not** cover: where a tab is pointed, and what a page script does. The
script tool can do anything a page script can. The prompts limit it to reading and the snippets in
`snippets/` are the fixed readers the agents are told to use, but that is an instruction, not a
lock. So every run is audited afterwards.

### The audit

`bin/audit.py` reads the record of every tool call an agent made and checks it against the reading
rules, without any model involved:

| Checked | A breach when |
|---|---|
| Sign-in | the run was billed to an API key instead of the Claude plan |
| Tools | a tool outside the reading set was used |
| Pages | a tab went to a host not in `allowed_hosts`, to an address matching `forbidden_urls`, to a plain `http` address, or to a page that marks something read (a Gmail conversation, a Canvas announcement page, a Piazza post) |
| Scripts | a script that is not one of the snippets clicks, types, submits, makes a network request, touches cookies or storage, changes the page, navigates, or runs further code |

A breach is written to `runs/<run>/audit-<agent>.json`, shown in your notification, and put at the
top of the brief in the planner. The report is still sent: a broken reading rule does not make the
suggestions wrong, but you should know. `actions-<agent>.jsonl` lists the tool calls themselves
(what was asked, never what came back), so you can see exactly what happened.

The audit detects; it does not prevent. A script written to hide what it does could pass it. If
that is not enough for a source, leave the source disabled.

Set `allowed_hosts` in `config.json` to the hosts of your enabled sources, and put the addresses
of accounts that must never be opened in `forbidden_urls` (regular expressions).

Everything the agents read is treated as material to analyse. Text in a message or page that
addresses the agent is recorded under `injectionNotes` in the run's `candidates.json` and not
followed.

## Reading without leaving marks

| Source | How it is read | State left behind |
|---|---|---|
| Gmail, connected account | Claude's Gmail connector | none |
| Gmail, other accounts | list page, then `gmail-read.js` (print view, fetched as text) | none; conversations stay unread |
| Canvas | the site's own data pages | none; announcements and inbox stay unread |
| Gradescope | course and assignment pages | none |
| Piazza | the feed only; posts are never opened | none |
| Discord | overview, unread direct messages, watched servers | none while the tab stays in the background |

Checked against the live sites on 2026-09-26. Sites change their markup; when a reader returns
little, the brief's coverage says `partial` for that source rather than pretending.

**Discord.** Its terms do not allow automating a personal account. The routine only reads pages in
your own signed-in browser, a few per day, but the risk is yours to weigh. It is off in the
template.

## What leaves your computer

| Goes to | What |
|---|---|
| Claude, under your plan | whatever the agents read while working: the lists and the few items they open |
| The planner's database | the suggestions and the brief: titles, one-sentence reasons, due dates, links, source labels |
| Nowhere else | `candidates.json`, the ledger, the playbook, the notes and the logs stay in the instance directory |

The agents are told to keep figures, terms and other people's personal details out of what they
report, and to leave out health, legal and financial notices that ask nothing of you. What they
write to the planner is visible to anyone who can sign in to your planner account.

## Memory

| File | Holds | Kept small by |
|---|---|---|
| `memory/state.json` | every item seen: first and last seen, decision, status in the planner | `ledger.py prune`: 60 days unseen, 30 days past due, 2000 items |
| `memory/notes.md` | standing facts about your situation | the mentor: 60 lines, rewritten, dated |
| `playbook.md` | lessons | the mentor: 25 active, 15 candidate, retired after 30 idle days |
| `questions.md` | what the routine needs you to answer | the mentor: 8 open |
| `runs/` | each run's inputs, outputs, log, audit | the runner: `keep_run_days`. The raw record of what the agents read (`stream-*.jsonl`) is deleted at the end of each run unless `keep_transcripts` is true. |

An item you accepted or dismissed is not suggested again unless it changes materially (a new due
date, a new request in the thread); then it returns marked as resurfaced, saying what changed.

A suggestion you have not touched is withdrawn by the routine when a source shows it is moot:
submitted, cancelled, or past with nothing left to do. It moves to **Handled** marked
**Withdrawn**, with the reason, and **Undo** brings it back. The routine never withdraws something
only because it did not see it that day. Withdrawals are kept apart from your own dismissals, so
the mentor never mistakes the routine's housekeeping for your judgement.

## How the mentor improves the routine without overfitting

The mentor re-reads the sources with a smaller budget, corrects today's report before you see it,
and writes feedback the routine reads tomorrow. Lasting changes go through the playbook only:

- A new lesson is a `candidate`, and the routine ignores candidates.
- It becomes `active` only with evidence from two different days, or from your own accepts and
  dismissals, or because you said so.
- Lessons describe categories, never single messages or people.
- Changing an active lesson takes two contradicting days.
- Your choices in the planner outrank the mentor's opinion.
- Lessons that stop helping are retired. No lesson may weaken a safety rule or widen what is read.

Every change is one line in `playbook-changelog.md`. You can edit or delete any lesson.

## Tuning it

| You want | Change |
|---|---|
| A new source | add an entry to `sources.md`; if it needs a connector tool, add the tool to `extra_allowed_tools` |
| A source gone | `enabled: no`, or move it under "Excluded" |
| Something always or never suggested | write it under "Rules that apply to every source" in `sources.md` |
| A different time | `daily_time` in `config.json`, then run `install.sh` again |
| To see why something was missed | `runs/<date>_<time>/candidates.json` lists everything considered, with reasons; `mentor.json` lists what the mentor found |

## Files

```
routine/
  SPEC.md                 the contract between the routine and the planner
  install.sh              sets up an instance, the timer, the shortcut
  bin/bp                  talks to the planner: pair, status, context, report
  bin/run.sh              one run, start to finish
  bin/ledger.py           the ledger; the only writer of memory/state.json
  bin/audit.py            checks every tool call of a run against the reading rules
  prompts/routine.md      the routine agent
  prompts/mentor.md       the mentor agent
  snippets/               read-only page readers
  templates/              what a new instance starts with
  systemd/                timer and service
  tests/                  python3 -m unittest discover -s routine/tests
```

## Costs

A run uses your plan's allowance, not money: two long agent sessions a day. If that crowds out
your other use, run the routine on a smaller model (`routine_model` in `config.json`), drop the
mentor to a few days a week with `--skip-mentor`, or trim sources.

## Troubleshooting

| Notification | Meaning |
|---|---|
| "This computer is not linked" | run `bin/bp pair` |
| "Claude's suggestions is switched off" | switch it on: account menu → Beta features |
| "Chrome is not open" | open Chrome, then use the shortcut |
| "not signed in with a Claude plan" | `claude auth login` |
| "Brief failed" | read `runs/<latest>/log.txt` |
| A source says `skipped` every day | its sign-in expired, or the Gmail account slots moved; open the site yourself, then fix the slot in `sources.md` |
