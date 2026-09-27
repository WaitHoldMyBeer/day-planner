// Read-only. Run on https://discord.com/channels/@me once the page has loaded.
// Lists the unread direct messages, then every server, one per line:
//   dm | channel id* | name | mention count
//   server | server id, * if unread | name | mention count
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
  const dms = [...document.querySelectorAll('a[href^="/channels/@me/"]')].slice(0, 60).map((a) => {
    const label = clip(a.getAttribute('aria-label') || a.textContent, 90);
    const wrap = a.closest('li') || a.parentElement;
    const badge = wrap ? wrap.querySelector('[class*="numberBadge"]') : null;
    const unread = /^unread/i.test(label) || !!badge;
    return { unread, line: `dm | ${a.getAttribute('href').split('/').pop()}${unread ? '*' : ''} | ${label.replace(/^unread,\s*/i, '').slice(0, 50)} | ${badge ? clip(badge.textContent, 6) : ''}` };
  });
  const servers = [...document.querySelectorAll('[data-list-item-id^="guildsnav___"]')].map((g) => {
    const id = g.getAttribute('data-list-item-id').replace('guildsnav___', '');
    if (!/^\d+$/.test(id)) return null;
    const wrap = g.closest('[class*="listItem"]') || g.parentElement;
    const named = wrap ? [...wrap.querySelectorAll('[data-dnd-name]')]
      .map((e) => e.getAttribute('data-dnd-name'))
      .find((n) => n && !/^(Above|Combine with) /.test(n)) : null;
    const labels = wrap ? [...wrap.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')) : [];
    const badge = wrap ? wrap.querySelector('[class*="numberBadge"]') : null;
    const unread = /unread/i.test(g.textContent || '') || labels.some((l) => /unread/i.test(l || ''));
    return `server | ${id}${unread ? '*' : ''} | ${clip(named || g.getAttribute('aria-label') || labels.join(' '), 50)} | ${badge ? clip(badge.textContent, 6) : ''}`;
  }).filter(Boolean);
  // Only unread direct messages are listed: they are what the routine reads.
  const unread = dms.filter((d) => d.unread).map((d) => d.line);
  return page(`${clip(document.title, 80)}\n${dms.length} direct messages, ${unread.length} unread; ${servers.length} servers\n${unread.join('\n')}${unread.length ? '\n' : ''}${servers.join('\n')}`);
})()
