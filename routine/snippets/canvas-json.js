// Read-only. Run on a Canvas API page (https://<canvas host>/api/v1/...) opened by navigation.
// Lists the objects on the page, one per line, reduced to what matters for triage:
//   type | course | id | title | date | state | path
// Set ITEM to an object's id to read its text instead (an announcement's message, a
// conversation's last message).
(() => {
  const OFFSET = 0;
  const ITEM = null;

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
  const plain = (h) => clip(String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'), 6000);
  const raw = (document.body ? document.body.textContent : '').replace(/^\s*while\(1\);/, '');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return page(`${location.origin}${location.pathname}\nnot JSON\n${clip(raw, 1500)}`); }
  const list = Array.isArray(data) ? data : [data];
  if (ITEM !== null) {
    const o = list.find((x) => String(x.id) === String(ITEM) || String(x.plannable_id) === String(ITEM));
    if (!o) return `no object with id ${ITEM} on this page`;
    const p = o.plannable || {};
    return page([
      `${o.title || o.subject || p.title || o.name || ''}`,
      `posted: ${o.posted_at || o.last_message_at || o.plannable_date || '?'}; read state: ${o.read_state || o.workflow_state || '?'}`,
      '',
      plain(o.message || o.last_message || p.message || o.description || ''),
    ].join('\n'));
  }
  const lines = list.slice(0, 100).map((o) => {
    const p = o.plannable || {};
    const s = o.submissions && typeof o.submissions === 'object' ? o.submissions : null;
    const state = s
      ? ['submitted', 'graded', 'missing', 'late', 'excused'].filter((k) => s[k]).join(',') || 'not submitted'
      : (o.read_state || o.workflow_state || '');
    return [
      o.plannable_type || (o.course_code ? 'course' : o.context_code ? 'announcement' : o.subject != null ? 'conversation' : 'object'),
      o.course_id || o.context_code || o.course_code || '',
      o.plannable_id || o.id || '',
      clip(p.title || o.title || o.subject || o.name || '', 70),
      p.due_at || o.due_at || p.todo_date || o.plannable_date || o.posted_at || o.last_message_at || o.start_at || '',
      state + (p.points_possible != null ? ` ${p.points_possible}pt` : '') + (o.new_activity ? ' new' : ''),
      String(o.html_url || '').replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/, ''),
    ].join(' | ');
  });
  return page(`${location.origin}${location.pathname}\n${list.length} objects${list.length >= 100 ? ' (the list may continue on the next page)' : ''}\n${lines.join('\n')}`);
})()
