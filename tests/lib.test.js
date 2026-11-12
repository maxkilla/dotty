import test from 'node:test';
import assert from 'node:assert/strict';
import { normPhone, splitStreet, matchAddresses, normalizeCarrier, buildSignals, parseDate, isMailbox, soqlStr } from '../src/lib.js';
import { parseQuery } from '../src/index.js';

const NOW = new Date('2026-11-12T00:00:00Z');
const row = (o = {}) => ({
  dot_number: '1000', legal_name: 'ACME FREIGHT LLC', status_code: 'A', phone: '5551234567',
  phy_street: '100 Main Street Suite 5', phy_city: 'Dallas', phy_state: 'TX', phy_zip: '75201-1234',
  docket1prefix: 'MC', docket1: '555', docket1_status_code: 'A', power_units: '5', total_drivers: '5',
  mcs150_date: '20260101', ...o,
});
const emptyX = () => ({ phone: [], address: { same: [], building: [] }, name: [], officer: [], email: [], priorRevoke: null, truncated: {} });
const other = (o = {}) => ({ dot: 2000, name: 'OTHER LLC', status: 'A', location: 'Dallas, TX', ...o });

test('normPhone rejects junk and strips country code', () => {
  assert.equal(normPhone('(214) 777-6005'), '2147776005');
  assert.equal(normPhone('1-214-777-6005'), '2147776005');
  assert.equal(normPhone('0000000000'), '');
  assert.equal(normPhone('5555555555'), '');
  assert.equal(normPhone('123'), '');
});

test('splitStreet separates and canonicalizes units', () => {
  assert.deepEqual(splitStreet('100 Main Street Suite 5'), { street: '100 MAIN ST', unit: 'STE 5' });
  assert.deepEqual(splitStreet('100 MAIN ST, #5'), { street: '100 MAIN ST', unit: 'UNIT 5' });
  assert.deepEqual(splitStreet('9773 Harry Hines Boulevard'), { street: '9773 HARRY HINES BLVD', unit: '' });
});

test('matchAddresses: same unit = same, other unit = building, other street ignored', () => {
  const me = normalizeCarrier(row());
  const rows = [
    normalizeCarrier(row({ dot_number: '2', phy_street: '100 MAIN ST STE 5' })),
    normalizeCarrier(row({ dot_number: '3', phy_street: '100 Main St Ste 9' })),
    normalizeCarrier(row({ dot_number: '4', phy_street: '100 Maple Ave' })),
  ];
  const { same, building } = matchAddresses(me, rows);
  assert.deepEqual(same.map((r) => r.dot), [2]);
  assert.deepEqual(building.map((r) => r.dot), [3]);
});

test('parseDate and mailbox detection', () => {
  assert.equal(parseDate('20260428').toISOString().slice(0, 10), '2026-04-28');
  assert.equal(parseDate('nope'), null);
  assert.ok(isMailbox('PMB 123 4500 S Main'));
  assert.ok(!isMailbox('100 Main St'));
});

test('soqlStr escapes quotes', () => assert.equal(soqlStr("O'Brien"), "'O''Brien'"));

test('clean active carrier has no signals above info', () => {
  const { level } = buildSignals({ carrier: normalizeCarrier(row()), xref: emptyX(), now: NOW });
  assert.equal(level, 'clear');
});

test('inactive census + inactive docket are high', () => {
  const c = normalizeCarrier(row({ status_code: 'I', docket1_status_code: 'I' }));
  const { signals, level } = buildSignals({ carrier: c, xref: emptyX(), now: NOW });
  assert.equal(level, 'high');
  assert.ok(signals.some((s) => s.id === 'census-status'));
  assert.ok(signals.some((s) => s.id === 'docket-MC555'));
});

test('stale MCS-150 is medium', () => {
  const c = normalizeCarrier(row({ mcs150_date: '20230101' }));
  const { signals } = buildSignals({ carrier: c, xref: emptyX(), now: NOW });
  assert.equal(signals.find((s) => s.id === 'mcs150-stale').severity, 'medium');
});

