const $ = (s) => document.querySelector(s);
// The icon sprite lives in app.js on the lookup pages; the bulk page only needs the search glyph.
document.body.insertAdjacentHTML('afterbegin', '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol></defs></svg>');

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

const btn = $('#run'), msg = $('#msg'), res = $('#res');

fetch('/api/health').then((r) => r.json()).then((j) => {
  if (!j.bulk) { btn.disabled = true; msg.textContent = 'Bulk check is not set up on this site yet.'; }
}).catch(() => {});

function csv(rows) {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['DOT', 'MC', 'Name', 'Location', 'Status', 'Authority', 'Power units', 'MCS-150', 'Result', 'Flags'];
  const lines = rows.map((r) => [r.dot, r.mc, r.name, r.location, r.status, r.authority, r.powerUnits, r.mcs150Date, r.level, r.flags.map((f) => f.text).join('; ')].map(q).join(','));
  return [head.map(q).join(','), ...lines].join('\n');
}

function render(d) {
  const review = d.rows.filter((r) => r.level !== 'clear').length;
  const table = h('table', { class: 'bulk' },
    h('thead', {}, h('tr', {}, ['Carrier', 'Status', 'Authority', 'Fleet', 'MCS-150', 'Notes'].map((t, i) => h('th', { class: i > 1 && i < 5 ? 'hide-s' : '' }, t)))),
    h('tbody', {}, d.rows.map((r) => h('tr', {},
      h('td', {}, h('span', { class: 'lvd ' + r.level, title: r.level }), h('a', { href: `/?q=${r.dot}&type=dot` }, r.name || 'DOT ' + r.dot), h('span', { class: 'fl' }, [`DOT ${r.dot}`, r.mc, r.location].filter(Boolean).join(' · '))),
      h('td', {}, r.status || '-'),
      h('td', { class: 'hide-s' }, r.authority || '-'),
      h('td', { class: 'hide-s' }, r.powerUnits ?? '-'),
      h('td', { class: 'hide-s' }, r.mcs150Date || '-'),
      h('td', {}, r.flags.length ? r.flags.map((f) => h('span', { class: 'fl ' + f.severity }, f.text)) : h('span', { class: 'fl' }, 'No flags'))))));
  res.replaceChildren(
    h('p', { class: 'bulk-sum' }, `${d.rows.length} checked · ${review} need a look` + (d.notFound.length ? ` · ${d.notFound.length} not found` : '') + (d.truncated ? ' · only the first 50 were checked' : '')),
    h('div', { class: 'card bulk-wrap', style: 'margin-top:8px' }, table),
    d.notFound.length ? h('p', { class: 'fine' }, 'Not found: ' + d.notFound.join(', ')) : null,
    h('p', { class: 'fine' }, h('button', { class: 'link', type: 'button', onclick: () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([csv(d.rows)], { type: 'text/csv' })), download: 'dotty-bulk-check.csv' });
      document.body.append(a); a.click(); a.remove();
    } }, 'Download as CSV')));
}

btn.addEventListener('click', async () => {
  const dots = $('#dots').value.trim();
  if (!dots) { msg.textContent = 'Paste at least one DOT number.'; return; }
  btn.disabled = true; msg.textContent = 'Checking…'; res.replaceChildren();
  try {
    const r = await fetch('/api/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dots }) });
    const d = await r.json();
    if (!r.ok) { msg.textContent = d.error || 'Something went wrong.'; return; }
    msg.textContent = '';
    render(d);
  } catch { msg.textContent = 'Network error. Try again.'; }
  finally { btn.disabled = false; }
});
