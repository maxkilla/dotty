const $ = (s) => document.querySelector(s);
const strip = $('#strip');

// Inline icon set (stroke icons, inherit text colour).
const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></symbol>
<symbol id="i-truck" viewBox="0 0 24 24"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></symbol>
<symbol id="i-road" viewBox="0 0 24 24"><path d="M8 3 4 21M16 3l4 18M12 4v3M12 10.5v3M12 17v3"/></symbol>
<symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
<symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5"/></symbol>
</defs></svg>`;
document.body.insertAdjacentHTML('afterbegin', SPRITE);
function ic(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'i');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
const SEC_ICON = { 'Signals': 'alert', 'Authority and insurance history': 'doc', 'Who owns this company?': 'users', 'California Motor Carrier Permit': 'road', 'Census record': 'truck' };
const SEV_ICON = { high: 'alert', medium: 'alert', low: 'info', info: 'info' };
const LEVEL_ICON = { high: 'alert', medium: 'alert', low: 'info', clear: 'shield' };

// Fade cards in as they scroll into view.
const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08 }) : null;
function armReveal() {
  if (!io) return;
  document.documentElement.classList.add('rv');
  document.querySelectorAll('#out .card, #out .verdict .level').forEach((el) => { el.classList.add('reveal'); io.observe(el); });
}

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
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
    h('span', { class: 'dot ' + s.severity }, ic(SEV_ICON[s.severity] || 'info')),
    h('div', {},
      h('h3', {}, h('span', { class: 'sev ' + s.severity }, s.severity), s.title),
      s.detail ? h('p', {}, s.detail) : null,
      s.evidence ? evidence(s.evidence) : null));
}

// Collapsible result section: the title and a one-line meta stay visible, the detail folds away.
function section(title, meta, open, ...kids) {
  const d = h('details', { class: 'card sec' }, h('summary', {}, h('span', { class: 'sic' }, ic(SEC_ICON[title] || 'layers')), h('h3', {}, title), meta ? h('span', { class: 'meta' }, meta) : null), h('div', { class: 'body' }, kids));
  if (open) d.open = true;
  return d;
}

function row(label, value) {
  return value == null || value === '' ? null : [h('dt', {}, label), h('dd', {}, value)];
}

function money(n) { return n == null ? '' : '$' + Number(n).toLocaleString('en-US'); }

function renderHistory(hist) {
  if (!hist) return null;
  const a = hist.authority || {}, ins = hist.insurance || {};
  const partial = hist.errors && hist.errors.length;
  const cur = ins.current || [];
  const ul = (items) => items.length ? h('ul', { class: 'ev' }, items.map((t) => h('li', {}, t))) : null;
  const authEvents = (a.recent || []).slice(0, 8).map((e) => `${e.date} · ${e.kind}${e.docket ? ' · ' + e.docket : ''}`);
  const insEvents = (ins.events || []).slice(0, 8).map((e) => `${e.date} · ${e.kind} · ${e.type}${e.insurer ? ' · ' + e.insurer : ''}`);
  const dockets = (a.dockets || []).map((x) => [x.docket, x.type, x.status, x.changed ? 'since ' + x.changed : '', x.reason].filter(Boolean).join(' · '));
  const gaps = ['bipd', 'bond'].flatMap((k) => ((ins[k] && ins[k].gaps) || []).map((g) => `${k === 'bipd' ? 'Liability' : 'Bond'} filing gap ${g.from} to ${g.to} (${g.days} days)`));
  return section('Authority and insurance history', a.firstGranted ? 'since ' + a.firstGranted : '', false,
    h('dl', {},
      row('First authority granted', a.firstGranted),
      row('Last revocation', a.lastRevoked),
      row('Last reinstatement', a.lastReinstated),
      row('Revocation notices (24 mo)', a.notices24 || null)),
    dockets.length ? [h('h4', {}, 'Dockets (new registration system)'), ul(dockets)] : null,
    authEvents.length ? [h('h4', {}, 'Recent authority events'), ul(authEvents)] : null,
    cur.length ? [h('h4', {}, 'Insurance filings on record'),
      ul(cur.map((p) => [p.type, p.insurer, money(p.coverage), p.effective ? 'effective ' + p.effective : '', p.cancelsOn ? 'cancels ' + p.cancelsOn : ''].filter(Boolean).join(' · ')))] : null,
    gaps.length ? [h('h4', {}, 'Gaps between filings'), ul(gaps)] : null,
    insEvents.length ? [h('h4', {}, 'Recent insurance events'), ul(insEvents)] : null,
    h('p', { class: 'fine' },
      'Built from FMCSA licensing and insurance datasets. Dates are filing dates, not proof of actual coverage, and the current-policy data can be incomplete; the live FMCSA check above is authoritative. ',
      'Older insurance history covers cancellations from 2024 onward. ',
      partial ? `Some history sources failed to load (${hist.errors.join(', ')}).` : ''));
}

const SOS = {
  CA: 'https://bizfileonline.sos.ca.gov/search/business',
  FL: 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName',
  NY: 'https://apps.dos.ny.gov/publicInquiry/',
  DE: 'https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx',
  TX: 'https://www.sos.state.tx.us/corp/sosda/index.shtml',
};

function renderOwnership(c) {
  const name = c.legalName;
  const st = c.state;
  const q = encodeURIComponent(name);
  const links = [];
  if (st && SOS[st]) links.push([`${st} Secretary of State business search`, SOS[st]]);
  else if (st) links.push([`${st} Secretary of State business search`, 'https://duckduckgo.com/?q=' + encodeURIComponent(`${st} secretary of state business entity search`)]);
  links.push(['OpenCorporates' + (st ? ` (${st})` : ''), `https://opencorporates.com/companies?q=${q}` + (st ? `&jurisdiction_code=us_${st.toLowerCase()}` : '')]);
  return section('Who owns this company?', 'state registry', false,
    h('p', { class: 'fine', style: 'margin-top:4px' }, 'FMCSA does not list owners. Search the state business registry for the legal name, then check the formation date, status, registered agent and managers.'),
    h('ul', { class: 'ev' }, links.map(([t, u]) => h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, t + ' ', ic('ext'))))),
    h('p', { class: 'fine' }, 'Search for: ', h('b', {}, name), '. The company may be registered in a different state than its FMCSA address. Many LLCs list only a registered agent, and a name match is a lead, not proof.'));
}

