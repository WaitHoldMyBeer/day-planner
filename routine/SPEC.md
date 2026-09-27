# Claude's suggestions (beta) — specification

Shared contract between the planner app (server + front end) and the routine that runs on
the user's own computer under the user's own Claude plan. The planner server never calls
Claude and holds no Anthropic credential.

```
user's computer                                        blairplanner (Vercel + Postgres)
┌───────────────────────────────────────────┐          ┌──────────────────────────────┐
│ systemd timer → bin/run.sh                │          │ /api/routine/context  (key)  │
│   routine agent  (claude -p, user's plan) │ ─ bp ──▶ │ /api/routine/report   (key)  │
│   mentor agent   (claude -p, user's plan) │          │ /api/routine/pair … (session)│
│ reads: mail, Canvas, Gradescope, Piazza…  │          │ tables: routine_keys,        │
│ memory: state.json, playbook.md           │          │   suggestions, briefs        │
└───────────────────────────────────────────┘          └──────────────────────────────┘
```

## 1. Settings flag

`settings.data.beta.suggestions` (boolean, default false). The client always PUTs the whole
settings object (`{colors, beta, rev}`), so neither field is lost. When the flag is false the
UI hides everything below and `report`/`context` answer `409 {code:"disabled"}`.

## 2. Tables (created in `lib/db.js` SCHEMA, idempotent)

```sql
routine_keys(id BIGSERIAL PK, user_id BIGINT FK users ON DELETE CASCADE, key_hash TEXT UNIQUE NOT NULL,
             name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), last_used_at TIMESTAMPTZ)
suggestions(user_id BIGINT FK, fingerprint TEXT, data JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'new',
            rev TEXT NOT NULL, first_seen TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
            PRIMARY KEY (user_id, fingerprint))
briefs(user_id BIGINT FK, date TEXT, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(),
       PRIMARY KEY (user_id, date))
```

`status` is one of `new | accepted | dismissed`.

## 3. Data shapes

### Suggestion (as sent by the routine)

```json
{
  "fingerprint": "canvas:assignment:12345:991234",
  "title": "MATH 170A HW 1",
  "priority": "high",
  "why": "Due Tue 29 Sep 23:59, not submitted.",
  "source": { "kind": "canvas", "account": null, "label": "Canvas · MATH 170A",
              "url": "https://canvas.example.edu/courses/12345/assignments/991234", "ref": "991234" },
  "due": "2026-09-29T23:59:00-07:00",
  "duration": 90,
  "tag": "math170a",
  "duplicateOf": { "todoId": "tabc123", "title": "Math 170A homework", "confidence": "possible" },
  "addedBy": "routine",
  "resurface": false
}
```

- `fingerprint`: stable identity of the underlying thing, `^[a-z0-9][a-z0-9:._@-]{2,159}$`.
  Built from source ids, never from the title: `mail:<account>:<threadId>`,
  `canvas:<type>:<courseId>:<id>`, `gradescope:<courseId>:<assignmentId>`,
  `piazza:<classId>:<postNumber>`, `ucsd:deadline:<date>:<slug>`, `calendar:<eventId>`.
- `priority`: `high | medium | low`.
- `why`: one sentence, at most 240 characters. Plain text.
- `source.kind`: `mail | canvas | gradescope | piazza | calendar | ucsd | clickup | other`.
  `source.label` is what the UI shows. `url` must be `https://` or null.
- `due`: ISO 8601 with offset, or null. `duration`: minutes 5..1440 or null. `tag`: `[a-z0-9-]{1,40}` or null.
- `duplicateOf`: null, or the existing to-do it resembles. `confidence`: `high | possible`.
  The routine never drops a possible duplicate silently; it reports it flagged.
- `addedBy`: `routine | mentor`.
- `resurface`: true only when an item the user already handled changed materially
  (new due date, new request in the thread). The server then returns it to `new`.