test('shared phone: severity grows with inactive matches', () => {
  const c = normalizeCarrier(row());
  const sev = (rows) => {
    const x = emptyX(); x.phone = rows;
    return buildSignals({ carrier: c, xref: x, now: NOW }).signals.find((s) => s.id === 'shared-phone').severity;
  };
  assert.equal(sev([other()]), 'low');
  assert.equal(sev([other({ status: 'I' })]), 'medium');
  assert.equal(sev([other({ status: 'I' }), other({ status: 'I' }), other({ status: 'I' })]), 'high');
});

test('prior revocation flag is high and carries evidence', () => {
  const c = normalizeCarrier(row({ prior_revoke_flag: 'Y', prior_revoke_dot_number: '999' }));
  const x = emptyX(); x.priorRevoke = other({ dot: 999, status: 'I' });
  const s = buildSignals({ carrier: c, xref: x, now: NOW }).signals.find((s) => s.id === 'prior-revoke');
  assert.equal(s.severity, 'high');
  assert.equal(s.evidence[0].dot, 999);
});

test('live QCMobile fields drive signals', () => {
  const c = normalizeCarrier(row());
  const qc = { found: true, allowedToOperate: 'N', oosDate: '2026-10-01', bipdOnFile: 0, bipdRequired: 750 };
  const ids = buildSignals({ carrier: c, qc, xref: emptyX(), now: NOW }).signals.map((s) => s.id);
  for (const id of ['not-allowed', 'oos-order', 'insurance-short']) assert.ok(ids.includes(id), id);
});

test('email and officer names are retained for matching only', () => {
  const c = normalizeCarrier(row({ email_address: 'a@b.com', company_officer_1: 'JANE DOE' }));
  assert.ok(c.email && c.officers.length); // kept server-side for matching
});

test('parseQuery', () => {
  assert.deepEqual(parseQuery('MC-123456'), { kind: 'docket', prefix: 'MC', value: '123456' });
  assert.deepEqual(parseQuery('mx 0099'), { kind: 'docket', prefix: 'MX', value: '99' });
  assert.deepEqual(parseQuery('DOT #44110'), { kind: 'dot', value: '44110' });
  assert.deepEqual(parseQuery('44110'), { kind: 'number', value: '44110' });
  assert.deepEqual(parseQuery('44110', 'mc'), { kind: 'docket', prefix: 'MC', value: '44110' });
  assert.deepEqual(parseQuery('greyhound'), { kind: 'name', value: 'greyhound' });
  assert.equal(parseQuery('ab').kind, 'bad');
  assert.equal(parseQuery('MC-0').kind, 'bad');
});

test('parseQuery sanitizes names', () => {
  assert.deepEqual(parseQuery("A-1 Trucking, Inc."), { kind: 'name', value: 'A-1 Trucking, Inc.' });
  assert.deepEqual(parseQuery("x' OR 1=1 --  abc"), { kind: 'name', value: "x' OR 1 1 - abc" });
  assert.equal(parseQuery('=== ---').kind, 'bad');
});

test('OOS rate signal needs volume and 1.5x the national average', () => {
  const c = normalizeCarrier(row());
  const ids = (qc) => buildSignals({ carrier: c, qc: { found: true, ...qc }, xref: emptyX(), now: NOW }).signals.map((s) => s.id);
  assert.ok(ids({ vehicleOosRate: 30, vehicleOosAvg: 20, vehicleInsp: 50 }).includes('oos-vehicle'));
  assert.ok(!ids({ vehicleOosRate: 30, vehicleOosAvg: 20, vehicleInsp: 5 }).includes('oos-vehicle'));
  assert.ok(!ids({ vehicleOosRate: 22, vehicleOosAvg: 20, vehicleInsp: 50 }).includes('oos-vehicle'));
});