function ratingChip(r) {
  const bad = /^unsat/i.test(r), na = /^not appl/i.test(r) || !r;
  return h('span', { class: 'chip ' + (bad ? 'I' : '') , style: na ? 'opacity:.6' : '' }, r || '-');
}

function renderChp(chp, page) {
  const i = chp.inspections;
  const link = h('a', { href: page, target: '_blank', rel: 'noopener noreferrer' }, ['CHP Carrier Inspection Results ', ic('ext')]);
  const ids = [
    h('b', {}, 'CA ' + chp.ca), chp.status ? ' \xB7 ' + chp.status : '',
    chp.calT ? ' \xB7 Cal-T ' + chp.calT : '', chp.psc ? ' \xB7 PSC ' + chp.psc : '',
  ];
  const body = !i
    ? h('p', { class: 'fine' }, 'Inspection results did not load. Try again, or open the ', link, '.')
    : [
      h('p', { class: 'fine', style: 'margin:6px 0 2px' },
        i.terminalCount ? `${i.terminalCount} California terminal${i.terminalCount === 1 ? '' : 's'} \xB7 ${i.inspectionCount} inspection${i.inspectionCount === 1 ? '' : 's'}` +
          (i.lastInspection ? `, latest ${i.lastInspection}` : '') + (i.terminalUnsatisfactory ? ` \xB7 ${i.terminalUnsatisfactory} with an unsatisfactory terminal rating` : '')
          : 'No terminal inspections on file.'),
      i.csat.length ? h('p', { class: 'fine', style: 'margin:2px 0' }, 'Drug and alcohol testing (CSAT) audits: ',
        i.csat.slice(0, 3).map((r, k) => [k ? ', ' : '', r.date + ' ', ratingChip(r.rating)])) : null,
      i.terminals.map((t) => h('details', { style: 'margin-top:6px' },
        h('summary', {}, `Terminal ${t.id || ''} \xB7 ${t.location || ''}${t.status ? ' \xB7 ' + t.status : ''} (${t.inspectionCount})`),
        h('ul', { class: 'ev' }, t.inspections.map((r) => h('li', {}, r.date + ' \xB7 ' + (r.category || 'Inspection') + ' \xB7 terminal ', ratingChip(r.terminal),
          ' maintenance ', ratingChip(r.maintenance), ' equipment ', ratingChip(r.equipment), ' driver ', ratingChip(r.driver)))))),
      h('p', { class: 'fine' }, 'Source: ', link, '. Ratings come from CHP terminal inspections and are a lead to review, not a finding.'),
    ];
  return [h('p', { style: 'margin:4px 0 0' }, ids), body];
}

