// Cloudflare Worker: FMCSA carrier lookup + cross-reference. Stateless; no database.
//   GET /api/lookup?q=<DOT|MC|name>&type=auto|dot|mc|name
//   GET /api/health
// Static UI is served from ./public by the assets binding.

import {
  clean, digits, soqlStr, fmtPhone, normPhone, splitStreet, normalizeCarrier, brief, matchAddresses, buildSignals, buildHistory, statusLabel,
  parseDmvPermits, padCa, normName, parseChpSearch, parseChpTerminal, summarizeChp, normalizeDl, bulkRow, parseDots,
} from './lib.js';

const SODA = 'https://data.transportation.gov/resource/';
const CENSUS = 'az4n-8mr2';
const DMV_CSV = 'https://analytics.dmv.ca.gov/t/TableauProduction01/views/ActiveMCPPermitSearch/SearchResults.csv';
const CHP = 'https://carriersafety.chp.ca.gov';
const CHP_UA = { 'user-agent': 'Dotty carrier lookup (dotty.cleverghosts.com)' };
const DL = 'https://api.dotlookup.dev/v1';
const DMV_PAGE = 'https://www.dmv.ca.gov/portal/vehicle-industry-services/motor-carrier-services-mcs/motor-carrier-permits/active-motor-carriers/';

// Authority and insurance history. FMCSA moved to a new registration system (Motus) on 2026-05-14:
// the legacy datasets are frozen at that date and the Motus ones continue from it.
const DS = {
  authLegacy: '9mw4-x3tu', authMotus: 'yu5v-wbh6',
  insLegacy: 'ypjt-5ydn', insMotus: 'c5y8-a4uz',
  histLegacy: '6sqe-dvqs', histMotus: '3uet-3z4i',
};

const BRIEF_FIELDS = [
  'dot_number', 'legal_name', 'dba_name', 'status_code', 'phy_street', 'phy_city', 'phy_state', 'phy_zip',
  'docket1prefix', 'docket1', 'docket1_status_code', 'docket2prefix', 'docket2', 'docket2_status_code',
  'docket3prefix', 'docket3', 'docket3_status_code', 'power_units',
].join(',');

const FULL_FIELDS = [
  BRIEF_FIELDS, 'phone', 'cell_phone', 'email_address', 'total_drivers', 'mcs150_date', 'safety_rating',
  'safety_rating_date', 'carrier_operation', 'company_officer_1', 'company_officer_2',
  'prior_revoke_flag', 'prior_revoke_dot_number',
].join(',');

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

