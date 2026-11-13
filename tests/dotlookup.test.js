import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeDl, bulkRow, parseDots } from '../src/lib.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/dl-carrier.json', import.meta.url), 'utf8'));
const hist = [
  { computed_at: '2026-11-08T08:18:26Z', score: 88, grade: 'B' },
  { computed_at: '2026-09-11T08:18:05Z', score: 92, grade: 'A' },
];

test('normalizeDl keeps risk score, flags, inspections, crashes and basics', () => {
  const d = normalizeDl(fx, hist);
  assert.equal(d.available, true);
  assert.equal(d.risk.score, 88);
  assert.equal(d.risk.grade, 'B');
  assert.equal(d.risk.components.length, 3);
  assert.ok(d.risk.flags.some((f) => f.code === 'HIGH_VEHICLE_OOS'));
  assert.equal(d.inspections.vehicle.rate, 34.4);
  assert.equal(d.inspections.vehicle.national, 22.9);
  assert.equal(d.inspections.hazmat, null); // zero inspections is not shown
  assert.equal(d.crashes.total, 1);
  assert.ok(d.basics.find((b) => b.name === 'Vehicle maintenance' && b.withViolations === 14));
});

test('trend is oldest first and updated is the newest date', () => {
  const d = normalizeDl(fx, hist);
  assert.deepEqual(d.trend.map((t) => t.score), [92, 88]);
  assert.equal(d.updated, '2026-11-08');
});

test('related carriers are mapped with match types', () => {
  const d = normalizeDl(fx, []);
  assert.ok(d.related.length > 0);
  assert.equal(typeof d.related[0].dot, 'number');
  assert.ok(Array.isArray(d.related[0].match));
});

test('normalizeDl tolerates missing sections', () => {
  const d = normalizeDl({ dot_number: '1' }, null);
  assert.equal(d.risk, null);
  assert.deepEqual(d.trend, []);
  assert.equal(d.crashes, null);
  assert.equal(normalizeDl(null), null);
});

test('a risk score of 0 is kept, not dropped', () => {
  const d = normalizeDl({ risk_score: { score: 0, grade: 'F', tier: 'Critical' } }, null);
  assert.equal(d.risk.score, 0);
});

const NOW = new Date('2026-11-12T00:00:00Z');
test('bulkRow flags inactive, no authority and stale MCS-150', () => {
  const ok = bulkRow({ dot_number: '1', status: 'ACTIVE', authority: { status: 'ACTIVE' }, mcs150: { date: '2026-03-01T00:00:00Z' }, fleet: { power_units: 3 } }, NOW);
  assert.equal(ok.level, 'clear');
  const stale = bulkRow({ dot_number: '2', status: 'ACTIVE', authority: { status: 'ACTIVE' }, mcs150: { date: '2023-01-01T00:00:00Z' }, fleet: { power_units: 3 } }, NOW);
  assert.equal(stale.level, 'medium');
  assert.match(stale.flags[0].text, /MCS-150/);
  const dead = bulkRow({ dot_number: '3', status: 'INACTIVE', authority: { status: 'NONE' }, mcs150: { date: '2026-03-01T00:00:00Z' }, fleet: { power_units: 0 } }, NOW);
  assert.equal(dead.level, 'high');
  assert.ok(dead.flags.length >= 3);
});

test('parseDots handles mixed separators, duplicates, junk and the cap', () => {
  assert.deepEqual(parseDots('44110, 365109\nDOT 44110; abc 0 123456789').dots, ['44110', '365109']);
  assert.deepEqual(parseDots(['0001', '7']).dots, ['1', '7']);
  const many = Array.from({ length: 60 }, (_, i) => String(i + 1)).join(' ');
  const r = parseDots(many);
  assert.equal(r.dots.length, 50);
  assert.equal(r.truncated, true);
});
