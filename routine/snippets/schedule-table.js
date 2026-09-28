// Read-only. Run on a course page that keeps its schedule in a table. Reads the largest table
// and gives the rows dated from FROM for DAYS days, one per line, cells joined by " | ", under the
// table's own column names. A link in a cell is shown as "text -> site/path".
// FROM is 'YYYY-MM-DD', or '' for today. With ALL true it gives every row that holds anything
// beyond its date, which is how to learn a course's exam dates and recurring work once.
(() => {
  const OFFSET = 0;
  const FROM = '';
  const DAYS = 10;
  const ALL = false;

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
  const tables = [...document.querySelectorAll('table')].sort((a, b) => b.rows.length - a.rows.length);
  if (!tables.length) return page(`${clip(document.title, 100)}\n${location.host}${location.pathname}\nno table on this page; use text.js`);
  const t = tables[0];
  const cell = (c) => {
    const links = [...c.querySelectorAll('a[href]')].slice(0, 4).map((a) => {
      try { const u = new URL(a.href); return `${clip(a.textContent, 40)} -> ${u.host}${u.pathname}`; } catch (e) { return ''; }
    }).filter(Boolean);
    const words = clip(c.textContent, 160);
    return (links.length ? `${words} {${links.join(' ; ')}}` : words).replace(/\|/g, '/');
  };
  const width = Math.max(...[...t.rows].slice(0, 5).map((r) => [...r.cells].reduce((n, c) => n + c.colSpan, 0)));
  const carry = [];
  const grid = [...t.rows].map((row) => {
    const out = []; let k = 0;
    const cells = [...row.cells];
    for (let col = 0; col < width; col += 1) {
      if (carry[col] && carry[col].left > 0) { out[col] = carry[col].keep; carry[col].left -= 1; continue; }
      const c = cells[k]; k += 1;
      if (!c) { out[col] = ''; continue; }
      const words = cell(c);
      out[col] = words;
      // A cell that spans rows is repeated only when it names the week or the date.
      if (c.rowSpan > 1) carry[col] = { keep: col < 2 ? words : '', left: c.rowSpan - 1 };
      for (let s = 1; s < c.colSpan && col + 1 < width; s += 1) { col += 1; out[col] = ''; }
    }
    return out;
  });
  const head = grid[0].join(' | ');
  const day = (s) => {
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
    return null;
  };
  const start = /^\d{4}-\d{2}-\d{2}$/.test(FROM) ? day(FROM) : new Date(new Date().toDateString());
  const end = new Date(start.getTime() + DAYS * 86400000);
  const rows = grid.slice(1).map((r) => ({ when: day(r.join(' ')), filled: r.filter(Boolean).length, line: r.join(' | ') }));
  const dated = rows.filter((r) => r.when);
  let pick;
  if (ALL || !dated.length) pick = rows.filter((r) => r.filled > 2);
  else pick = dated.filter((r) => r.when >= start && r.when < end && r.filled > 2);
  const span = ALL || !dated.length ? 'every row with content' : `rows dated ${start.toDateString()} to ${new Date(end.getTime() - 86400000).toDateString()}`;
  return page(`${clip(document.title, 100)}\n${location.host}${location.pathname}\n${rows.length} rows, ${dated.length} dated; showing ${pick.length}: ${span}\nCOLUMNS: ${head}\n${pick.map((r) => r.line).join('\n')}`);
})()
