// Read-only. Returns the next part of the last snippet's answer in this tab.
// Set OFFSET to the number that answer gave after "next OFFSET". Change nothing else, except:
// when the tool withholds a part, ask for that part again with SPAN 300, span by span, and leave
// out only the span it still withholds. Say in your coverage which characters you could not read.
(() => {
  const OFFSET = 900;
  const SPAN = 950;

  const t = String(window.__bpAnswer || '');
  if (!t) return 'nothing to continue: the tab has moved on, run the snippet again';
  if (OFFSET >= t.length) return `[end of ${t.length}] nothing further`;
  const end = Math.min(t.length, OFFSET + Math.max(50, Math.min(950, SPAN)));
  return `[${OFFSET}-${end} of ${t.length}; ${end < t.length ? 'next OFFSET ' + end : 'end'}]\n${t.slice(OFFSET, end)}`;
})()
