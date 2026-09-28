// Read-only. Run on a course's own record:
//   https://<canvas host>/api/v1/courses/<course id>?include[]=syllabus_body
// Gives the course's name, its home view, and the text of the syllabus kept in Canvas, with the
// links it holds. Many courses keep the syllabus as a file instead; canvas-modules.js finds it.
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
  let d;
  try { d = JSON.parse(raw); } catch (e) { return page(`${location.origin}${location.pathname}\nnot JSON\n${clip(raw, 1500)}`); }
  const html = String(d.syllabus_body || '');
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 40).map((m) => {
    let where = m[1];
    try { const u = new URL(m[1], location.origin); where = u.host + u.pathname; } catch (e) { where = clip(m[1], 80); }
    return `${clip(m[2].replace(/<[^>]*>/g, ' '), 50)} -> ${where}`;
  });
  const text = clip(html.replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, 'and'), 12000);
  return page([
    `${clip(d.name, 100)} (course ${d.id})`,
    `home view: ${d.default_view || '?'}`,
    text ? `syllabus in Canvas, ${text.length} characters:` : 'no syllabus text in Canvas; look for a file or a link with canvas-modules.js',
    text,
    links.length ? `links:\n${links.join('\n')}` : '',
  ].join('\n'));
})()
