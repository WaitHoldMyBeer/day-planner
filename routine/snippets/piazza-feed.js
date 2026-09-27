// Read-only. Run on a Piazza class page (https://piazza.com/class/<class id>) once it has loaded.
// Lists the posts in the feed, one per line: post id, * if unread | kind | when | title | preview
// It does not open any post: opening one marks it read.
// If the script tool is refused on this site, read the page with the page-text tool instead.
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
  const one = (el, sel, n) => { const e = el.querySelector(sel); return e ? clip(e.textContent, n) : ''; };
  const posts = [...document.querySelectorAll('.feed_item')].slice(0, 60).map((el) => {
    const mark = el.querySelector('.unread_indicator');
    const title = one(el, '.title_text, .title', 80);
    if (!title) return `? ${clip(el.textContent, 200)}`; // layout changed: raw text
    return [
      (el.id || '').replace(/_item$/, '') + (mark && !/invisible/.test(mark.className || '') ? '*' : ''),
      clip((el.className || '').toString().replace(/feed_item|clearfix/g, ' '), 30),
      one(el, '.timestamp', 20),
      title,
      one(el, '.snippet', 110),
    ].join(' | ');
  });
  const head = `${clip(document.title, 100)}\n${location.pathname}, ${posts.length} posts`;
  if (!posts.length) return page(`${head}\nno feed found; page text follows\n${clip((document.querySelector('#page_main, main, [role=main]') || document.body).textContent, 1500)}`);
  return page(`${head}\n${posts.join('\n')}`);
})()