Server-side additions when returned to clients: `status`, `firstSeen`, `updatedAt`, `rev`,
`todoId` (set on accept), `dismissedReason`, `resurfacedAt`, `withdrawn`.

`withdrawn` is `{ "reason": "Submitted on Gradescope on 28 Sep.", "at": "<ISO time>" }` when the
routine withdrew the item (§4), else null. It is server-owned like the others: a `withdrawn`
sent inside a suggestion is dropped, and every user transition (accept, dismiss, restore)
clears it, so a dismissal by the user is never marked withdrawn.

### Brief

```json
{
  "date": "2026-09-27", "runId": "2026-09-27T07:06", "generatedAt": "2026-09-27T07:19:44-07:00",
  "summary": "Two things are due in the next 48 hours …",
  "high":   [ { "title": "…", "why": "…", "due": "…", "source": { "label": "…", "url": "…" }, "fingerprint": "…" } ],
  "medium": [ ],
  "low":    [ ],
  "coverage": [ { "source": "School mail", "status": "ok", "detail": "38 threads since last run" },
                { "source": "Gradescope", "status": "skipped", "detail": "Not signed in in Chrome" } ],
  "mentor": { "status": "corrected", "corrections": 2, "notes": [ "Raised PHYS 2DL prelab to high: due before lab." ] },
  "questions": [ "another@example.com is signed in in Chrome. Should it be scanned?" ]
}
```

`coverage[].status`: `ok | partial | skipped | error`. `mentor.status`: `ok | corrected | skipped`.
A brief lists everything that matters today, including items that already exist as to-dos;
the suggestions list holds only what is not already on the to-do list (plus flagged duplicates).

## 4. Endpoints — all under one function `api/routine/[action].js`

Every non-GET request carries `X-Requested-With: fetch` (the CLI sends it too).

### Session-authenticated (the app, cookie)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/routine/pair` | `{hash, name}` hash = sha256 hex of the local key, `^[a-f0-9]{64}$` | `{key:{id,name,createdAt}}`; turns the beta flag on; at most 5 keys per user |
| POST | `/api/routine/unpair` | `{id}` | `{ok:true}` |
| POST | `/api/routine/accept` | `{fingerprint, todoId}` | suggestion → `accepted`, stores `todoId` |
| POST | `/api/routine/dismiss` | `{fingerprint, reason?}` reason ≤ 120 chars | suggestion → `dismissed` |
| POST | `/api/routine/restore` | `{fingerprint}` | suggestion → `new` |

`GET /api/sync` gains a `routine` member:

```json
{ "enabled": true,
  "keys": [ { "id": "3", "name": "kenan-desktop", "createdAt": "…", "lastUsedAt": "…" } ],
  "suggestions": [ /* every status=new item, plus items handled in the last 7 days */ ],
  "brief": { /* latest brief or null */ } }
```

When the flag is off: `{ "enabled": false, "keys": [...] }`.

### Key-authenticated (the routine, `Authorization: Bearer <key>`)

The server hashes the bearer key with sha256 and looks it up in `routine_keys`; it updates
`last_used_at`. No cookie is involved. Unknown key → `401`. Flag off → `409 {code:"disabled"}`.

| Method | Path | Result |
|---|---|---|
| GET | `/api/routine/context` | see below |
| POST | `/api/routine/report` | `{created, updated, unchanged, resurfaced, keptHandled, withdrawn}` |

`context` response:

```json
{ "enabled": true, "user": { "name": "Sam" }, "serverTime": "…",
  "todos": [ { "id": "t1", "title": "…", "tag": "event", "duration": 45, "done": false,
               "scheduled": [ { "date": "2026-09-27", "blockId": "b1" } ] } ],
  "suggestions": [ { "fingerprint": "…", "title": "…", "status": "dismissed", "priority": "low",
                     "source": { "kind": "mail", "label": "…" }, "due": null,
                     "dismissedReason": "not mine", "withdrawn": null, "updatedAt": "…" } ],
  "feedback": { "accepted30d": 12, "dismissed30d": 5, "withdrawn30d": 3 },
  "lastBrief": { "date": "2026-09-26", "runId": "…" } }
```

