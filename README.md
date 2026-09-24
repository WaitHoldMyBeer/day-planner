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

The Vercel project `day-planner` already exists with `AUTH_SECRET` and `INVITE_CODE` set. Three things
need an account only you control:

1. **Database.** In the Vercel project open **Storage → Create Database → Neon (Postgres)**, free plan,
   connect it to `day-planner` for all environments. That injects `DATABASE_URL`. The schema creates
   itself on the first request; nothing to migrate by hand.

2. **Git for CI/CD.** Create an empty private repository on GitHub (for example `WaitHoldMyBeer/day-planner`),
   then from this folder:

   ```bash
   git remote add origin git@github.com:WaitHoldMyBeer/day-planner.git
   git push -u origin main
   ```

   In the Vercel project open **Settings → Git → Connect** and pick that repository. From then on every
   push to `main` deploys to production and every pull request gets a preview URL. GitHub Actions runs
   the test suite on each push and pull request (`.github/workflows/ci.yml`), so a red check means the
   deploy that follows carries a failing build.

3. **Google Calendar** (optional, needed only for the Google features).
   In [Google Cloud console](https://console.cloud.google.com/) create or pick a project, then:
   - **APIs & Services → Library**: enable **Google Calendar API**.
   - **APIs & Services → OAuth consent screen**: External, add the Calendar scope
     `https://www.googleapis.com/auth/calendar.events`, add both Google accounts as test users while the
     app is in *Testing*. Note: in Testing status Google expires refresh tokens after 7 days, so publish
     the app (**Publish app**) once it works; an unverified app just shows a warning screen the first time.
   - **APIs & Services → Credentials → Create credentials → OAuth client ID**, type *Web application*.
     Authorized redirect URI: `https://<your production domain>/api/google/callback`
     (the production domain is shown at the top of the Vercel project; add a second URI for a custom
     domain if you attach one).
   - In Vercel → **Settings → Environment Variables** add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
     (Production and Preview), and `APP_URL` = `https://<your production domain>` so the redirect URI
     is stable. Redeploy.

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
