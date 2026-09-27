# Snippets

Small read-only extractors for the browser sources. The agents run these with the browser's script
tool instead of clicking through pages, because clicks and page-text extraction are unreliable in
background tabs and accessibility trees are large. The runner copies this directory into the
instance at the start of every run, so edits belong here, in the kit.

| File | Run it on | Gives |
|---|---|---|
| `gmail-list.js` | a Gmail list or search page | conversations shown: id, thread, sender, subject, preview, date, unread |
| `gmail-read.js` | the same list page, with `ID` set | one message of a conversation, without marking it read |
| `canvas-json.js` | a Canvas API page (`/api/v1/...`) | the listed objects, reduced to the fields that matter |
| `piazza-feed.js` | a Piazza class page | the posts in the feed, without opening any |
| `gradescope-courses.js` | `gradescope.com` home | courses by term |
| `gradescope-assignments.js` | a Gradescope course page | assignments, status, due dates |
| `discord-overview.js` | `discord.com/channels/@me` | direct messages and servers with unread and mention state |
| `discord-channel.js` | an open Discord channel or direct message | the latest messages, and the server's channels |
| `text.js` | any page | the main region's text, capped |
| `more.js` | the same tab, after any snippet | the next part of a long answer |

The script tool returns about 1000 characters per call and withholds output that looks like
query-string data. So every snippet answers in compact lines, removes query strings, and pages:
the first line of an answer reads `[0-900 of 7519; next OFFSET 900]`, and `more.js` with that
offset returns the next part without running the snippet again.

Rules every snippet follows:

- It reads and returns text. It never clicks, types, submits, scrolls to trigger loading, touches
  storage or cookies, or changes the page. The one thing it leaves behind is its own answer, in a
  variable of the tab, for `more.js`; that is gone when the tab moves on.
- It makes no network request, with one exception: `gmail-read.js` sends a single `GET` to the
  print view of the same mailbox the tab already shows. That is the only way found to read a
  conversation and leave it unread.
- It returns no address with a query string. The browser tool withholds output that looks like
  one, and the agents never need them.
- It degrades to raw text rather than failing when the site's markup changes. A snippet that
  returns nothing useful is reported in the brief's coverage as `partial`.

An agent that writes its own script is held to the first rule and may make no network request at
all.

Checked against the live sites on 2026-09-26. Gmail and Discord keep conversations and channels
unread when read this way from a background tab; Discord would mark a channel read if its tab were
brought to the front while open.