`suggestions` in `context` covers the last 60 days in every status, so the routine knows what
the user accepted and dismissed. That history is the ground truth the mentor learns from.
A history item's `withdrawn` is the routine's reason string when the routine withdrew it, else
null; such an item has status `dismissed` but is not the user's judgement. `dismissed30d`
counts only dismissals by the user; `withdrawn30d` counts the withdrawn ones it leaves out.

`report` body: `{ runId, date, brief, suggestions: [ … ], withdraw: [ … ] }` with at most 60
suggestions.
Upsert rule per fingerprint:

| Existing row | Incoming | Effect |
|---|---|---|
| none | any | insert as `new` → counted `created` |
| `new` | same content | nothing → `unchanged` |
| `new` | changed content | replace `data` → `updated` |
| `accepted` / `dismissed` | `resurface: true` | status → `new`, `resurfacedAt` set → `resurfaced` |
| `accepted` / `dismissed` | otherwise | row untouched → `keptHandled` |

A resurfaced row takes the new content only, so it loses `withdrawn` along with the other
server fields except `resurfacedAt`.

`withdraw` (optional; absent or null means none) takes items that became moot off the user's
list: the homework was submitted, the event was cancelled, the date passed.

```json
"withdraw": [ { "fingerprint": "canvas:assignment:12345:991234", "reason": "Submitted on Gradescope on 28 Sep." } ]
```

- At most 60 entries. `reason` is required, plain text, at most 160 characters (longer is cut).
- A fingerprint may appear once in `withdraw`, and not in both `suggestions` and `withdraw` of
  the same report; either is a `400` and nothing from the report is stored.
- Applied after the suggestions, in the same transaction. Only a row that is `new` changes:
  status → `dismissed`, `withdrawn` set, `todoId`/`dismissedReason` cleared → counted
  `withdrawn`. A row that is `accepted` or `dismissed`, or does not exist, is left untouched
  and is not an error; the user's own decision always stands.
- A withdrawn row reported again follows the table above like any `dismissed` row: kept
  handled unless `resurface: true`.

The brief for `date` is replaced wholesale. A second report on the same day (the mentor's
corrected one) simply overwrites the first.

## 5. Front end

- User menu → **Beta features** → switch **Claude's suggestions**.
- When on, the sidebar header shows two tabs: **To do (n)** and **Claude (n)** where n counts `new`.
- Claude tab: run line ("Last run 7:19 AM · Brief"), then cards grouped High / Medium / Low.
  Card: title, source chip, due chip, duration chip, the `why` line, an "Open" link to
  `source.url`, and buttons **Add** and **Dismiss**. A flagged item shows
  "Possible duplicate of ‹title›" and its buttons read **Add anyway** and **Dismiss**.
  **Add** creates a to-do (title, tag, duration) at the bottom of the list, then calls `accept`.
- Handled items collapse under "Handled (n)" with **Undo** for dismissed ones. An item the
  routine withdrew shows a **Withdrawn** chip (reason as its tooltip) instead of **Dismissed**,
  with the reason as a muted line under the title; **Undo** returns it to `new` with no trace.
- **Brief** opens a dialog: summary, three lists, coverage table, mentor notes, questions.
- Pairing: opening `/?pair=<hash>&name=<host>` while signed in shows
  "Link Claude routine on ‹host›?" with **Link** and **Cancel**. Empty state of the Claude
  tab explains how to link a computer (`routine/README.md`).
- Nothing in this feature is reachable when the flag is off.

## 6. Routine side (see `routine/README.md`)

`bin/bp` is the only thing that talks to the planner: `bp pair`, `bp context`, `bp report <file>`,
`bp status`. The key lives in the instance directory at `secrets/routine.key`, mode 600.
