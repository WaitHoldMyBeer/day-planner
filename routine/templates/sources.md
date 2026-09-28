# Sources

The registry the routine and the mentor read from. Only entries marked `enabled: yes` are read, and
only in the way the entry describes. You own this file; the agents cannot edit it. To switch a
source off, change its `enabled` line to `no`. Delete the entries you do not use.

`<since>` below is the look-back date from the run's `preflight.json`. `<N>` is the number of days
from that date to today, rounded up, and at least 2.

## Rules that apply to every source

- Write here anything that holds everywhere, for example "billing reminders are brief-only".

## Mail

### Main mail
- enabled: no
- account: `you@example.com`
- read with: the Gmail connector (`search_threads`, then `get_thread` for the few that need it).
  The connector reads the one Google account you connected to Claude.
- list: search `after:<since as YYYY/MM/DD> -category:promotions -category:social`
- fingerprint: `mail:you@example.com:<thread id>`

### Second mailbox
- enabled: no
- account: `you@school.example`
- read with: Chrome, Gmail account slot 1 (the number in the address when you open that mailbox)
- list: navigate to `https://mail.google.com/mail/u/1/#search/newer_than%3A<N>d`, wait for it to
  load, then run `snippets/gmail-list.js`
- confirm: the `account` value returned must contain `you@school.example`. If it names any other
  address, stop, mark this source `skipped` with "account slots changed", and do not try other slots.
- open a conversation: on that same list page, run `snippets/gmail-read.js` with `ID` set to the
  conversation's `id`. Never navigate to a conversation.
- link for the owner: `https://mail.google.com/mail/u/1/#all/<id>`
- fingerprint: `mail:you@school.example:<id>`

## Course sites

### Canvas
- enabled: no
- site: `https://canvas.example.edu`
- read with: Chrome. Navigate straight to the addresses below and run `snippets/canvas-json.js` on
  each.
  1. Courses: `https://canvas.example.edu/api/v1/courses?enrollment_state=active&per_page=50`
  2. Work and announcements:
     `https://canvas.example.edu/api/v1/planner/items?start_date=<since date>&end_date=<today + 21 days>&per_page=100`
  3. Announcement text, only when a title does not settle what is asked:
     `https://canvas.example.edu/api/v1/announcements?context_codes[]=course_<id>&start_date=<since date>&end_date=<tomorrow>&per_page=20`
     `canvas-json.js` lists them; set its `ITEM` to an announcement's id to read its text.
  4. Inbox, list only: `https://canvas.example.edu/api/v1/conversations?scope=unread&per_page=20`
- course documents, for every course, every run:
  5. What the course links to:
     `https://canvas.example.edu/api/v1/courses/<id>/modules?include[]=items&per_page=50` with
     `snippets/canvas-modules.js`, and
     `https://canvas.example.edu/api/v1/courses/<id>?include[]=syllabus_body` with
     `snippets/canvas-course.js`.
  6. A document (syllabus, schedule, homework instructions) is read in full when
     `memory/courses.md` has no record of it or the site says it changed since. Navigate to
     `https://canvas.example.edu/api/v1/courses/<id>/files/<file id>`, run
     `snippets/canvas-file.js` with `OPEN` true, wait ten seconds, then run
     `snippets/docviewer-text.js`. Nothing is downloaded.
  7. A link that leaves Canvas is followed only if its site is listed under "Course pages" below.
     Otherwise name the site in the brief's questions.
- never open a form, a quiz, or a submission page. Those are where you do the work; the routine
  gives you the link.
- never: navigate to an announcement, discussion or conversation page, and never request a single
  conversation. Both mark the item read.
- signed out looks like: a sign-in page, or `{"status":"unauthenticated"}`. Mark `skipped`.
- link for the owner: the site address followed by the item's `html_url`
- fingerprint: `canvas:<type>:<course id>:<item id>`

### Course pages
- enabled: no
- what: pages outside Canvas that a course uses for its schedule. List each one here, and add its
  site to `allowed_hosts` in `config.json`. A course page that is not listed is not opened.
- pages:
  - *(course)*: `https://instructor.example.edu/course/`
- read with: Chrome. Navigate to the page and run `snippets/schedule-table.js`. It gives the rows
  for the coming 10 days; with `ALL` true, every row.
- source kind in reports: `other`, with label `<course> schedule page`
- fingerprint: `course:<course id>:<slug of the work>:<date due>`

### Gradescope
- enabled: no
- site: `https://www.gradescope.com`
- read with: Chrome. Navigate to `https://www.gradescope.com/`, run
  `snippets/gradescope-courses.js`. For each course of the current term, navigate to
  `https://www.gradescope.com/courses/<course id>` and run `snippets/gradescope-assignments.js`.
- signed out looks like: the public marketing page or a "Log In" button. Mark `skipped`.
- fingerprint: `gradescope:<course id>:<assignment id, or a slug of its name>`

### Piazza
- enabled: no
- site: `https://piazza.com`
- read with: Chrome. Navigate to `https://piazza.com/class/<class id>`, wait for the feed, run
  `snippets/piazza-feed.js`. If the script tool is refused on this site, read the feed with the
  page reader (`read_page`) instead; the page-text tool returns only a site banner here.
- never: open a post. Opening marks it read and counts as a view.
- classes: `<class id>` Course name
- fingerprint: `piazza:<class id>:<post id>`

## Chat

### Discord
- enabled: no
- site: `https://discord.com`
- read with: Chrome.
  1. Navigate to `https://discord.com/channels/@me`, wait, run `snippets/discord-overview.js`.
  2. For each direct message or group marked `unread`, at most 6: navigate to
     `https://discord.com/channels/@me/<channel>`, run `snippets/discord-channel.js`.
  3. For each server on the watch list: navigate to `https://discord.com/channels/<server>`, run
     `snippets/discord-channel.js` with `CHANNELS` true, then visit at most 3 of its `unread` channels.
  4. For other servers, read nothing; mention counts go in the brief as one low line.
- watch list: *(empty)*
- close the tab as soon as the reading is done.
- source kind in reports: `other`, with label `Discord · <name>`
- fingerprint: `discord:<channel id>:<message id>`
- caution: Discord's terms do not allow automating a personal account. Enabling this is your call.

## Local files

### Files listed in config.json
- enabled: no
- read with: the copies the runner places in `RUN_DIR/inputs/local/`, from `local_inputs` in
  `config.json`. Never read the originals.
- fingerprint: `local:<file-slug>:<date>:<slug>`

## Excluded

Never opened, listed, searched or read, not even to check whether they matter.

| What | Why |
|---|---|
| *(accounts, sites and folders the routine must never touch)* | |