function renderCa(ca) {
  if (!ca) return null;
  const link = h('a', { href: ca.page, target: '_blank', rel: 'noopener noreferrer' }, ['DMV Active Motor Carriers list ', ic('ext')]);
  const permit = (p) => h('li', {}, [
    h('b', {}, 'CA ' + p.ca), ' \xB7 ', p.name, p.dba ? ' \xB7 DBA ' + p.dba : '', p.phone ? ' \xB7 ' + p.phone : '',
    p.phoneMatch === true ? ' (phone matches FMCSA)' : p.phoneMatch === false ? ' (phone differs from FMCSA)' : '',
    p.liabilityInsurer ? h('div', { class: 'fine', style: 'margin:2px 0 0' }, 'Liability: ' + p.liabilityInsurer + (p.workersCompInsurer ? ' \xB7 Workers comp: ' + p.workersCompInsurer : '')) : null,
  ]);
  return section('California Motor Carrier Permit', ca.chp ? 'CA ' + ca.chp.ca : ca.found ? 'permit found' : 'not found', false,
    ca.chp ? renderChp(ca.chp, ca.chpPage) : null,
    ca.available === false
      ? h('p', { class: 'fine', style: 'margin-top:4px' }, 'The DMV permit list did not respond, so this was not checked. Try again, or search the ', link, '.')
      : ca.found
        ? [h('ul', { class: 'ev' }, ca.permits.map(permit)),
           h('p', { class: 'fine' }, ca.chp ? 'Permit details from the DMV list of active permits, matched on the CA number.' : 'Matched on the exact legal name in the DMV list of active permits. A same-name match is not proof it is the same company; compare the phone and address.')]
        : ca.chp ? h('p', { class: 'fine', style: 'margin-top:4px' }, 'Not found in the DMV active permit list, so the permit may be inactive or expired. Check the ', link, '.')
        : h('p', { class: 'fine', style: 'margin-top:4px' }, (ca.chpDown ? 'The CHP inspection site did not respond. ' : 'Not found in the CHP inspection records. ') + 'No active permit found under this exact legal name. That does not mean there is none: the DMV may list the company under a slightly different name, and out-of-state or non-property carriers may not need one. Search the ', link, ' to check.'));
}

