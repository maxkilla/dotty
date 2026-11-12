import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, buildSignals, normalizeCarrier, parseDate, docketKey } from '../src/lib.js';

const NOW = new Date('2026-11-12T12:00:00Z');
const carrier = normalizeCarrier({
  dot_number: '123', legal_name: 'TEST CO', status_code: 'A', phy_street: '1 MAIN ST', phy_city: 'X', phy_state: 'TX', phy_zip: '75001',
  docket1prefix: 'MC', docket1: '1515', docket1_status_code: 'A', power_units: '5', total_drivers: '5', mcs150_date: '20260101',
});
const ids = (history, extra = {}) => buildSignals({ carrier, history: buildHistory({ now: NOW, ...history }), now: NOW, ...extra }).signals.map((s) => s.id);
const sig = (history, id) => buildSignals({ carrier, history: buildHistory({ now: NOW, ...history }), now: NOW }).signals.find((s) => s.id === id);

test('parseDate reads mm/dd/yyyy and rejects junk', () => {
  assert.equal(parseDate('10/31/2022').toISOString().slice(0, 10), '2022-10-31');
  assert.equal(parseDate('20221031').toISOString().slice(0, 10), '2022-10-31');
  assert.equal(parseDate('00000000'), null);
  assert.equal(parseDate('13/40/2022'), null);
});

test('docketKey unifies legacy and new docket spellings', () => {
  assert.equal(docketKey('MC001515'), 'MC1515');
  assert.equal(docketKey('MC-1515'), 'MC1515');
  assert.equal(docketKey('MC65596173'), 'MC65596173');
});

test('new authority is flagged, but not when the legacy history failed to load', () => {
  const authMotus = [{ docket_number: 'MC9', op_auth_type: 'Motor Carrier of Property', op_auth_status: 'Active', reason: 'Granted', status_change_date: '20260901' }];
  assert.ok(ids({ authMotus }).includes('new-authority'));
  assert.ok(!ids({ authMotus, errors: ['auth-legacy'] }).includes('new-authority'));
  assert.equal(sig({ authMotus }, 'new-authority').severity, 'medium');
});

test('an old grant is not "new"', () => {
  const authLegacy = [{ docket_number: 'MC001515', original_action_desc: 'GRANTED', orig_served_date: '02/02/1989' }];
  assert.ok(!ids({ authLegacy }).includes('new-authority'));
});

test('recent revocation is a signal, an old one is not', () => {
  const recent = [{ docket_number: 'MC001515', original_action_desc: 'GRANTED', orig_served_date: '01/01/2015', disp_action_desc: 'REVOKED', disp_decided_date: '03/01/2025' }];
  const old = [{ docket_number: 'MC001515', original_action_desc: 'GRANTED', orig_served_date: '01/01/1999', disp_action_desc: 'REVOKED', disp_decided_date: '03/01/2005' }];
  assert.ok(ids({ authLegacy: recent }).includes('authority-revoked'));
  assert.ok(!ids({ authLegacy: old }).includes('authority-revoked'));
});

test('revocation notices: 1 is ignored, 2 is low, 3 is medium', () => {
  const n = (k) => Array.from({ length: k }, (_, i) => ({ docket_number: 'MC001515', original_action_desc: 'INVOLUNTARY REVOCATION', orig_served_date: `0${i + 1}/10/2026`, disp_action_desc: 'DISCONTINUED REVOCATION' }));
  assert.ok(!ids({ authLegacy: n(1) }).includes('revocation-notices'));
  assert.equal(sig({ authLegacy: n(2) }, 'revocation-notices').severity, 'low');
  assert.equal(sig({ authLegacy: n(3) }, 'revocation-notices').severity, 'medium');
});

test('inactive docket shows the FMCSA reason, with email addresses removed', () => {
  const inactive = normalizeCarrier({ ...{
    dot_number: '123', legal_name: 'T', status_code: 'A', docket1prefix: 'MC', docket1: '77', docket1_status_code: 'I', power_units: '1', mcs150_date: '20260101',
  } });
  const authMotus = [{ docket_number: 'MC77', op_auth_status: 'Inactive', reason: 'Involuntary Suspension - insurance cancellation; contact bob@example.com', status_change_date: '20260901' }];
  const { signals } = buildSignals({ carrier: inactive, history: buildHistory({ now: NOW, authMotus }), now: NOW });
  const d = signals.find((s) => s.id === 'docket-MC77');
  assert.match(d.detail, /insurance cancellation/);
  assert.doesNotMatch(d.detail, /@/);
});

test('no-docket warning is skipped when the new registration system already has dockets', () => {
  const none = normalizeCarrier({ dot_number: '5', legal_name: 'N', status_code: 'A', power_units: '1', mcs150_date: '20260101' });
  const authMotus = [{ docket_number: 'MC9', op_auth_status: 'Active', reason: 'Granted', status_change_date: '20260901' }];
  assert.ok(buildSignals({ carrier: none, now: NOW }).signals.some((s) => s.id === 'no-docket'));
  assert.ok(!buildSignals({ carrier: none, history: buildHistory({ now: NOW, authMotus }), now: NOW }).signals.some((s) => s.id === 'no-docket'));
});

