// Read-only. Run on a course's module list:
//   https://<canvas host>/api/v1/courses/<course id>/modules?include[]=items&per_page=50
// Lists what the course links to, one per line: module | kind | item id | title | ref | where
// `ref` is a file id or a page name; `where` is the site and path of an outside link.
// This is where a course keeps its syllabus, its schedule page and its forum link.
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
  const raw = (document.body ? document.body.textContent : '').replace(/^\s*while\(1\);/, '');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return page(`${location.origin}${location.pathname}\nnot JSON\n${clip(raw, 1500)}`); }
  const mods = Array.isArray(data) ? data : [data];
  const lines = [];
  mods.forEach((m) => (m.items || []).forEach((i) => {
    let where = '';
    try { const u = new URL(i.external_url || ''); where = u.host + u.pathname; } catch (e) { where = ''; }
    lines.push([clip(m.name, 40), i.type, i.id, clip(i.title, 70), i.content_id || i.page_url || '', where].join(' | '));
  }));
  const short = mods.filter((m) => (m.items || []).length < (m.items_count || 0)).map((m) => clip(m.name, 40));
  return page(`${location.origin}${location.pathname}\n${mods.length} modules, ${lines.length} items${short.length ? '; not all items listed for: ' + short.join(', ') : ''}\n${lines.join('\n')}`);
})()
