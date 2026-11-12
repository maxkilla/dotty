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
  const m = t.match(/^(\d{4})(\d{2})(\d{2})/) || t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
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

export function buildSignals({ carrier: c, qc, xref, now = new Date() }) {
  const out = [];
  const add = (id, severity, title, detail, evidence) =>
    out.push({ id, severity, title, detail, ...(evidence && evidence.length ? { evidence } : {}) });

  // --- Status & authority ---
  if (c.status && c.status !== 'A') {
    add('census-status', 'high', `FMCSA record is ${statusLabel(c.status).toLowerCase()}`,
      'The carrier is not an active entity in the FMCSA census.');
  }
  if (!c.dockets.length) {
    add('no-docket', 'medium', 'No operating-authority docket on file',
      'No MC/MX/FF number is attached to this DOT record. It may be a private or intrastate carrier; for-hire interstate freight normally needs active authority.');
  }
  for (const d of c.dockets) {
    if (d.status && d.status !== 'A') {
      add(`docket-${d.prefix}${d.number}`, 'high', `${d.prefix}${d.number} authority is ${statusLabel(d.status).toLowerCase()}`,
        'Operating authority on this docket is not active.');
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

  out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const top = out.length ? out[0].severity : 'info';
  const level = top === 'info' ? 'clear' : top;
  return { signals: out, level };
}
