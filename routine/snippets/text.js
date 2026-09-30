// Read-only. Generic: the text of the page's main region. For pages no other snippet fits.
// Works in background tabs where the page-text tool returns little. Change SELECTOR and OFFSET only.
(() => {
  const OFFSET = 0;
  const SELECTOR = 'main, [role=main], #main, body';

  // The script tool returns about 1000 characters. A longer answer is kept in the tab, and
  // more.js returns the rest of it: set its OFFSET to the number given after "next OFFSET".
  const page = (s) => {
    const t = s.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1') // addresses without their query strings
      .replace(/[\w.%-]+=[^\s&=]*(&[\w.%-]+=[^\s&=]*)+/g, '[...]'); // and no query-like data at all
    window.__bpAnswer = t;
    const end = Math.min(t.length, OFFSET + 900);
    return `[${OFFSET}-${end} of ${t.length}; ${end < t.length ? 'next OFFSET ' + end : 'end'}]\n${t.slice(OFFSET, end)}`;
  };
  const el = document.querySelector(SELECTOR) || document.body;
  const text = (el.innerText && el.innerText.trim().length > 50 ? el.innerText : el.textContent || '')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return page(`${document.title.slice(0, 100)}\n${location.origin}${location.pathname}\n${text.slice(0, 20000)}`);
})()
