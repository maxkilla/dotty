// Cloudflare Worker: FMCSA carrier lookup + cross-reference. Stateless; no database.
//   GET /api/lookup?q=<DOT|MC|name>&type=auto|dot|mc|name
//   GET /api/health
// Static UI is served from ./public by the assets binding.

import {
  clean, digits, soqlStr, fmtPhone, normalizeCarrier, brief, matchAddresses, buildSignals, buildHistory, statusLabel,
} from './lib.js';

const SODA = 'https://data.transportation.gov/resource/';
const CENSUS = 'az4n-8mr2';

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
  if (type === 'auto' && /^\d{1,8}$/.test(s)) return { kind: 'number', value: s.replace(/^0+/, '') || '0' };
  // Names: keep a conservative character set (also keeps WAF-triggering junk like "--" or "=" away from Socrata).
  const name = s.replace(/[^A-Za-z0-9 &.,'\/#()-]/g, ' ').replace(/-{2,}/g, '-').replace(/\s+/g, ' ').trim();
  if (name.replace(/[^A-Za-z0-9]/g, '').length >= 3) return { kind: 'name', value: name };
  return { kind: 'bad' };
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
  if (!q) return { status: 400, body: { error: 'Enter a DOT number, MC number, or company name.' } };
  const p = parseQuery(q, type);
  if (p.kind === 'bad') return { status: 400, body: { error: 'Could not read that. Try a DOT number, an MC number like MC123456, or at least 3 letters of a name.' } };

  let rows = [];
  let searchedAs = p.kind;
  if (p.kind === 'dot') rows = await byDot(env, p.value);
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
  const [xref, qc, history] = await Promise.all([crossRef(env, carrier), qcCarrier(env, carrier.dot), historyData(env, carrier)]);
  const { signals, level } = buildSignals({ carrier, qc, xref, history });

  const partial = xref.errors.length > 0 || history.errors.length > 0 || (!qc.available && qc.reason !== 'not_configured');
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
      live: qc.found ? qc : null,
      meta: {
        source: 'FMCSA Company Census File (data.transportation.gov), refreshed daily from a ~24h-old database',
        liveFmcsa: qc.available ? 'ok' : qc.reason,
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
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    if (url.pathname === '/api/health') return json({ ok: true, liveFmcsa: Boolean(env.FMCSA_WEB_KEY) });

    if (url.pathname === '/api/lookup') {
      // Optional: bind a Cloudflare rate limiter as RL (see README) to enable per-IP limiting.
      if (env.RL) {
        const ip = request.headers.get('cf-connecting-ip') || 'anon';
        const { success } = await env.RL.limit({ key: ip });
        if (!success) return json({ error: 'Too many lookups. Wait a minute and try again.' }, 429, { 'retry-after': '60' });
      }
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      // Versioned cache key: bump the number when the response shape changes.
      const cacheKey = new Request(`${url.origin}/_c/2${url.pathname}${url.search}`);
      if (cache) {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
      }
      let r;
      try {
        r = await lookup(env, url.searchParams.get('q'), url.searchParams.get('type') || 'auto');
      } catch (e) {
        return json({ error: 'FMCSA data is temporarily unavailable. Try again in a minute.' }, 502);
      }
      const res = json(r.body, r.status, r.status === 200 && r.cacheable ? { 'cache-control': 'public, max-age=300, s-maxage=3600' } : { 'cache-control': 'no-store' });
      if (cache && r.status === 200 && r.cacheable) ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'Not found' }, 404);
  },
};
