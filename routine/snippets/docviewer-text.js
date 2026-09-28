// Read-only. Run on Canvas's document viewer (canvadocs.instructure.com), reached with
// canvas-file.js. Gives the text of the document, page by page, without downloading it.
//
// The viewer draws pages slowly or not at all in a background tab, so this does not wait for
// it: it asks the viewer's own library for the text of the file the viewer was given. That
// loads the same file the viewer would show, from the same place, and keeps nothing.
await (async () => {
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
  const viewer = window.DocViewer;
  const lib = window.pdfjsLib;
  const held = viewer && viewer.sessionData ? viewer.sessionData : {};
  // The address the viewer itself holds for the file; it is used as given.
  const file = held.urls && held.urls.pdf_download ? held.urls.pdf_download : null;
  let name = held.pdfjs && held.pdfjs.documentName ? held.pdfjs.documentName : document.title;
  try { name = decodeURIComponent(name); } catch (e) { /* keep it as it is */ }
  name = clip(name, 100);
  if (location.hostname !== 'canvadocs.instructure.com') return 'error: not on the document viewer; open a file with canvas-file.js first';
  if (!lib || !file) return page(`${name}\nthe viewer has not started yet; wait ten seconds and run this again\n${clip(document.body ? document.body.textContent : '', 200)}`);
  let doc;
  try { doc = await lib.getDocument(file).promise; } catch (e) { return `error: the document could not be opened (${clip(String(e && e.message), 120)})`; }
  const count = Math.min(doc.numPages, 40);
  const parts = [];
  for (let i = 1; i <= count; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push(`--- page ${i}\n${clip(content.items.map((it) => it.str).join(' '), 8000)}`);
  }
  const text = parts.join('\n');
  const thin = text.replace(/--- page \d+/g, '').trim().length < 40 * count;
  return page(`${name}\n${doc.numPages} pages${doc.numPages > count ? `, first ${count} read` : ''}${thin ? '; almost no text: this is probably a scan, which cannot be read here' : ''}\n${text}`);
})()
