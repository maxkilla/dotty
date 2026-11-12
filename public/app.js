const $ = (s) => document.querySelector(s);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

const LEVELS = {
  high:   ['Needs review', 'At least one high-severity signal. These are trust signals, not fraud findings.'],
  medium: ['Check the details', 'Some signals worth a closer look before approving.'],
  low:    ['Minor notes', 'Only low-severity observations.'],
  clear:  ['No flags in FMCSA public data', 'That does not mean the carrier is safe. Verify insurance and identity independently.'],
};
const STATUS_WORD = { A: 'Active', I: 'Inactive', P: 'Pending' };

function carrierLine(e) {
  const bits = [e.name, `DOT ${e.dot}`, e.mc, e.location, STATUS_WORD[e.status] || e.status].filter(Boolean);
  return bits.join(' · ');
}

function evidence(list) {
  const shown = list.slice(0, 8);
  return h('ul', { class: 'ev' },
    shown.map((e) => h('li', {}, h('button', { class: 'link', type: 'button', onclick: () => run(String(e.dot), 'dot') }, carrierLine(e)))),
    list.length > shown.length ? h('li', { class: 'fine' }, `and ${list.length - shown.length} more`) : null);
}

function signal(s) {
  return h('div', { class: 'sig' },
    h('h3', {}, h('span', { class: 'sev ' + s.severity }, s.severity), s.title),
    s.detail ? h('p', {}, s.detail) : null,
    s.evidence ? evidence(s.evidence) : null);
}

function row(label, value) {
  return value == null || value === '' ? null : [h('dt', {}, label), h('dd', {}, value)];
}

function renderCarrier(d) {
  const c = d.carrier;
  const [title, blurb] = LEVELS[d.level];
  const mcs = c.dockets.map((x) => x.prefix + x.number + (x.status && x.status !== 'A' ? ` (${x.statusLabel})` : ''));
  const live = d.live;
  return [
    h('div', { class: 'card head' },
      h('h2', {}, c.legalName),
      c.dbaName ? h('div', { class: 'dba' }, 'DBA ' + c.dbaName) : null,
      h('div', { class: 'ids' },
        h('span', { class: 'chip ' + c.status }, c.statusLabel),
        h('span', { class: 'chip' }, 'DOT ' + c.dot),
        c.dockets.map((x) => h('span', { class: 'chip ' + (x.status || '') }, x.prefix + x.number)))),
    h('div', { class: 'level ' + d.level }, h('b', {}, title), h('span', {}, blurb)),
    h('div', { class: 'card' },
      d.signals.length ? d.signals.map(signal) : h('p', { class: 'fine' }, 'No signals to report.')),
    h('div', { class: 'card' },
      h('dl', {},
        row('Address', c.address),
        row('Phone', c.phone),
        row('Authority', mcs.join(', ')),
        row('Power units', c.powerUnits),
        row('Drivers', c.drivers),
        row('Last MCS-150 update', c.mcs150Date),
        row('Safety rating', c.safetyRating ? c.safetyRating + (c.safetyRatingDate ? ` (${c.safetyRatingDate})` : '') : null),
        row('Operation', c.operation),
        live ? row('Crashes (live FMCSA)', live.crashTotal) : null,
        live ? row('Vehicle OOS rate', live.vehicleOosRate != null ? live.vehicleOosRate + '%' : null) : null,
        live ? row('Driver OOS rate', live.driverOosRate != null ? live.driverOosRate + '%' : null) : null)),
    h('p', { class: 'fine' },
      'Source: FMCSA Company Census File, refreshed daily from a database about 24 hours old. ',
      d.meta.liveFmcsa === 'ok' ? 'Live FMCSA authority check included. ' : 'Live FMCSA authority check not included. ',
      d.meta.crossRefErrors.length ? `Some cross-checks failed (${d.meta.crossRefErrors.join(', ')}); results may be incomplete. ` : '',
      'Registration data is self-reported and can lag reality.'),
  ];
}

function renderList(d) {
  if (!d.matches.length) return h('div', { class: 'card' }, `No carriers matched "${d.query}".`);
  return h('div', { class: 'card' },
    h('p', { class: 'fine' }, `${d.matches.length}${d.matches.length === 25 ? '+' : ''} matches. Pick one:`),
    h('ul', { class: 'matches' }, d.matches.map((m) =>
      h('li', {}, h('button', { class: 'link', type: 'button', onclick: () => run(String(m.dot), 'dot') }, carrierLine(m))))));
}

async function run(q, type) {
  $('#q').value = q;
  $('#t').value = type || 'auto';
  const go = $('#go');
  go.disabled = true;
  const out = $('#out');
  out.replaceChildren(h('p', { class: 'fine' }, 'Searching…'));
  try {
    const res = await fetch('/api/lookup?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type || 'auto'));
    const d = await res.json();
    if (!res.ok) { out.replaceChildren(h('div', { class: 'card err' }, d.error || 'Something went wrong.')); return; }
    out.replaceChildren(...[].concat(d.mode === 'list' ? renderList(d) : renderCarrier(d)));
    const u = new URL(location.href);
    u.searchParams.set('q', q);
    u.searchParams.set('type', type || 'auto');
    history.replaceState(null, '', u);
  } catch {
    out.replaceChildren(h('div', { class: 'card err' }, 'Network error. Try again.'));
  } finally {
    go.disabled = false;
  }
}

$('#f').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (q) run(q, $('#t').value);
});

const pageType = document.body.dataset.type || 'auto';
$('#t').value = pageType;
const init = new URL(location.href).searchParams;
if (init.get('q')) run(init.get('q'), init.get('type') || pageType);
