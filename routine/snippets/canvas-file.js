// Read-only. Run on a file's record:
//   https://<canvas host>/api/v1/courses/<course id>/files/<file id>
// Says what the file is. With OPEN true it then points this tab at Canvas's own document viewer
// for that file, where docviewer-text.js reads the text. Nothing is downloaded.
(() => {
  const OPEN = false;

  const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const raw = (document.body ? document.body.textContent : '').replace(/^\s*while\(1\);/, '');
  let d;
  try { d = JSON.parse(raw); } catch (e) { return `not JSON: ${clip(raw, 200).replace(/[^\w .,:-]/g, ' ')}`; }
  const about = `${clip(d.display_name, 100)} | file ${d.id} | ${d['content-type']} | ${d.size} bytes | changed ${d.updated_at}`;
  if (!OPEN) return `${about}\nviewer: ${d.canvadoc_session_url ? 'available' : 'not available for this file'}`;
  if (!d.canvadoc_session_url) return `${about}\nno viewer for this file; it cannot be read here`;
  if (location.hostname.indexOf('canvas') < 0 && location.hostname.indexOf('instructure') < 0) return 'error: not on a Canvas page';
  // The viewer's address is Canvas's own, taken as given; it is opened, never rewritten.
  location.href = new URL(d.canvadoc_session_url, location.origin).href;
  return `${about}\nopening the document viewer; wait about ten seconds, then run docviewer-text.js`;
})()
