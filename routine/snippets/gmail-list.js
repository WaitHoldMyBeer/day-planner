// Read-only. Run on a Gmail list or search page. Lists the conversations shown, one per line:
//   row, * if unread | date | sender | subject | preview | id
// The first line names the mailbox; confirm it is the one you meant to read.
// `id` identifies the conversation: use it in fingerprints and as ID in gmail-read.js.
(() => {
  const OFFSET = 0;

  const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  // The script tool returns about 1000 characters. A longer answer is kept in the tab, and
  // more.js returns the rest of it: set its OFFSET to the number given after "next OFFSET".
  const page = (s) => {
    const t = s.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1') // addresses without their query strings
      .replace(/[\w.%-]+=[^\s&=]*(&[\w.%-]+=[^\s&=]*)+/g, '[...]'); // and no query-like data at all
    window.__bpAnswer = t;
    const end = Math.min(t.length, OFFSET + 900);
    return `[${OFFSET}-${end} of ${t.length}; ${end < t.length ? 'next OFFSET ' + end : 'end'}]\n${t.slice(OFFSET, end)}`;
  };
  const rows = [...document.querySelectorAll('[role=main] tr.zA')].slice(0, 60).map((r, i) => {
    const idEl = r.querySelector('[data-legacy-thread-id]');
    const fromEl = r.querySelector('.yW [email], .yX [email]');
    const dateEl = r.querySelector('td.xW span');
    const id = idEl ? idEl.getAttribute('data-legacy-thread-id') : '';
    const thread = idEl ? (idEl.getAttribute('data-thread-id') || '').replace(/^#/, '') : '';
    const from = fromEl ? fromEl.getAttribute('email') : '';
    const subject = clip((r.querySelector('.bog') || {}).textContent, 70);
    if (!subject && !from) return `${i} ? ${clip(r.textContent, 200)}`; // layout changed: raw text
    return [
      `${i}${r.classList.contains('zE') ? '*' : ''}`,
      clip(dateEl ? dateEl.textContent : '', 12),
      clip(from, 40),
      subject,
      clip((r.querySelector('.y2') || {}).textContent, 60).replace(/^-\s*/, ''),
      // Conversations the owner started carry another kind of thread value; show it when it differs.
      /^thread-f:/.test(thread) || !thread ? id : `${id} ${thread}`,
    ].join(' | ');
  });
  return page(`${clip(document.title, 100)}\n${rows.length} conversations\n${rows.join('\n')}`);
})()
