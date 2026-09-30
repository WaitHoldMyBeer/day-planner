// Read-only. Run on an open Discord channel or direct message
// (https://discord.com/channels/<server or @me>/<channel>).
// Lists the latest messages, newest last, one per line: message id | time | author | text
// With CHANNELS true it lists the server's channels instead: channel id, * if unread | name
(() => {
  const OFFSET = 0;
  const CHANNELS = false;

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
  if (CHANNELS) {
    const chans = [...document.querySelectorAll('a[data-list-item-id^="channels___"]')].slice(0, 80).map((a) => {
      const label = clip(a.getAttribute('aria-label'), 80);
      return `${a.getAttribute('data-list-item-id').replace('channels___', '')}${/^unread/i.test(label) ? '*' : ''} | ${label.replace(/^unread,\s*/i, '')}`;
    });
    return page(`${clip(document.title, 100)}\n${location.pathname}, ${chans.length} channels\n${chans.join('\n')}`);
  }
  let author = '';
  const all = [...document.querySelectorAll('li[id^="chat-messages-"]')].map((li) => {
    const who = li.querySelector('h3 [class*="username"]');
    if (who) author = clip(who.textContent, 40);
    const time = li.querySelector('time');
    const body = li.querySelector('[id^="message-content-"]');
    const extra = li.querySelectorAll('[class*="attachment"], [class*="embed"]').length;
    return [
      li.id.replace('chat-messages-', '').split('-')[1] || '?',
      time ? String(time.getAttribute('datetime')).slice(0, 16) : '',
      author + (li.querySelector('[class*="mentioned"]') ? ' (mentions you)' : ''),
      clip(body ? body.textContent : '', 300) + (extra ? ` [${extra} attachment]` : ''),
    ].join(' | ');
  });
  return page(`${clip(document.title, 100)}\n${location.pathname}, showing the last ${Math.min(all.length, 15)} of ${all.length} loaded\n${all.slice(-15).join('\n')}`);
})()
