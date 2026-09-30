// Read-only. Run on a course dashboard, https://www.gradescope.com/courses/<id>.
// Lists the assignments, one per line: name | status | released | due (and late due) | path
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
  const rows = [...document.querySelectorAll('#assignments-student-table tbody tr')].map((r) => {
    const head = r.querySelector('th');
    const link = head ? head.querySelector('a') : null;
    return [
      clip(head ? head.textContent : '', 90),
      clip((r.querySelector('.submissionStatus') || r.querySelector('td') || {}).textContent, 40),
      clip((r.querySelector('.submissionTimeChart--releaseDate') || {}).textContent, 30),
      [...r.querySelectorAll('.submissionTimeChart--dueDate')].map((e) => e.getAttribute('datetime') || clip(e.textContent, 40)).join(' / '),
      link ? String(link.getAttribute('href')).replace(/[?#].*$/, '') : '',
    ].join(' | ');
  });
  const head = `${clip(document.title, 100)}\ncourse ${location.pathname.replace(/^\/courses\//, '')}, ${rows.length} assignments`;
  if (!rows.length) return page(`${head}\nno assignment table; page text follows\n${clip((document.querySelector('main') || document.body).textContent, 1500)}`);
  return page(`${head}\n${rows.join('\n')}`);
})()
