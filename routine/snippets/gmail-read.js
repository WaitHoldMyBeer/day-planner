// Read-only. Run on a Gmail list or search page of the mailbox that holds the conversation.
// Set ID to the conversation's `id` from gmail-list.js (or to its thread value, when the list
// showed one). MESSAGE picks a message: -1 is the latest, 0 the first. Change nothing else.
//
// Reads the conversation through Gmail's print view, fetched from the same mailbox and turned
// into text here. Two reasons: the print view leaves the conversation unread, where opening it
// the normal way marks it read; and navigating to the print view opens a print dialog that
// freezes the tab, where handling it as text runs none of its scripts.
await (async () => {
  const ID = '0000000000000000';
  const MESSAGE = -1;
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
  const point = (n) => { try { return String.fromCodePoint(n); } catch (e) { return ' '; } };
  const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => point(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => point(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
  // Invisible characters that mail templates pad their previews with, by code point.
  const hidden = [0x200b, 0x200c, 0x200d, 0x034f, 0xfeff, 0x00ad];
  const text = (h) => [...decode((h || '').replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' '))]
    .filter((c) => !hidden.includes(c.codePointAt(0))).join('');

  let thread = null;
  if (/^[0-9a-f]{16}$/.test(ID)) thread = 'thread-f:' + BigInt('0x' + ID).toString();
  else if (/^thread-[a-z]:[A-Za-z0-9-]{1,40}$/.test(ID)) thread = ID;
  if (!thread) return 'error: ID is not a conversation id from gmail-list.js';
  const slot = (location.pathname.match(/^\/mail\/u\/(\d+)\//) || [])[1];
  if (location.hostname !== 'mail.google.com' || slot === undefined) return 'error: not on a Gmail mailbox page';

  const res = await fetch(`/mail/u/${slot}/?view=pt&search=all&permthid=${encodeURIComponent(thread)}`, { method: 'GET', credentials: 'same-origin' });
  if (!res.ok) return `error: the print view answered ${res.status}`;
  const html = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const parts = html.split(/<table\b[^>]*\bclass="?message"?[^>]*>/i).slice(1);
  const subject = clip(text((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]), 200).replace(/^[^-]*-\s*/, '');
  if (!parts.length) return page(`${clip(document.title, 100)}\nno messages found; raw text follows\n${clip(text(html), 3000)}`);
  const at = MESSAGE < 0 ? parts.length + MESSAGE : MESSAGE;
  const p = parts[Math.max(0, Math.min(parts.length - 1, at))];
  // The print view omits closing tags: rows are told apart by where the next one opens.
  const rows = p.split(/<tr\b[^>]*>/i).slice(1);
  const head = (rows[0] || '').split(/<td\b[^>]*>/i).map((c) => clip(text(c), 120)).filter(Boolean);
  const senders = parts.map((q, i) => `${i}: ${clip(text((q.split(/<tr\b[^>]*>/i)[1] || '').split(/<td\b[^>]*>/i)[1]), 60)}`);
  return page([
    clip(document.title, 100),
    `subject: ${subject}`,
    `messages: ${parts.length} (${senders.slice(-8).join('; ')})`,
    `showing message ${Math.max(0, Math.min(parts.length - 1, at))}`,
    `from: ${head[0] || '?'}`,
    `date: ${head[1] || '?'}`,
    `to: ${clip(text(rows[1]), 200).replace(/^To:\s*/i, '') || '?'}`,
    '',
    clip(text(rows.slice(2).join('\n')), 6000),
  ].join('\n'));
})()