// Socrata latency is erratic, so every query gets a short timeout and one retry.
async function soda(env, params, { timeout = 8000, retries = 1, dataset = CENSUS } = {}) {
  const url = new URL(`${SODA}${dataset}.json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = env.SOCRATA_APP_TOKEN;
  let err;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (res.ok) return await res.json();
      err = new Error(`Census ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

// ---- Query parsing -------------------------------------------------------

export function parseQuery(q, type = 'auto') {
  const s = clean(q);
  let m;
  if (type === 'dot' || (type === 'auto' && (m = s.match(/^(?:USDOT|DOT)[\s#:-]*(\d{1,8})$/i)))) {
    const n = digits(m ? m[1] : s);
    return n ? { kind: 'dot', value: n } : { kind: 'bad' };
  }
  if (type === 'mc' || (type === 'auto' && (m = s.match(/^(MC|MX|FF)[\s#:-]*(\d{1,8})$/i)))) {
    const prefix = m ? m[1].toUpperCase() : (s.match(/^(MC|MX|FF)/i) || [])[1]?.toUpperCase() || 'MC';
    const n = digits(m ? m[2] : s).replace(/^0+/, '');
    return n ? { kind: 'docket', prefix, value: n } : { kind: 'bad' };
  }
  if (type === 'ca' || (type === 'auto' && (m = s.match(/^CA[\s#:-]*(\d{1,7})$/i)))) {
    const n = digits(m ? m[1] : s);
    return n && n.length <= 7 ? { kind: 'ca', value: padCa(n) } : { kind: 'bad' };
  }
  const emailRe = /^[^\s@'"]+@[^\s@'"]+\.[A-Za-z]{2,}$/;
  if (type === 'email' || (type === 'auto' && emailRe.test(s))) {
    return emailRe.test(s) ? { kind: 'email', value: s.toLowerCase() } : { kind: 'bad' };
  }
  if (type === 'phone' || (type === 'auto' && /^[\d\s().+-]+$/.test(s) && digits(s).length >= 10)) {
    const ph = normPhone(s);
    return ph ? { kind: 'phone', value: ph } : { kind: 'bad' };
  }
  if (type === 'address') {
    const zip = (s.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1];
    const street = splitStreet(s.replace(/\b\d{5}(?:-\d{4})?\s*$/, '').replace(/,.*$/, '')).street;
    return zip && /^\d+\s/.test(street) ? { kind: 'address', value: street, zip } : { kind: 'bad' };
  }
  if (type === 'auto' && /^\d{1,8}$/.test(s)) return { kind: 'number', value: s.replace(/^0+/, '') || '0' };
  // Names: keep a conservative character set (also keeps WAF-triggering junk like "--" or "=" away from Socrata).
  const name = s.replace(/[^A-Za-z0-9 &.,'\/#()-]/g, ' ').replace(/-{2,}/g, '-').replace(/\s+/g, ' ').trim();
  if (name.replace(/[^A-Za-z0-9]/g, '').length >= 3) return { kind: 'name', value: name };
  return { kind: 'bad' };
}

// One filtered request to the DMV's public dashboard export. Filters are exact-match on the dashboard's
// own field names. Rows are re-checked here because a wrong field name silently returns an unfiltered page.
async function dmvPermits(env, field, value) {
  const url = `${DMV_CSV}?${encodeURIComponent(field)}=${encodeURIComponent(value)}`;
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, {
        headers: { accept: 'text/csv', 'user-agent': 'Dotty carrier lookup (dotty.cleverghosts.com)' },
        signal: AbortSignal.timeout(7000),
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (res.ok || (res.status < 500 && res.status !== 429)) break;
    } catch (e) {
      if (attempt) throw e;
    }
  }
  if (!res || !res.ok) throw new Error(`DMV ${res ? res.status : 'unreachable'}`);
  const rows = parseDmvPermits(await res.text());
  return field === 'CA number' ? rows.filter((r) => r.ca === value) : rows.filter((r) => normName(r.name) === normName(value));
}

// CHP Carrier Inspection Results. The search form needs a per-session anti-forgery token and cookie, so
// load the page, then post the search. The inspection endpoint takes a plain POST.
async function chpSearch(type, value) {
  const home = await fetch(CHP + '/', { headers: CHP_UA, signal: AbortSignal.timeout(7000) });
  if (!home.ok) throw new Error(`CHP ${home.status}`);
  const html = await home.text();
  const token = (html.match(/name="__RequestVerificationToken"[^>]*?value="([^"]+)"/) || [])[1];
  const ip = (html.match(/name="Parameters\.UserIPAddress"[^>]*?value="([^"]*)"/) || [])[1] || '';
  if (!token) throw new Error('CHP form changed');
  const cookie = (home.headers.getSetCookie ? home.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  const body = new URLSearchParams({
    ViewName: 'SearchCarrier', __RequestVerificationToken: token, 'Parameters.UserIPAddress': ip,
    'Parameters.IdentifierType': type, 'Parameters.Identifier': String(value).replace(/^0+(?=\d)/, ''),
    'Parameters.IdentifierSearchType': 'E', 'Parameters.BusinessName': '', 'Parameters.BusinessNameSearchType': 'E',
    'Parameters.Address': '', 'Parameters.AddressSearchType': 'E', 'Parameters.City': '', 'Parameters.Country': '', 'Parameters.State': '',
  });
  const res = await fetch(CHP + '/Home/SearchCarrier', {
    method: 'POST', body, signal: AbortSignal.timeout(8000),
    headers: { ...CHP_UA, 'content-type': 'application/x-www-form-urlencoded', cookie, referer: CHP + '/' },
  });
  if (!res.ok) throw new Error(`CHP ${res.status}`);
  const text = await res.text();
  if (!text.includes('tableSearchCarrier') && !/no (records|results|carriers)/i.test(text) && !text.includes('Parameters_Identifier')) throw new Error('CHP unexpected response');
  return parseChpSearch(text);
}

async function chpRetry(type, value) {
  try { return await chpSearch(type, value); } catch { return chpSearch(type, value); }
}

async function chpInspections(ca) {
  const res = await fetch(CHP + '/Home/TerminalResult', {
    method: 'POST', body: new URLSearchParams({ canbr: String(ca) }), signal: AbortSignal.timeout(8000),
    headers: { ...CHP_UA, 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' },
  });
  if (!res.ok) throw new Error(`CHP ${res.status}`);
  return summarizeChp(parseChpTerminal(await res.text()));
}

async function caForCarrier(env, c, chpRow) {
  if (c.state !== 'CA' && !chpRow) return null;
  const out = { available: true, found: false, permits: [], page: DMV_PAGE, chp: null, chpPage: CHP + '/' };
  if (!chpRow) { try { chpRow = (await chpRetry('DOT', c.dot)).find((r) => r.dot === String(c.dot)); } catch { out.chpDown = true; } }
  if (chpRow) {
    const [insp, dmv] = await Promise.all([
      chpInspections(chpRow.ca).catch(() => null),
      dmvPermits(env, 'CA number', padCa(chpRow.ca)).catch(() => null),
    ]);
    out.chp = { ...chpRow, inspections: insp, inspectionsDown: !insp };
    if (dmv && dmv.length) { out.found = true; out.permits = dmv.slice(0, 5).map((p) => ({ ...p, phoneMatch: p.phone ? [c.phone, c.cell].filter(Boolean).includes(p.phone) : null })); }
    return out;
  }
  if (c.state !== 'CA') return null;
  try {
    const phones = new Set([c.phone, c.cell].filter(Boolean));
    const permits = (await dmvPermits(env, 'Legal Name', c.legalName)).slice(0, 5)
      .map((p) => ({ ...p, phoneMatch: p.phone ? phones.has(p.phone) : null }));
    return { ...out, found: permits.length > 0, permits };
  } catch {
    return { available: false, page: DMV_PAGE, chpDown: out.chpDown || false, chpPage: out.chpPage };
  }
}

async function byExactName(env, name) {
  const n = soqlStr(name.toUpperCase());
  const rows = await soda(env, { $select: BRIEF_FIELDS, $where: `upper(legal_name)=${n} OR upper(dba_name)=${n}`, $order: 'legal_name', $limit: '25' });
  return rows.map((r) => brief(normalizeCarrier(r)));
}

async function reverse(env, p) {
  let where;
  if (p.kind === 'phone') where = `phone=${soqlStr(p.value)} OR cell_phone=${soqlStr(p.value)}`;
  else if (p.kind === 'email') where = `upper(email_address)=${soqlStr(p.value.toUpperCase())}`;
  else where = `phy_zip like ${soqlStr(p.zip + '%')} AND upper(phy_street) like ${soqlStr(p.value.replace(/[%_]/g, ' ') + '%')}`;
  const rows = await soda(env, { $select: BRIEF_FIELDS, $where: where, $order: 'legal_name', $limit: '51' });
  return rows.map((r) => brief(normalizeCarrier(r)));
}

const byDot = (env, dot) => soda(env, { $select: FULL_FIELDS, $where: `dot_number=${Number(dot)}`, $limit: '1' });

const byDocket = (env, prefix, num) =>
  soda(env, {
    $select: FULL_FIELDS,
    $where: [1, 2, 3].map((i) => `(docket${i}prefix=${soqlStr(prefix)} AND docket${i}=${soqlStr(num)})`).join(' OR '),
    $limit: '1',
  });

async function byName(env, name) {
  const pat = soqlStr(`%${name.toUpperCase().replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim()}%`);
  const nameMatch = `(upper(legal_name) like ${pat} OR upper(dba_name) like ${pat})`;
  let rows = await soda(env, { $select: BRIEF_FIELDS, $where: `${nameMatch} AND status_code='A'`, $order: 'legal_name', $limit: '25' });
  if (!rows.length) rows = await soda(env, { $select: BRIEF_FIELDS, $where: nameMatch, $order: 'legal_name', $limit: '25' });
  return rows;
}

// ---- Live FMCSA (QCMobile): optional enrichment --------------------------

async function qcCarrier(env, dot) {
  if (!env.FMCSA_WEB_KEY) return { available: false, reason: 'not_configured' };
  const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${Number(dot)}?webKey=${encodeURIComponent(env.FMCSA_WEB_KEY)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), cf: { cacheTtl: 21600, cacheEverything: true } });
    if (res.status === 404) return { available: true, found: false };
    if (!res.ok) return { available: false, reason: `http_${res.status}` };
    const j = await res.json();
    const c = j?.content?.carrier ?? j?.content?.[0]?.carrier ?? null;
    if (!c) return { available: true, found: false };
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
    return {
      available: true,
      found: true,
      allowedToOperate: clean(c.allowedToOperate).toUpperCase() || null,
      oosDate: clean(c.oosDate) || null,
      bipdOnFile: num(c.bipdInsuranceOnFile),
      bipdRequired: num(c.bipdRequiredAmount),
      safetyRating: clean(c.safetyRating) || null,
      crashTotal: num(c.crashTotal),
      vehicleOosRate: num(c.vehicleOosRate),
      driverOosRate: num(c.driverOosRate),
      vehicleOosAvg: num(c.vehicleOosRateNationalAverage),
      driverOosAvg: num(c.driverOosRateNationalAverage),
      vehicleInsp: num(c.vehicleInsp),
      driverInsp: num(c.driverInsp),
    };
  } catch {
    return { available: false, reason: 'timeout_or_network' };
  }
}

// ---- DotLookup: risk score, risk history, inspections, related carriers ----
// Works without a key at a shared rate limit; DOTLOOKUP_KEY (optional secret) raises it and enables bulk.

async function dlFetch(env, path, init = {}) {
  const headers = { accept: 'application/json', ...(init.headers || {}) };
  if (env.DOTLOOKUP_KEY) headers['x-api-key'] = env.DOTLOOKUP_KEY;
  return fetch(DL + path, { ...init, headers, signal: AbortSignal.timeout(9000) });
}

async function dlCarrier(env, dot) {
  const get = async (path) => {
    const res = await dlFetch(env, path, { cf: { cacheTtl: 21600, cacheEverything: true } });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error('http_' + res.status);
    return { json: await res.json() };
  };
  try {
    const [c, h] = await Promise.all([get(`/carriers/${Number(dot)}`), get(`/carriers/${Number(dot)}/risk-history?limit=12`).catch(() => ({}))]);
    if (c.notFound) return { available: true, found: false };
    return normalizeDl(c.json, h.json && h.json.data) || { available: false, reason: 'bad_response' };
  } catch (e) {
    return { available: false, reason: 'timeout_or_network' };
  }
}

async function bulkCheck(env, dots) {
  const res = await dlFetch(env, '/carriers/bulk', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dot_numbers: dots }),
  });
  if (!res.ok) throw new Error('http_' + res.status);
  const arr = await res.json();
  const byDot = new Map((Array.isArray(arr) ? arr : []).map((c) => [String(Number(c.dot_number)), c]));
  const now = new Date();
  return {
    rows: dots.filter((d) => byDot.has(d)).map((d) => bulkRow(byDot.get(d), now)),
    notFound: dots.filter((d) => !byDot.has(d)),
  };
}

// ---- Cross-reference (Census, filtered server-side by Socrata) -----------

async function crossRef(env, c) {
  const errors = [];
  const safe = async (label, p) => {
    try { return await p; } catch { errors.push(label); return []; }
  };
  const own = `dot_number != ${c.dot}`;
  const list = (xs) => xs.map(soqlStr).join(',');
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const toBrief = (rows) => rows.map((r) => brief(normalizeCarrier(r)));

  const phones = uniq([c.phone, c.cell]);
  const names = uniq([c.legalName, c.dbaName].map((n) => n.toUpperCase())).filter((n) => n.length >= 4);
  const num = (c.street.match(/^\d+/) || [])[0];
  const zip5 = c.zip.slice(0, 5);
  const canAddr = num && /^\d{5}$/.test(zip5);

  const [phone, addr, name, officer, email, prior] = await Promise.all([
    phones.length
      ? safe('phone', soda(env, { $select: BRIEF_FIELDS, $limit: '51',
          $where: `(phone in (${list(phones)}) OR cell_phone in (${list(phones)})) AND ${own}` }))
      : [],
    canAddr
      ? safe('address', soda(env, { $select: BRIEF_FIELDS, $limit: '300',
          $where: `phy_zip like ${soqlStr(zip5 + '%')} AND phy_street like ${soqlStr(num + '%')} AND ${own}` }))
      : [],
    names.length
      ? safe('name', soda(env, { $select: BRIEF_FIELDS, $limit: '51',
          $where: `(upper(legal_name) in (${list(names)}) OR upper(dba_name) in (${list(names)})) AND ${own}` }))
      : [],
    c.officers.length && c.state
      ? safe('officer', soda(env, { $select: BRIEF_FIELDS, $limit: '51',
          $where: `(upper(company_officer_1) in (${list(c.officers)}) OR upper(company_officer_2) in (${list(c.officers)})) AND phy_state=${soqlStr(c.state)} AND ${own}` }))
      : [],
    c.email
      ? safe('email', soda(env, { $select: BRIEF_FIELDS, $limit: '51',
          $where: `upper(email_address)=${soqlStr(c.email.toUpperCase())} AND ${own}` }))
      : [],
    c.priorRevoke.flag && c.priorRevoke.dot
      ? safe('prior', soda(env, { $select: BRIEF_FIELDS, $where: `dot_number=${Number(c.priorRevoke.dot)}`, $limit: '1' }))
      : [],
  ]);

  const addrRows = addr.map(normalizeCarrier);
  const { same, building } = matchAddresses(c, addrRows);
  const cut = (xs) => xs.slice(0, 50);

  return {
    errors,
    truncated: { phone: phone.length > 50, name: name.length > 50, email: email.length > 50, officer: officer.length > 50 },
    phone: toBrief(cut(phone)),
    address: { same: same.map(brief), building: building.map(brief) },
    name: toBrief(cut(name)),
    officer: toBrief(cut(officer)),
    email: toBrief(cut(email)),
    priorRevoke: prior[0] ? brief(normalizeCarrier(prior[0])) : null,
  };
}

// ---- Authority + insurance history ---------------------------------------

async function historyData(env, c) {
  const errors = [];
  const safe = async (label, p) => {
    try { return await p; } catch { errors.push(label); return []; }
  };
  const dot8 = String(c.dot).padStart(8, '0');
  const dotS = String(c.dot);
  const legacyDockets = c.dockets.filter((d) => /^[A-Z]{2}$/.test(d.prefix)).map((d) => `${d.prefix}${d.number.padStart(6, '0')}`);
  const since = ['2024', '2025', '2026'].map((y) => `cancl_effective_date like '%/${y}'`).join(' OR ');
  const q = (dataset, where, select, limit = '300') => soda(env, { $select: select, $where: where, $limit: limit }, { dataset });

  const [authLegacy, authMotus, insNowLegacy, insNowMotus, insHistLegacy, insHistMotus] = await Promise.all([
    safe('auth-legacy', q(DS.authLegacy, `dot_number=${soqlStr(dot8)}`,
      'docket_number,original_action_desc,orig_served_date,disp_action_desc,disp_decided_date,disp_served_date')),
    safe('auth', q(DS.authMotus, `usdot_number=${soqlStr(dotS)}`, 'docket_number,op_auth_type,op_auth_status,reason,status_change_date', '100')),
    legacyDockets.length
      ? safe('ins-legacy', q(DS.insLegacy, `prefix_docket_number in (${legacyDockets.map(soqlStr).join(',')})`,
          'ins_type_code,ins_form_code,max_cov_amount,policy_no,effective_date,name_company', '100'))
      : [],
    safe('ins', q(DS.insMotus, `usdot_number=${soqlStr(dotS)}`,
      'ins_type_code,ins_form_code,max_cov_amount,policy_no,effective_date,insurance_company_name', '100')),
    safe('ins-hist-legacy', q(DS.histLegacy, `dot_number=${soqlStr(dot8)} AND (${since})`,
      'ins_form_code,cancl_method,policy_no,effective_date,cancl_effective_date,name_company')),
    safe('ins-hist', q(DS.histMotus, `usdot_number=${soqlStr(dotS)}`,
      'ins_type_code,ins_type_desc,filing_status_reason,policy_no,effective_date,cancl_effective_date,insurance_company_name')),
  ]);

  return buildHistory({ authLegacy, authMotus, insNowLegacy, insNowMotus, insHistLegacy, insHistMotus, errors });
}

// ---- Orchestration -------------------------------------------------------

async function lookup(env, rawQ, type) {
  const q = clean(rawQ).slice(0, 80);
  if (!q) return { status: 400, body: { error: 'Enter a DOT number, MC number, company name, phone, email or address.' } };
  const p = parseQuery(q, type);
  if (p.kind === 'bad') return { status: 400, body: { error: 'Could not read that. Try a DOT number, an MC number like MC123456, a phone, an email, or at least 3 letters of a name.' } };

  if (p.kind === 'phone' || p.kind === 'email' || p.kind === 'address') {
    const all = await reverse(env, p);
    const matches = all.slice(0, 50);
    return {
      status: 200,
      cacheable: true,
      body: {
        mode: 'list',
        query: q,
        reverse: p.kind,
        total: all.length,
        truncated: all.length > 50,
        inactive: matches.filter((m) => m.status !== 'A').length,
        matches,
      },
    };
  }

  let rows = [];
  let searchedAs = p.kind;
  let preCa = null;
  let chpRow = null;
  if (p.kind === 'ca') {
    try { chpRow = (await chpRetry('CARRIER', p.value)).find((r) => r.ca === p.value.replace(/^0+(?=\d)/, '') && r.dot) || null; } catch { chpRow = null; }
  }
  if (chpRow) {
    rows = await byDot(env, chpRow.dot);
    searchedAs = 'ca';
  } else if (p.kind === 'ca') {
    let permit;
    try { [permit] = await dmvPermits(env, 'CA number', p.value); } catch {
      return { status: 502, body: { error: 'The California DMV permit list is not responding. Try again in a minute.' } };
    }
    if (!permit) return { status: 404, body: { error: `No active California Motor Carrier Permit found for CA number ${p.value}. It may be inactive or expired.`, searchedAs: 'ca' } };
    const [byPhone, byName] = await Promise.all([
      permit.phone ? reverse(env, { kind: 'phone', value: permit.phone }).catch(() => []) : [],
      byExactName(env, permit.name).catch(() => []),
    ]);
    const seen = new Map();
    for (const m of [...byName, ...byPhone]) if (!seen.has(m.dot)) seen.set(m.dot, m);
    const all = [...seen.values()];
    const strong = all.filter((m) => normName(m.name) === normName(permit.name) || (m.dba && normName(m.dba) === normName(permit.name)));
    if (strong.length === 1) {
      rows = await byDot(env, strong[0].dot);
      searchedAs = 'ca';
      preCa = { available: true, found: true, permits: [{ ...permit, phoneMatch: true }], page: DMV_PAGE };
      preCa.permits[0].phoneMatch = permit.phone ? [normalizeCarrier(rows[0] || {}).phone, normalizeCarrier(rows[0] || {}).cell].includes(permit.phone) : null;
    } else {
      return {
        status: 200,
        cacheable: true,
        body: {
          mode: 'list', query: q, reverse: 'ca', total: all.length, truncated: false,
          inactive: all.filter((m) => m.status !== 'A').length, matches: all.slice(0, 50),
          dmv: { ...permit, page: DMV_PAGE },
        },
      };
    }
  } else if (p.kind === 'dot') rows = await byDot(env, p.value);
  else if (p.kind === 'docket') rows = await byDocket(env, p.prefix, p.value);
  else if (p.kind === 'number') {
    rows = await byDot(env, p.value);
    searchedAs = 'dot';
    if (!rows.length) { rows = await byDocket(env, 'MC', p.value); searchedAs = 'mc'; }
  } else {
    const matches = await byName(env, p.value);
    if (matches.length !== 1) {
      return {
        status: 200,
        body: { mode: 'list', query: q, matches: matches.map((r) => brief(normalizeCarrier(r))) },
        cacheable: true,
      };
    }
    rows = await byDot(env, matches[0].dot_number);
    searchedAs = 'name';
  }

  if (!rows.length) return { status: 404, body: { error: `No FMCSA record found for "${q}".`, searchedAs } };

  const carrier = normalizeCarrier(rows[0]);
  const [xref, qc, history, ca, dl] = await Promise.all([
    crossRef(env, carrier), qcCarrier(env, carrier.dot), historyData(env, carrier), preCa ? preCa : caForCarrier(env, carrier, chpRow), dlCarrier(env, carrier.dot),
  ]);
  const { signals, level } = buildSignals({ carrier, qc, xref, history });

  const partial = xref.errors.length > 0 || history.errors.length > 0 || (!qc.available && qc.reason !== 'not_configured') || (ca && ca.available === false) || dl.available === false;
  return {
    status: 200,
    cacheable: !partial,
    body: {
      mode: 'carrier',
      query: q,
      searchedAs,
      level,
      carrier: {
        dot: carrier.dot,
        legalName: carrier.legalName,
        dbaName: carrier.dbaName || null,
        status: carrier.status,
        statusLabel: statusLabel(carrier.status),
        dockets: carrier.dockets.map((d) => ({ ...d, statusLabel: statusLabel(d.status) })),
        state: carrier.state || null,
        phone: fmtPhone(carrier.phone) || null,
        address: [carrier.street, [carrier.city, carrier.state].filter(Boolean).join(', '), carrier.zip].filter(Boolean).join(' · '),
        powerUnits: carrier.powerUnits,
        drivers: carrier.drivers,
        mcs150Date: carrier.mcs150Date,
        safetyRating: carrier.safetyRating || null,
        safetyRatingDate: carrier.safetyRatingDate,
        operation: carrier.operation || null,
      },
      signals,
      history: { authority: history.authority, insurance: history.insurance },
      ca,
      live: qc.found ? qc : null,
      dotlookup: dl.found === false ? null : dl,
      meta: {
        source: 'FMCSA Company Census File (data.transportation.gov), refreshed daily from a ~24h-old database',
        liveFmcsa: qc.available ? 'ok' : qc.reason,
        dotlookup: dl.available ? 'ok' : dl.reason,
        crossRefErrors: xref.errors,
        historyErrors: history.errors,
        generatedAt: new Date().toISOString(),
      },
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/bulk') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (!env.DOTLOOKUP_KEY) return json({ error: 'Bulk check is not set up on this site yet.' }, 501);
      if (env.RL) {
        const { success } = await env.RL.limit({ key: 'bulk:' + (request.headers.get('cf-connecting-ip') || 'anon') });
        if (!success) return json({ error: 'Too many requests. Wait a minute and try again.' }, 429, { 'retry-after': '60' });
      }
      let body;
      try {
        const text = await request.text();
        if (text.length > 20000) return json({ error: 'Too much input.' }, 413);
        body = JSON.parse(text);
      } catch { return json({ error: 'Send JSON like {"dots":["44110","365109"]}.' }, 400); }
      const { dots, truncated } = parseDots(body && body.dots);
      if (!dots.length) return json({ error: 'No valid DOT numbers found.' }, 400);
      try {
        const out = await bulkCheck(env, dots);
        return json({ ...out, requested: dots.length, truncated, generatedAt: new Date().toISOString() }, 200, { 'cache-control': 'no-store' });
      } catch { return json({ error: 'The bulk lookup is temporarily unavailable. Try again in a minute.' }, 502); }
    }

    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    if (url.pathname === '/api/health') return json({ ok: true, liveFmcsa: Boolean(env.FMCSA_WEB_KEY), bulk: Boolean(env.DOTLOOKUP_KEY) });

    if (url.pathname === '/api/lookup') {
      // Optional: bind a Cloudflare rate limiter as RL (see README) to enable per-IP limiting.
      if (env.RL) {
        const ip = request.headers.get('cf-connecting-ip') || 'anon';
        const { success } = await env.RL.limit({ key: ip });
        if (!success) return json({ error: 'Too many lookups. Wait a minute and try again.' }, 429, { 'retry-after': '60' });
      }
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      // Versioned cache key: bump the number when the response shape changes.
      const cacheKey = new Request(`${url.origin}/_c/5${url.pathname}${url.search}`);
      // Long-lived copy of the last good answer, served only when a fresh lookup fails.
      const staleKey = new Request(`${url.origin}/_s/5${url.pathname}${url.search}`);
      if (cache) {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
      }
      const serveStale = async () => {
        const old = cache && (await cache.match(staleKey));
        if (!old) return null;
        const body = await old.json();
        return json({ ...body, stale: true }, 200, { 'cache-control': 'no-store' });
      };
      let r;
      try {
        // Overall deadline so a slow upstream cannot hang the page.
        r = await Promise.race([
          lookup(env, url.searchParams.get('q'), url.searchParams.get('type') || 'auto'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('deadline')), 22000)),
        ]);
      } catch (e) {
        return (await serveStale()) || json({ error: 'FMCSA data is temporarily unavailable. Try again in a minute.' }, 502);
      }
      if (r.status >= 500) return (await serveStale()) || json(r.body, r.status, { 'cache-control': 'no-store' });
      const res = json(r.body, r.status, r.status === 200 && r.cacheable ? { 'cache-control': 'public, max-age=300, s-maxage=3600' } : { 'cache-control': 'no-store' });
      if (cache && r.status === 200 && r.cacheable) {
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        ctx.waitUntil(cache.put(staleKey, json(r.body, 200, { 'cache-control': 'public, s-maxage=604800' })));
      }
      return res;
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'Not found' }, 404);
  },
};
