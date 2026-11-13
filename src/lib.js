// Pure helpers: normalization + trust-signal scoring. No I/O, so it is unit-testable.

export const clean = (s) => (s == null ? '' : String(s)).trim();
export const digits = (s) => clean(s).replace(/\D/g, '');
export const soqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

export function normPhone(p) {
  let d = digits(p);
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return '';
  if (/^(\d)\1+$/.test(d) || d === '1234567890' || d.startsWith('000')) return '';
  return d;
}

export function fmtPhone(p) {
  return p ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : '';
}

const ABBR = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR', LANE: 'LN',
  HIGHWAY: 'HWY', PARKWAY: 'PKWY', COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', TRAIL: 'TRL',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
};

// Split "123 Main Street Suite 4" into { street: "123 MAIN ST", unit: "STE 4" }.
export function splitStreet(raw) {
  let s = clean(raw).toUpperCase().replace(/[.,]/g, ' ').replace(/#\s*/g, ' UNIT ').replace(/\s+/g, ' ').trim();
  let unit = '';
  const m = s.match(/\b(STE|SUITE|UNIT|APT|APARTMENT|BLDG|BUILDING|FLOOR|RM|ROOM|LOT|SPACE)\b\s*([A-Z0-9-]*)/);
  if (m) {
    unit = `${m[1] === 'SUITE' ? 'STE' : m[1]} ${m[2]}`.trim();
    s = s.slice(0, m.index).trim();
  }
  s = s.split(' ').map((w) => ABBR[w] || w).join(' ');
  return { street: s, unit };
}

export const isMailbox = (raw) => /\bPMB\b|\bP\.?\s?O\.?\s?BOX\b/i.test(clean(raw));

export function parseDate(s) {
  const t = clean(s);
  let y, mo, d, m;
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})/) || t.match(/^(\d{4})-(\d{2})-(\d{2})/))) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
  } else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) {
    [mo, d, y] = [+m[1], +m[2], +m[3]];
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export const monthsBetween = (a, b) =>
  (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());

const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
const int = (v) => {
  const n = parseInt(clean(v).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const STATUS = { A: 'Active', I: 'Inactive', P: 'Pending' };
export const statusLabel = (c) => STATUS[c] || (c ? `Code ${c}` : 'Unknown');

// Census row -> normalized carrier. Private fields (email, officer names) stay server-side
// and are only used for cross-referencing; they are not part of the public payload.
export function normalizeCarrier(row) {
  const dockets = [1, 2, 3]
    .map((i) => ({
      prefix: clean(row[`docket${i}prefix`]).toUpperCase(),
      number: clean(row[`docket${i}`]),
      status: clean(row[`docket${i}_status_code`]).toUpperCase(),
    }))
    .filter((d) => d.number);
  return {
    dot: int(row.dot_number),
    legalName: clean(row.legal_name),
    dbaName: clean(row.dba_name),
    status: clean(row.status_code).toUpperCase(),
    dockets,
    phone: normPhone(row.phone),
    cell: normPhone(row.cell_phone),
    email: clean(row.email_address).toLowerCase(),
    street: clean(row.phy_street),
    city: clean(row.phy_city),
    state: clean(row.phy_state).toUpperCase(),
    zip: clean(row.phy_zip),
    powerUnits: int(row.power_units),
    drivers: int(row.total_drivers),
    mcs150Date: iso(parseDate(row.mcs150_date)),
    safetyRating: clean(row.safety_rating).toUpperCase().slice(0, 1),
    safetyRatingDate: iso(parseDate(row.safety_rating_date)),
    operation: clean(row.carrier_operation),
    officers: [row.company_officer_1, row.company_officer_2].map((o) => clean(o).toUpperCase()).filter(Boolean),
    priorRevoke: { flag: /^y/i.test(clean(row.prior_revoke_flag)), dot: digits(row.prior_revoke_dot_number) },
  };
}

// Compact form used in cross-reference evidence lists.
export function brief(c) {
  const mc = c.dockets.find((d) => d.prefix === 'MC') || c.dockets[0];
  return {
    dot: c.dot,
    name: c.legalName,
    dba: c.dbaName || undefined,
    status: c.status,
    mc: mc ? `${mc.prefix}${mc.number}` : undefined,
    location: [c.city, c.state].filter(Boolean).join(', '),
    powerUnits: c.powerUnits,
  };
}

// Classify rows that share the street number + zip with the carrier.
export function matchAddresses(carrier, rows) {
  const mine = splitStreet(carrier.street);
  const same = [];
  const building = [];
  for (const r of rows) {
    const theirs = splitStreet(r.street);
    if (theirs.street !== mine.street) continue;
    (theirs.unit === mine.unit ? same : building).push(r);
  }
  return { same, building };
}

// ---- Authority + insurance history ---------------------------------------
// Inputs are raw rows from the FMCSA "AuthHist", "Insur" and "InsHist" datasets. FMCSA moved to a new
// registration system (Motus) on 2026-05-14: the legacy datasets are frozen at that date and the Motus
// ones continue from it, so both are merged here.

const DAY = 86400000;
const within = (d, days, now) => d <= now && now - d <= days * DAY;
const num = (v) => { const n = parseFloat(clean(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
// "MC001515", "MC-1515" and "MC1515" are the same docket.
export const docketKey = (s) => clean(s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]{2})0+(?=\d)/, '$1');
// Free-text reasons can carry email addresses (e.g. "Withdrawn by x@y.com"); never pass those on.
const reasonText = (r) => clean(r).replace(/\S+@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);

const BIPD_FORM = /^(BMC-)?(91X?|82)$/i;
const BOND_FORM = /^(BMC-)?84$/i;
const INS_TYPE = { 1: 'Liability (BIPD)', 2: 'Cargo', 3: 'Surety bond', 4: 'Trust fund' };
const CANCEL_REASONS = new Set(['CANCEL', 'TERM/CANCL', 'CANC/CANCL', 'REVOKED']);

function authorityHistory(legacy, motus, now) {
  const seen = new Set();
  const events = [];
  const push = (kind, date, docket, extra) => {
    if (!date) return;
    const key = `${kind}|${iso(date)}|${docket}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ kind, date, docket, ...extra });
  };

  for (const r of legacy) {
    const orig = clean(r.original_action_desc).toUpperCase();
    const disp = clean(r.disp_action_desc).toUpperCase();
    const od = parseDate(r.orig_served_date);
    const dk = docketKey(r.docket_number);
    if (orig === 'GRANTED') push('granted', od, dk);
    else if (orig === 'REINSTATED') push('reinstated', od, dk);
    else if (orig === 'INVOLUNTARY REVOCATION' || orig === 'SPECIAL INVOLUNTARY REVOCATION') {
      push('notice', od, dk, { discontinued: disp === 'DISCONTINUED REVOCATION' });
    } else if (orig === 'SUSPENDED') push('suspended', od, dk);
    const dd = parseDate(r.disp_decided_date) || parseDate(r.disp_served_date);
    if (disp === 'REVOKED' || disp === 'SAFETY REVOCATION') push('revoked', dd, dk);
    else if (disp === 'SAFETY SUSPENSION') push('suspended', dd, dk);
  }

  const dockets = [];
  for (const r of motus) {
    const status = clean(r.op_auth_status);
    const reason = clean(r.reason);
    const when = parseDate(r.status_change_date);
    const dk = docketKey(r.docket_number);
    dockets.push({
      docket: dk,
      type: clean(r.op_auth_type),
      status,
      changed: iso(when),
      // Only inactive/pending rows carry a reason worth showing.
      reason: status === 'Inactive' || status === 'Pending' ? reasonText(reason) || null : null,
    });
    if (/^granted/i.test(reason)) push('granted', when, dk);
    else if (/^reinstated/i.test(reason)) push('reinstated', when, dk);
    else if (status === 'Inactive' && /revok/i.test(reason)) push('revoked', when, dk);
    else if (status === 'Inactive' && /suspen/i.test(reason)) push('suspended', when, dk);
  }

  events.sort((a, b) => b.date - a.date);
  const pick = (kind) => events.find((e) => e.kind === kind)?.date || null;
  const grants = events.filter((e) => e.kind === 'granted');
  const firstGranted = grants.length ? grants.reduce((m, e) => (e.date < m ? e.date : m), grants[0].date) : null;
  const notices = events.filter((e) => e.kind === 'notice' && within(e.date, 730, now));

  return {
    firstGranted: iso(firstGranted),
    lastRevoked: iso(pick('revoked')),
    lastReinstated: iso(pick('reinstated')),
    notices24: notices.length,
    noticesDiscontinued24: notices.filter((e) => e.discontinued).length,
    dockets,
    recent: events
      .filter((e) => within(e.date, 1095, now))
      .slice(0, 12)
      .map((e) => ({ date: iso(e.date), kind: e.kind, docket: e.docket })),
  };
}

// Returns gaps (> 14 days) in a set of {s, e, kind} coverage intervals, plus the date coverage ends.
function coverageGaps(intervals, now) {
  const iv = [...intervals].sort((a, b) => a.s - b.s);
  let maxEnd = null;
  let endKinds = [];
  const gaps = [];
  for (const x of iv) {
    if (maxEnd && x.s - maxEnd > 14 * DAY) gaps.push({ from: maxEnd, to: x.s });
    if (!maxEnd || x.e > maxEnd) { maxEnd = x.e; endKinds = [x.kind]; } else if (x.e.getTime() === maxEnd.getTime()) endKinds.push(x.kind);
  }
  return {
    gaps: gaps.filter((g) => within(g.to, 730, now)),
    endsAt: maxEnd,
    endKinds,
  };
}

function insuranceHistory({ nowMotus, nowLegacy, histMotus, histLegacy }, now) {
  const hist = [];
  for (const r of histMotus) {
    const t = clean(r.ins_type_desc).toUpperCase();
    hist.push({
      cat: /BIPD/.test(t) || clean(r.ins_type_code) === '1' ? 'bipd' : /SURETY/.test(t) || clean(r.ins_type_code) === '3' ? 'bond' : 'other',
      reason: clean(r.filing_status_reason).toUpperCase(),
      eff: parseDate(r.effective_date), end: parseDate(r.cancl_effective_date),
      insurer: clean(r.insurance_company_name), policy: clean(r.policy_no),
    });
  }
  for (const r of histLegacy) {
    const f = clean(r.ins_form_code);
    hist.push({
      cat: BIPD_FORM.test(f) ? 'bipd' : BOND_FORM.test(f) ? 'bond' : 'other',
      reason: clean(r.cancl_method).toUpperCase(),
      eff: parseDate(r.effective_date), end: parseDate(r.cancl_effective_date),
      insurer: clean(r.name_company), policy: clean(r.policy_no),
    });
  }
  const kindOf = (reason) => (CANCEL_REASONS.has(reason) ? 'cancelled' : reason === 'TERM/REPL' ? 'replaced' : 'other');
  const pkey = (policy, eff, insurer) => `${clean(policy)}|${iso(eff)}|${clean(insurer).toUpperCase()}`;

  // Filings already ended (or scheduled to end) according to the history datasets.
  const normPol = (p) => clean(p).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ends = new Map();
  const futureCancels = [];
  for (const h of hist) {
    if (!h.policy || !h.end) continue;
    const kind = kindOf(h.reason);
    if (h.eff && h.end > h.eff) ends.set(pkey(h.policy, h.eff, h.insurer), { end: h.end, kind });
    if (kind === 'cancelled' && h.end > now) futureCancels.push({ pol: normPol(h.policy), end: h.end });
  }

  const current = new Map();
  const addCurrent = (code, form, insurer, policy, eff, cov) => {
    if (!eff) return;
    const e = ends.get(pkey(policy, eff, insurer));
    if (e && e.end <= now) return; // already cancelled/replaced
    let cancelsOn = e ? e.end : null;
    let cancelKind = e ? e.kind : null;
    if (!cancelsOn) {
      // A cancellation notice for the same policy number that takes effect after this filing began.
      const f = futureCancels.find((x) => x.pol === normPol(policy) && eff < x.end);
      if (f) { cancelsOn = f.end; cancelKind = 'cancelled'; }
    }
    const cat = code === '1' || BIPD_FORM.test(form) ? 'bipd' : code === '3' || BOND_FORM.test(form) ? 'bond' : 'other';
    const key = `${policy}|${iso(eff)}|${code}`;
    if (current.has(key)) return;
    current.set(key, { cat, type: INS_TYPE[code] || 'Other', insurer, coverage: cov, eff, cancelsOn, cancelKind });
  };
  for (const r of nowMotus) addCurrent(clean(r.ins_type_code), clean(r.ins_form_code), clean(r.insurance_company_name), clean(r.policy_no), parseDate(r.effective_date), num(r.max_cov_amount));
  for (const r of nowLegacy) {
    const c = num(r.max_cov_amount);
    addCurrent(clean(r.ins_type_code), clean(r.ins_form_code), clean(r.name_company), clean(r.policy_no), parseDate(r.effective_date), c == null ? null : c * 1000);
  }
  const byInsurer = new Map();
  for (const p of current.values()) {
    const k = `${p.type}|${p.insurer.toUpperCase()}`;
    const prev = byInsurer.get(k);
    if (!prev || (p.eff || 0) > (prev.eff || 0)) byInsurer.set(k, p);
  }
  const cur = [...byInsurer.values()].sort((a, b) => a.type.localeCompare(b.type) || (b.eff || 0) - (a.eff || 0));

  const out = {};
  for (const cat of ['bipd', 'bond']) {
    const iv = [];
    for (const h of hist) {
      if (h.cat !== cat || !h.eff || !h.end || h.end < h.eff || h.reason === 'DUPLICATE') continue;
      iv.push({ s: h.eff, e: h.end, kind: kindOf(h.reason) });
    }
    for (const c of cur) {
      if (c.cat !== cat || !c.eff) continue;
      iv.push({ s: c.eff, e: c.cancelsOn || (c.eff > now ? c.eff : now), kind: c.cancelsOn ? c.cancelKind : 'current' });
    }
    if (!iv.length) { out[cat] = null; continue; }
    const g = coverageGaps(iv, now);
    out[cat] = {
      gaps: g.gaps.map((x) => ({ from: iso(x.from), to: iso(x.to), days: Math.round((x.to - x.from) / DAY) })),
      pendingCancel: g.endsAt && g.endsAt > now && g.endKinds.includes('cancelled') && !cur.some((c) => c.cat === cat && !c.cancelsOn) ? iso(g.endsAt) : null,
    };
  }

  const events = hist
    .filter((h) => h.end && h.cat !== 'other' && within(h.end, 730, now) && kindOf(h.reason) !== 'other')
    .sort((a, b) => b.end - a.end)
    .slice(0, 10)
    .map((h) => ({ date: iso(h.end), kind: kindOf(h.reason), type: h.cat === 'bipd' ? 'Liability (BIPD)' : 'Surety bond', insurer: h.insurer }));

  return {
    current: cur.map((c) => ({ type: c.type, insurer: c.insurer, coverage: c.coverage, effective: iso(c.eff), cancelsOn: iso(c.cancelsOn) })),
    bipd: out.bipd,
    bond: out.bond,
    events,
  };
}

export function buildHistory({ authLegacy = [], authMotus = [], insNowMotus = [], insNowLegacy = [], insHistMotus = [], insHistLegacy = [], errors = [], now = new Date() }) {
  return {
    errors,
    authority: authorityHistory(authLegacy, authMotus, now),
    insurance: insuranceHistory({ nowMotus: insNowMotus, nowLegacy: insNowLegacy, histMotus: insHistMotus, histLegacy: insHistLegacy }, now),
  };
}

function historySignals(h, c, qc, now, add) {
  const a = h.authority;
  const ins = h.insurance;
  const pm = (d) => { const m = monthsBetween(d, now); return m < 1 ? 'less than a month' : plural(m, 'month'); };

  // Brand-new authority. Needs the legacy history, otherwise a missing record would look like "new".
  const fg = parseDate(a.firstGranted);
  if (fg && c.status === 'A' && !h.errors.includes('auth-legacy')) {
    const m = monthsBetween(fg, now);
    if (m <= 12) {
      add('new-authority', m <= 6 ? 'medium' : 'low', `Operating authority first granted ${pm(fg)} ago`,
        `Granted ${a.firstGranted}. Newly authorized carriers have little track record; check insurance and references.`);
    }
  }

  const lr = parseDate(a.lastRevoked);
  if (lr && within(lr, 1095, now)) {
    add('authority-revoked', 'medium', `Authority revoked ${a.lastRevoked}`,
      `FMCSA history shows a revocation of operating authority.${a.lastReinstated ? ` Most recent reinstatement on record: ${a.lastReinstated}.` : ''}`);
  }

  if (a.notices24 >= 2) {
    add('revocation-notices', a.notices24 >= 3 ? 'medium' : 'low',
      `${plural(a.notices24, 'involuntary revocation notice')} in the last 24 months`,
      `FMCSA starts these when a requirement such as insurance is not met; ${a.noticesDiscontinued24} of ${a.notices24} were later discontinued.`);
  }

  // Insurance. Evaluated only for categories the carrier has filings in. There is deliberately no "no
  // active filing" signal: the current-policy datasets are incomplete, and the live FMCSA record
  // (insurance-short above) is the reliable source for what is on file today.
  const labels = { bipd: 'Liability insurance', bond: 'Broker bond' };
  for (const cat of ['bipd', 'bond']) {
    const x = ins[cat];
    if (!x) continue;
    const gapDates = x.gaps.slice(0, 3).map((g) => `${g.from} to ${g.to} (${g.days} days)`).join('; ');
    if (x.gaps.length) {
      const longest = Math.max(...x.gaps.map((g) => g.days));
      add(`${cat}-gap`, x.gaps.length >= 2 || longest >= 60 ? 'medium' : 'low',
        `${labels[cat]} filings show ${plural(x.gaps.length, 'gap')} in the last 24 months`,
        `Gaps between policies: ${gapDates}. Based on FMCSA filing dates, which can differ from actual coverage.`);
    }
    if (x.pendingCancel) {
      const days = Math.round((parseDate(x.pendingCancel) - now) / DAY);
      add(`${cat}-pending-cancel`, days <= 14 ? 'high' : 'medium',
        `${labels[cat]} policy is set to cancel ${x.pendingCancel}`,
        'A cancellation is on file with no replacement policy. Authority can be suspended if coverage lapses.');
    }
  }
  const newest = ins.current.filter((p) => p.type === 'Liability (BIPD)' && p.effective).sort((p, q) => q.effective.localeCompare(p.effective))[0];
  if (newest && within(parseDate(newest.effective), 60, now)) {
    add('insurer-new', 'info', `Liability policy with ${newest.insurer || 'a new insurer'} started ${newest.effective}`,
      'A recent policy start usually means a renewal or an insurer change.');
  }
}

const RANK = { high: 3, medium: 2, low: 1, info: 0 };

// How loudly to flag a shared attribute, based on how many others share it and how many are inactive.
function sharedSeverity(rows, cap = 'high') {
  const inactive = rows.filter((r) => r.status && r.status !== 'A').length;
  let sev = 'low';
  if (inactive >= 3) sev = 'high';
  else if (inactive >= 1 || rows.length >= 3) sev = 'medium';
  return RANK[sev] > RANK[cap] ? cap : sev;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Possible "chameleon" carrier: newly authorized and sharing contact details with inactive carriers.
function chameleonSignal(c, xref, history, now, add) {
  const links = new Map();
  const mark = (list, via) => { for (const e of list || []) { const l = links.get(e.dot) || { e, via: new Set() }; l.via.add(via); links.set(e.dot, l); } };
  mark(xref.phone, 'phone'); mark(xref.address.same, 'address'); mark(xref.email, 'email'); mark(xref.officer, 'officer');
  // A shared officer name alone is too weak (name collisions), so it only counts alongside another link.
  const inactive = [...links.values()].filter((l) => l.e.status && l.e.status !== 'A' && [...l.via].some((v) => v !== 'officer'));
  if (!inactive.length) return;
  const first = history && !history.errors.includes('auth-legacy') ? parseDate(history.authority.firstGranted) : null;
  const isNew = first && monthsBetween(first, now) <= 18;
  const strong = inactive.some((l) => l.via.size >= 2);
  if (!isNew && !c.priorRevoke.flag) return;
  const sev = strong || c.priorRevoke.flag ? 'high' : 'medium';
  const via = [...new Set(inactive.flatMap((l) => [...l.via]))].join(', ');
  add('possible-chameleon', sev,
    `Possible re-registration: new authority linked to ${plural(inactive.length, 'inactive carrier')}`,
    `${isNew ? `Authority was first granted ${history.authority.firstGranted}, and this` : 'This'} carrier shares ${via} with inactive carriers. Operators whose authority lapsed sometimes re-register under a new name. Related companies do this legitimately too, so treat it as a lead to verify, not a finding.`,
    inactive.map((l) => l.e));
}

export function buildSignals({ carrier: c, qc, xref, history, now = new Date() }) {
  const out = [];
  const add = (id, severity, title, detail, evidence) =>
    out.push({ id, severity, title, detail, ...(evidence && evidence.length ? { evidence } : {}) });

  // --- Status & authority ---
  if (c.status && c.status !== 'A') {
    add('census-status', 'high', `FMCSA record is ${statusLabel(c.status).toLowerCase()}`,
      'The carrier is not an active entity in the FMCSA census.');
  }
  if (!c.dockets.length && !(history && history.authority.dockets.length)) {
    add('no-docket', 'medium', 'No operating-authority docket on file',
      'No MC/MX/FF number is attached to this DOT record. It may be a private or intrastate carrier; for-hire interstate freight normally needs active authority.');
  }
  for (const d of c.dockets) {
    if (d.status && d.status !== 'A') {
      const why = history && history.authority.dockets.find((x) => x.docket === docketKey(`${d.prefix}${d.number}`) && x.reason);
      add(`docket-${d.prefix}${d.number}`, 'high', `${d.prefix}${d.number} authority is ${statusLabel(d.status).toLowerCase()}`,
        why ? `Operating authority on this docket is not active. FMCSA reason: ${why.reason}` : 'Operating authority on this docket is not active.');
    }
  }

  // --- Live FMCSA (QCMobile), only when configured and returned ---
  if (qc && qc.found) {
    if (qc.allowedToOperate === 'N') {
      add('not-allowed', 'high', 'FMCSA says the carrier is not allowed to operate',
        'The allowed-to-operate flag is N.');
    }
    if (qc.oosDate) {
      add('oos-order', 'high', `Out-of-service order dated ${qc.oosDate}`, 'FMCSA lists an out-of-service date for this carrier.');
    }
    if (qc.bipdRequired != null && qc.bipdOnFile != null && qc.bipdOnFile < qc.bipdRequired) {
      add('insurance-short', 'high', 'Liability insurance on file is below the required amount',
        `On file: ${qc.bipdOnFile}, required: ${qc.bipdRequired} (units as reported by FMCSA).`);
    }
    for (const [kind, rate, avg, insp] of [
      ['Vehicle', qc.vehicleOosRate, qc.vehicleOosAvg, qc.vehicleInsp],
      ['Driver', qc.driverOosRate, qc.driverOosAvg, qc.driverInsp],
    ]) {
      if (rate != null && avg && insp >= 10 && rate >= avg * 1.5) {
        add(`oos-${kind.toLowerCase()}`, 'medium', `${kind} out-of-service rate is well above average`,
          `${rate.toFixed(1)}% vs ${avg.toFixed(1)}% national average over ${insp} inspections.`);
      }
    }
  }

  // --- Staleness ---
  const mcs = parseDate(c.mcs150Date);
  if (mcs) {
    const m = monthsBetween(mcs, now);
    if (m >= 24) {
      add('mcs150-stale', 'medium', `MCS-150 not updated in ${m} months`,
        'Carriers must update their registration every 24 months. Contact details may be out of date.');
    }
  } else {
    add('mcs150-missing', 'low', 'No MCS-150 update date on file', 'The last registration update date is missing.');
  }

  // --- Safety rating ---
  if (c.safetyRating === 'U') {
    add('rating-unsat', 'high', 'Unsatisfactory safety rating', c.safetyRatingDate ? `Rated ${c.safetyRatingDate}.` : undefined);
  } else if (c.safetyRating === 'C') {
    add('rating-cond', 'medium', 'Conditional safety rating', c.safetyRatingDate ? `Rated ${c.safetyRatingDate}.` : undefined);
  }

  // --- Profile oddities ---
  if (c.status === 'A' && !c.powerUnits && !c.drivers) {
    add('no-fleet', 'low', 'No fleet reported', 'Active record with zero power units and zero drivers.');
  }
  if (isMailbox(c.street)) {
    add('mailbox', 'low', 'Mailbox-style address', 'The physical address looks like a PO box or private mailbox.');
  }

  // --- Cross-reference ---
  if (xref) {
    if (c.priorRevoke.flag) {
      add('prior-revoke', 'high', 'Linked to a previously revoked registration',
        c.priorRevoke.dot ? `FMCSA flags a prior revocation (DOT ${c.priorRevoke.dot}).` : 'FMCSA flags a prior revocation.',
        xref.priorRevoke ? [xref.priorRevoke] : undefined);
    }
    if (xref.phone.length) {
      add('shared-phone', sharedSeverity(xref.phone), `Phone number shared with ${plural(xref.phone.length, 'other carrier')}${xref.truncated.phone ? '+' : ''}`,
        'Same phone on file for a different DOT number. Common for related companies; a pattern when the others are inactive.', xref.phone);
    }
    if (xref.address.same.length) {
      add('shared-address', sharedSeverity(xref.address.same), `Same address as ${plural(xref.address.same.length, 'other carrier')}`,
        'Identical street, unit and ZIP on a different DOT number.', xref.address.same);
    }
    if (xref.address.building.length) {
      add('shared-building', xref.address.building.length >= 10 ? 'info' : 'low',
        `${plural(xref.address.building.length, 'other carrier')} in the same building`,
        'Same street address, different unit.', xref.address.building);
    }
    if (xref.email.length) {
      add('shared-email', sharedSeverity(xref.email), `Email shared with ${plural(xref.email.length, 'other carrier')}`,
        'Same contact email on a different DOT number.', xref.email);
    }
    if (xref.name.length) {
      add('same-name', sharedSeverity(xref.name, 'low'), `Same name used by ${plural(xref.name.length, 'other carrier')}`,
        'Another DOT record uses the same legal or DBA name.', xref.name);
    }
    if (xref.officer.length) {
      add('shared-officer', sharedSeverity(xref.officer, 'medium'), `A listed officer also appears on ${plural(xref.officer.length, 'other carrier')} in ${c.state}`,
        'Same officer name on a different DOT number in the same state. Names can collide; treat as a lead, not a finding.', xref.officer);
    }
  }

  if (history) historySignals(history, c, qc, now, add);
  if (xref && history) chameleonSignal(c, xref, history, now, add);

  out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const top = out.length ? out[0].severity : 'info';
  const level = top === 'info' ? 'clear' : top;
  return { signals: out, level };
}

// ---- California DMV Motor Carrier Permit (CA number) data -------------------------------------
// Parsed from the DMV's public "Active Motor Carriers" dashboard CSV export.
export function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  const t = String(text || '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

export const padCa = (s) => digits(s).slice(-7).padStart(7, '0');
export const normName = (s) => clean(s).toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const dmvText = (s) => { const v = clean(s); return /^(NA|N\/A|NONE)$/i.test(v) ? '' : v; };

export function parseDmvPermits(text) {
  const rows = parseCsv(text);
  if (!rows.length) return []; // DMV returns an empty body when nothing matches
  if (clean(rows[0][0]) !== 'CA number') throw new Error('Unexpected DMV response');
  const h = rows[0].map(clean);
  const at = (r, name) => r[h.indexOf(name)];
  return rows.slice(1).map((r) => ({
    ca: clean(at(r, 'CA number')),
    name: clean(at(r, 'Legal Name')),
    dba: dmvText(at(r, 'DBA Name')),
    phone: normPhone(at(r, 'Business phone')),
    liabilityInsurer: dmvText(at(r, 'Liability Insurance Co')),
    workersCompInsurer: dmvText(at(r, 'Workers Comp. Insurance Co')),
  })).filter((p) => p.ca);
}

// ---- CHP Carrier Inspection Results (carriersafety.chp.ca.gov) ----
const unent = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
const htmlText = (s) => clean(unent(String(s).replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')));
const cellsOf = (tr) => [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);

// Search results: one row per carrier. Returns [] when the table is missing or empty.
export function parseChpSearch(html) {
  const i = html.indexOf('id="tableSearchCarrier"');
  if (i < 0) return [];
  const tbody = html.slice(i, html.indexOf('</table>', i));
  const out = [];
  for (const tr of tbody.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const c = cellsOf(tr);
    if (c.length < 7) continue;
    const parts = htmlText(c[4]).split('|').map(clean).filter(Boolean);
    const other = htmlText(c[7] || '');
    const pick = (label) => clean((other.match(new RegExp(label + '\\s*#s:\\s*(.*?)(?=\\s+(?:Cal-T|Docket|PSG|PSC|TCP)\\s*#s:|$)', 'i')) || [])[1]);
    const val = (v) => (v && !/^n\/a$/i.test(v) ? v : null);
    out.push({
      ca: digits(htmlText(c[1])).replace(/^0+(?=\d)/, ''),
      dot: digits(htmlText(c[2])) || null,
      status: htmlText(c[3]),
      name: parts[0] || '',
      dba: (parts.find((p) => /^DBA:/i.test(p)) || '').replace(/^DBA:\s*/i, '') || null,
      city: htmlText(c[5]),
      location: htmlText(c[6]),
      calT: val(pick('Cal-T')), docket: val(pick('Docket')), psc: val(pick('PS[GC]')),
    });
  }
  return out.filter((r) => r.ca);
}

// Terminal inspection results for one CA number: CSAT ratings plus ratings per California terminal.
export function parseChpTerminal(html) {
  const csat = [];
  const ci = html.indexOf('id="tableCSAT"');
  if (ci >= 0) {
    for (const tr of html.slice(ci, html.indexOf('</table>', ci)).match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
      const c = cellsOf(tr).map(htmlText);
      if (c.length === 2) csat.push({ date: c[0], rating: c[1] });
    }
  }
  const terminals = [];
  for (const block of html.split(/Inspection Results for Terminal #/i).slice(1)) {
    const id = (block.match(/^\s*(\d+)/) || [])[1];
    const status = htmlText((block.match(/Current Status:\s*([^<]*)/i) || [])[1] || '');
    const location = htmlText((block.match(/Location:\s*([^<]*)/i) || [])[1] || '');
    const ti = block.indexOf('id="tableInspection"');
    const inspections = [];
    if (ti >= 0) {
      for (const tr of block.slice(ti, block.indexOf('</table>', ti)).match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
        const c = cellsOf(tr).map(htmlText);
        if (c.length < 7) continue;
        inspections.push({ date: c[0], maintenance: c[1], driver: c[2], equipment: c[3], hazmat: c[4], terminal: c[5], category: c[6] });
      }
    }
    terminals.push({ id: id || null, status, location, inspections });
  }
  return { csat, terminals };
}

// Compact summary for the API: keep the latest rows, count everything.
export function summarizeChp(parsed, { maxTerminals = 5, maxRows = 6 } = {}) {
  const ts = (d) => { const m = /^(\d+)\/(\d+)\/(\d{4})$/.exec(d); return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : 0; };
  const unsat = (r) => /^unsatisfactory/i.test(r);
  const all = parsed.terminals.flatMap((t) => t.inspections);
  const csat = [...parsed.csat].sort((a, b) => ts(b.date) - ts(a.date));
  return {
    csat: csat.slice(0, 5),
    csatUnsatisfactory: csat.filter((r) => unsat(r.rating)).length,
    csatLast: csat[0] || null,
    inspectionCount: all.length,
    terminalUnsatisfactory: all.filter((r) => unsat(r.terminal)).length,
    lastInspection: all.length ? all.reduce((a, b) => (ts(b.date) > ts(a.date) ? b : a)).date : null,
    terminalCount: parsed.terminals.length,
    terminals: parsed.terminals.slice(0, maxTerminals).map((t) => ({
      ...t, inspectionCount: t.inspections.length,
      inspections: [...t.inspections].sort((a, b) => ts(b.date) - ts(a.date)).slice(0, maxRows),
    })),
  };
}

// ---- DotLookup (api.dotlookup.dev) -----------------------------------------

const r1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const BASIC_NAMES = {
  unsafe_driving: 'Unsafe driving', hours_of_service: 'Hours of service', driver_fitness: 'Driver fitness',
  controlled_substances: 'Drugs and alcohol', vehicle_maintenance: 'Vehicle maintenance',
};

// Reduce a DotLookup carrier profile (+ optional risk-history rows, newest first) to what the page shows.
export function normalizeDl(c, hist) {
  if (!c || typeof c !== 'object') return null;
  const rs = c.risk_score && typeof c.risk_score.score === 'number' ? c.risk_score : null;
  const si = (c.safety_full && c.safety_full.inspections) || {};
  const insp = (x) => (x && x.total ? { total: x.total, oos: x.oos, rate: r1(x.oos_rate), national: x.national_avg ? r1(x.national_avg) : null } : null);
  const cr = (c.safety_full && c.safety_full.crashes) || {};
  const sms = c.sms_basics || {};
  const basics = Object.keys(BASIC_NAMES)
    .filter((k) => sms[k] && typeof sms[k].inspections_with_violations === 'number')
    .map((k) => ({ name: BASIC_NAMES[k], measure: r1(sms[k].measure), withViolations: sms[k].inspections_with_violations }));
  const trend = (Array.isArray(hist) ? hist : [])
    .filter((h) => h && typeof h.score === 'number' && h.computed_at)
    .map((h) => ({ date: String(h.computed_at).slice(0, 10), score: h.score, grade: h.grade || null }))
    .reverse();
  return {
    available: true,
    risk: rs ? {
      score: rs.score, grade: rs.grade || null, tier: rs.tier || null, confidence: rs.confidence || null,
      components: (rs.components || []).map((x) => ({ name: x.name, score: x.score, weight: x.weight })),
      flags: (rs.flags || []).map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
    } : null,
    trend,
    inspections: { driver: insp(si.driver), vehicle: insp(si.vehicle), hazmat: insp(si.hazmat), overall: insp(si.overall) },
    crashes: cr.total != null ? { total: cr.total, fatal: cr.fatal || 0, injury: cr.injury || 0, towaway: cr.towaway || 0 } : null,
    basics,
    related: (Array.isArray(c.related_companies) ? c.related_companies : []).slice(0, 8).map((x) => ({
      dot: Number(x.dot_number), name: x.legal_name, status: x.status, location: [x.city, x.state].filter(Boolean).join(', '),
      powerUnits: x.power_units ?? null, match: x.match_types || [],
    })),
    updated: trend.length ? trend[trend.length - 1].date : null,
  };
}

// One row of the bulk screen: quick pass/flag read of a DotLookup bulk record.
export function bulkRow(c, now = new Date()) {
  const authStatus = clean(c.authority && c.authority.status).toUpperCase();
  const status = clean(c.status).toUpperCase();
  const mcs = parseDate(c.mcs150 && c.mcs150.date);
  const months = mcs ? monthsBetween(mcs, now) : null;
  const flags = [];
  if (status && status !== 'ACTIVE') flags.push({ severity: 'high', text: 'Carrier is ' + status.toLowerCase() });
  if (authStatus && authStatus !== 'ACTIVE') flags.push({ severity: 'high', text: 'Authority ' + authStatus.toLowerCase() });
  if (months != null && months >= 24) flags.push({ severity: 'medium', text: `MCS-150 ${months} months old` });
  if (c.fleet && c.fleet.power_units === 0) flags.push({ severity: 'medium', text: 'No power units reported' });
  const level = flags.some((f) => f.severity === 'high') ? 'high' : flags.length ? 'medium' : 'clear';
  return {
    dot: Number(c.dot_number), mc: c.mc_number ? 'MC' + c.mc_number : null, name: c.legal_name || null,
    status: status || null, authority: authStatus || null, location: [c.address && c.address.city, c.address && c.address.state].filter(Boolean).join(', '),
    powerUnits: c.fleet ? c.fleet.power_units ?? null : null, mcs150Date: mcs ? mcs.toISOString().slice(0, 10) : null, level, flags,
  };
}

// Parse pasted DOT numbers (commas, spaces, newlines; "DOT 123" tolerated). Returns unique, valid, capped.
export function parseDots(input, max = 50) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const d = digits(raw);
    if (!d || d.length > 8) continue;
    const n = String(Number(d));
    if (n !== '0' && !out.includes(n)) out.push(n);
  }
  return { dots: out.slice(0, max), truncated: out.length > max };
}
