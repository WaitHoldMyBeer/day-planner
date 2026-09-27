// Read-only. Returns the next part of the last snippet's answer in this tab.
// Set OFFSET to the number that answer gave after "next OFFSET". Change nothing else.
(() => {
  const OFFSET = 900;

  const t = String(window.__bpAnswer || '');
  if (!t) return 'nothing to continue: the tab has moved on, run the snippet again';
  if (OFFSET >= t.length) return `[end of ${t.length}] nothing further`;
  const end = Math.min(t.length, OFFSET + 950);
  return `[${OFFSET}-${end} of ${t.length}; ${end < t.length ? 'next OFFSET ' + end : 'end'}]\n${t.slice(OFFSET, end)}`;
})()