const hist = (eff, end, reason = 'CANCEL', policy = 'P') => ({ ins_form_code: '91X', cancl_method: reason, policy_no: policy, effective_date: eff, cancl_effective_date: end, name_company: 'ACME INS' });

test('a gap between liability policies is flagged; back-to-back policies are not', () => {
  const gap = [hist('01/01/2025', '06/01/2025'), hist('07/15/2025', '07/15/2026', 'TERM/REPL', 'Q')];
  assert.ok(ids({ insHistLegacy: gap }).includes('bipd-gap'));
  const tight = [hist('01/01/2025', '06/01/2025', 'TERM/REPL'), hist('06/01/2025', '07/15/2026', 'TERM/REPL', 'Q')];
  assert.ok(!ids({ insHistLegacy: tight }).includes('bipd-gap'));
});

test('a policy with a future cancellation and nothing else is a pending-cancel signal', () => {
  const insNowMotus = [{ ins_type_code: '1', ins_form_code: 'BMC-91X', max_cov_amount: '750000.00', policy_no: 'CA 1', effective_date: '20260625', insurance_company_name: 'AGENCY' }];
  const insHistMotus = [{ ins_type_desc: 'BIPD', filing_status_reason: 'CANCEL', policy_no: 'CA1', effective_date: '20260417', cancl_effective_date: '20261213', insurance_company_name: 'AGENCY' }];
  const s = sig({ insNowMotus, insHistMotus }, 'bipd-pending-cancel');
  assert.ok(s);
  assert.equal(s.severity, 'medium');
  // Cancelling within 14 days is high.
  const soon = [{ ...insHistMotus[0], cancl_effective_date: '20261120' }];
  assert.equal(sig({ insNowMotus, insHistMotus: soon }, 'bipd-pending-cancel').severity, 'high');
});

test('another open-ended policy cancels out a pending cancellation', () => {
  const insNowMotus = [
    { ins_type_code: '1', ins_form_code: 'BMC-91X', max_cov_amount: '750000.00', policy_no: 'A1', effective_date: '20260625', insurance_company_name: 'AGENCY' },
    { ins_type_code: '1', ins_form_code: 'BMC-91X', max_cov_amount: '1000000.00', policy_no: 'B2', effective_date: '20260930', insurance_company_name: 'OTHER' },
  ];
  const insHistMotus = [{ ins_type_desc: 'BIPD', filing_status_reason: 'CANCEL', policy_no: 'A1', effective_date: '20260417', cancl_effective_date: '20261213', insurance_company_name: 'AGENCY' }];
  assert.ok(!ids({ insNowMotus, insHistMotus }).includes('bipd-pending-cancel'));
});

test('a renewal under the same policy number does not hide the current filing', () => {
  const insNowLegacy = [{ ins_type_code: '1', ins_form_code: '91X', max_cov_amount: '00750', policy_no: 'GAT1', effective_date: '01/01/2024', name_company: 'HARCO' }];
  // Same number and start date but a different insurer, ended the day it began: not evidence the current filing ended.
  const insHistLegacy = [hist('01/01/2024', '01/01/2024', 'TERM/REPL', 'GAT1')];
  const h = buildHistory({ now: NOW, insNowLegacy, insHistLegacy });
  assert.equal(h.insurance.current.length, 1);
  assert.equal(h.insurance.current[0].coverage, 750000); // legacy amounts are in thousands
});

test('a filing ended in the history data is dropped from current policies', () => {
  const insNowLegacy = [{ ins_type_code: '1', ins_form_code: '91X', max_cov_amount: '00750', policy_no: 'P1', effective_date: '01/01/2023', name_company: 'ACME INS' }];
  const insHistLegacy = [{ ...hist('01/01/2023', '01/01/2026', 'CANCEL', 'P1'), name_company: 'ACME INS' }];
  assert.equal(buildHistory({ now: NOW, insNowLegacy, insHistLegacy }).insurance.current.length, 0);
});

test('current policies are one line per insurer, newest wins', () => {
  const row = (eff, name) => ({ ins_type_code: '1', ins_form_code: 'BMC-91X', max_cov_amount: '1000000', policy_no: eff, effective_date: eff, insurance_company_name: name });
  const h = buildHistory({ now: NOW, insNowMotus: [row('20260501', 'Trisura Insurance Company'), row('20260530', 'TRISURA INSURANCE COMPANY')] });
  assert.equal(h.insurance.current.length, 1);
  assert.equal(h.insurance.current[0].effective, '2026-05-30');
});

test('there is no "no active filing" signal', () => {
  const insHistLegacy = [hist('01/01/2024', '03/22/2024')];
  assert.ok(!ids({ insHistLegacy }).some((id) => /none/.test(id)));
});
