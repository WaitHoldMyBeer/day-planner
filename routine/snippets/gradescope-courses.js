// Read-only. Run on https://www.gradescope.com/ (the "Your Courses" page).
// Lists the courses of the two newest terms, one per line: term | course id | short name | name | assignments
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
  if (!document.querySelector('a.courseBox, .courseList')) return page(`signed out, or the page changed\n${clip(document.title, 100)}\n${clip(document.body.textContent, 600)}`);
  const terms = [...document.querySelectorAll('.courseList--term')].map((t) => clip(t.textContent, 40));
  const lines = [];
  [...document.querySelectorAll('.courseList--coursesForTerm')].slice(0, 2).forEach((g, i) => {
    [...g.querySelectorAll('a.courseBox')].forEach((a) => lines.push([
      terms[i] || '?',
      (a.getAttribute('href') || '').replace(/^\/courses\//, ''),
      clip((a.querySelector('.courseBox--shortname') || {}).textContent, 50),
      clip((a.querySelector('.courseBox--name') || {}).textContent, 70),
      clip((a.querySelector('.courseBox--assignments') || {}).textContent, 30),
    ].join(' | ')));
  });
  return page(`${clip(document.title, 100)}\n${lines.length} courses\n${lines.join('\n')}`);
})()
