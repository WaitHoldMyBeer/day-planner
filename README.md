# Day Planner

A day planner with a prioritized to-do sidebar. Drag a task onto the timeline and it becomes a block;
blocks shove each other out of the way, locked blocks never move. Each person has their own account,
data lives in Postgres, and Google Calendar can be overlaid, imported from, pushed to, and pruned.

```
public/          the app (React 18 + htm loaded from cdnjs, no build step)
api/             Vercel functions: auth, days, todos, settings, sync, google/*
lib/             shared server code: db, auth, google, validation
dev/server.js    local server that emulates Vercel's function runtime
test/            end-to-end API tests against a real Postgres
.github/         CI: syntax check + tests on every push and pull request
```

## One-time setup (Vercel)

The Vercel project `day-planner` exists with `AUTH_SECRET`, `INVITE_CODE`, `APP_URL` and
`GOOGLE_CLIENT_ID` set. Production URL: **https://blairplanner.vercel.app** (the older
`day-planner-lilac.vercel.app` and `day-planner-kenan-blairs-projects.vercel.app` still work).
State as of 2026-09-24:

1. **Database.** Done: a Neon Postgres store is attached (`DATABASE_URL` and friends). The schema created
   itself on the first request; nothing to migrate by hand.

2. **Git for CI/CD.** Done: the repository is `WaitHoldMyBeer/day-planner` and it is connected to the
   Vercel project. Every push to `main` deploys to production and every pull request gets a preview URL.
   GitHub Actions runs the test suite on each push and pull request (`.github/workflows/ci.yml`), so a
   red check means the deploy that follows carries a failing build. Vercel's Hobby plan allows at most
   12 serverless functions per deployment; the API is 7 files, so keep related routes in one file.

3. **Google Calendar.** Done in Google Cloud project `day-planner-509622`: Calendar API enabled, OAuth
   consent screen "Day Planner" (External, published to production, homepage and privacy URLs set), and a
   Web application client "Day Planner web" with redirect URI
   `https://blairplanner.vercel.app/api/google/callback` (matches `APP_URL`). `GOOGLE_CLIENT_SECRET` is
   set on Vercel too.
   - The app is not verified by Google, so the first connect shows a "Google hasn't verified this app"
     screen: choose *Advanced → Go to Day Planner (unsafe)*. That is expected for a private app.
   - The OAuth callback always lands on `APP_URL`; the signed-in session and the address you started
     from travel inside the encrypted `state`, so connecting works from any alias of the app.
   - If you attach a custom domain later, change `APP_URL`, add that domain's `/api/google/callback` as a
     redirect URI on the client, and redeploy.

Then open the production URL, **Create account** with the invite code, and add the page to your phone's
home screen (Share → Add to Home Screen). Send the URL and invite code to anyone who should have their own
planner; each account is separate.

## Using Google Calendar in the app

- **Google → Connect Google Calendar** starts the OAuth flow. The switch **Show Google events on the day**
  toggles the overlay; events appear greyed out and dashed on the timeline, all-day events in a strip above it.
- **Click a Google event** to *Import as locked block* (it becomes a locked block other blocks move around),
  *Delete from Google* (removes it from your Google Calendar after a confirm click), or *Open* it in Google.
- **Open any block → Add to Google** creates the event in Google Calendar and locks the block.
  A block that is in Google shows a **G** badge; its editor offers *Delete from Google*, which removes the
  event and unlocks the block. Deleting the block itself leaves the Google event alone.
- Only the primary calendar is used. Edits made to a linked block later are not pushed back to Google.

## Claude's suggestions (beta)

Off by default. Account menu → **Beta features** → **Claude's suggestions** adds a second list in the
sidebar: items a routine on your own computer found in your mail and course sites that are not on your
to-do list yet, grouped High / Medium / Low, each with its source, due date, and a flag when it looks
like something you already have. **Add** turns one into a to-do; **Dismiss** hides it; **Brief** shows the
day's summary, what was checked, and what could not be.

- The planner server never calls Claude and holds no Anthropic credential. The routine runs on the
  user's machine under that user's own Claude plan and talks to the planner through `routine/bin/bp`.
- Linking a computer: run `bin/bp pair` in the routine's instance directory. It stores a key locally
  (mode 600), opens a planner page, and prints a verification code. Choose **Link** only when the page
  shows the same code. Only the key's SHA-256 hash is stored on the server. Unlink from the account menu.
- The contract (tables, endpoints, data shapes, upsert rules) is `routine/SPEC.md`.

## Local development

Needs Node 22 and a Postgres. With Docker:

```bash
docker run -d --name dp-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=planner -p 127.0.0.1:5433:5432 postgres:16-alpine
cp .env.example .env   # fill in DATABASE_URL=postgres://postgres:pw@127.0.0.1:5433/planner and AUTH_SECRET
npm install
DATABASE_URL=postgres://postgres:pw@127.0.0.1:5433/planner AUTH_SECRET=dev-secret-at-least-16-chars INVITE_CODE=dev npm run dev
```

Tests: `npm test` with the same environment variables. `npm run check` syntax-checks every file.

## Environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon injects it; `POSTGRES_URL` is accepted too) |
| `AUTH_SECRET` | Signs OAuth state and encrypts stored Google tokens. Long random string. |
| `INVITE_CODE` | Required at sign-up. Empty means anyone can register. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client for the Calendar integration |
| `APP_URL` | Public origin, used to build the OAuth redirect URI. Optional. |

## Notes

- Sessions last 90 days and live in an httpOnly cookie. There is no password reset; an admin can clear a
  password hash in the `users` table and the person re-registers, or you add reset later.
- State-changing API calls require the `X-Requested-With: fetch` header; with SameSite cookies that keeps
  other sites from driving the API from a form.
- Two devices editing the same day within the same second resolve last-writer-wins on that day document.