function renderCarrier(d) {
  const c = d.carrier;
  const [title, blurb] = LEVELS[d.level];
  const mcs = c.dockets.map((x) => x.prefix + x.number + (x.status && x.status !== 'A' ? ` (${x.statusLabel})` : ''));
  const live = d.live;
  fillStrip(c, d.level, title);
  return [
    h('div', { class: 'verdict', id: 'verdict' },
    h('div', { class: 'card head' },
      h('h2', {}, c.legalName),
      c.dbaName ? h('div', { class: 'dba' }, 'DBA ' + c.dbaName) : null,
      h('div', { class: 'ids' },
        h('span', { class: 'chip ' + c.status }, c.statusLabel),
        h('span', { class: 'chip' }, 'DOT ' + c.dot),
        c.dockets.map((x) => h('span', { class: 'chip ' + (x.status || '') }, x.prefix + x.number)))),
    h('div', { class: 'level ' + d.level }, h('span', { class: 'lic' }, ic(LEVEL_ICON[d.level])), h('b', {}, title), h('span', { class: 't' }, blurb))),
    h('div', { class: 'tools-row' }, h('button', { class: 'link', type: 'button', onclick: toggleAll }, ic('layers'), 'Expand or collapse all')),
    section('Signals', d.signals.length ? d.signals.length + (d.signals.length === 1 ? ' signal' : ' signals') : 'none', true,
      d.signals.length ? d.signals.map(signal) : h('p', { class: 'fine' }, 'No signals to report.')),
    renderHistory(d.history),
    renderOwnership(c),
    renderCa(d.ca),
    section('Census record', c.powerUnits != null ? c.powerUnits + ' power units' : '', true,
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
  if (!d.matches.length && !d.dmv) return h('div', { class: 'card' }, `No carriers matched "${d.query}".`);
  const dmv = d.dmv && h('p', { style: 'margin:0 0 8px' }, h('b', {}, 'CA ' + d.dmv.ca), ' \xB7 ', d.dmv.name, d.dmv.dba ? ' \xB7 DBA ' + d.dmv.dba : '', d.dmv.phone ? ' \xB7 ' + d.dmv.phone : '');
  return h('div', { class: 'card' },
    dmv,
    h('p', { class: 'fine', style: d.dmv ? 'margin-top:0' : '' }, d.reverse === 'ca'
      ? (d.matches.length ? 'California permit found. These FMCSA records share its name or phone, pick one:' : 'California permit found, but no FMCSA record shares its name or phone.')
      : d.reverse
      ? `${d.total > 50 ? '50+' : d.total} carrier${d.total === 1 ? '' : 's'} on file with this ${d.reverse}${d.inactive ? ` (${d.inactive} inactive)` : ''}. Pick one:`
      : `${d.matches.length}${d.matches.length === 25 ? '+' : ''} matches. Pick one:`),
    h('ul', { class: 'matches' }, d.matches.map((m) =>
      h('li', {}, h('button', { class: 'link', type: 'button', onclick: () => run(String(m.dot), 'dot') }, carrierLine(m))))));
}

function errCard(msg, retry, q, type) {
  return h('div', { class: 'card err' }, msg, retry ? [' ', h('button', { class: 'link', type: 'button', onclick: () => run(q, type) }, 'Retry')] : null);
}

async function run(q, type) {
  $('#q').value = q;
  $('#t').value = type || 'auto';
  const go = $('#go');
  go.disabled = true;
  const out = $('#out');
  out.replaceChildren(h('p', { class: 'fine' }, 'Searching…'));
  strip.replaceChildren();
  document.body.classList.remove('pinned');
  try {
    const res = await fetch('/api/lookup?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type || 'auto'));
    const d = await res.json();
    if (!res.ok) { out.replaceChildren(errCard(d.error || 'Something went wrong.', res.status >= 500, q, type)); return; }
    out.replaceChildren(...[].concat(d.stale ? h('p', { class: 'fine', style: 'margin-top:0' }, 'Live data is temporarily unavailable. Showing the last saved result, which may be out of date.') : null, d.mode === 'list' ? renderList(d) : renderCarrier(d)).filter(Boolean));
    document.body.classList.add('has-out');
    armReveal();
    const u = new URL(location.href);
    u.searchParams.set('q', q);
    u.searchParams.set('type', type || 'auto');
    history.replaceState(null, '', u);
  } catch {
    out.replaceChildren(errCard('Network error.', true, q, type));
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

// The brand starts a clean session: clear the box, results and URL state.
function reset() {
  $('#q').value = '';
  $('#t').value = pageType;
  $('#out').replaceChildren();
  strip.replaceChildren();
  document.body.classList.remove('pinned', 'has-out');
  const u = new URL(location.href);
  u.search = '';
  history.replaceState(null, '', u);
  window.scrollTo(0, 0);
  $('#q').focus();
}
$('#brand').addEventListener('click', reset);

// Once the verdict scrolls out of view it condenses into the strip under the header.
let tick = false;
function updatePin() {
  tick = false;
  const v = document.getElementById('verdict');
  if (!v) { document.body.classList.remove('pinned'); return; }
  const bottom = v.getBoundingClientRect().bottom;
  const on = document.body.classList.contains('pinned');
  if (!on && bottom < 70) document.body.classList.add('pinned');
  else if (on && bottom > 110) document.body.classList.remove('pinned');
}
addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(updatePin); } }, { passive: true });
strip.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });

function fillStrip(c, level, title) {
  strip.replaceChildren(h('span', { class: 'lv ' + level, title }), h('b', {}, c.legalName),
    h('span', { class: 'chip ' + c.status }, c.statusLabel), h('span', { class: 'chip' }, 'DOT ' + c.dot), h('span', { class: 'up' }, 'Back to top', ic('up')));
}
function toggleAll() {
  const all = [...document.querySelectorAll('#out details.sec')];
  const open = all.some((d) => !d.open);
  all.forEach((d) => { d.open = open; });
}
const init = new URL(location.href).searchParams;
if (init.get('q')) run(init.get('q'), init.get('type') || pageType);
