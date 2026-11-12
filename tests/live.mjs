// Live smoke test against the real FMCSA Census API.  Usage: node tests/live.mjs [query ...]
// Set FMCSA_WEB_KEY in the environment to also exercise QCMobile.
import worker from '../src/index.js';

const env = { FMCSA_WEB_KEY: process.env.FMCSA_WEB_KEY, SOCRATA_APP_TOKEN: process.env.SOCRATA_APP_TOKEN };
const queries = process.argv.slice(2);
if (!queries.length) queries.push('44110', 'MC 1515', 'greyhound lines', 'MC-0');

for (const q of queries) {
  const t = Date.now();
  const res = await worker.fetch(new Request('http://x/api/lookup?q=' + encodeURIComponent(q)), env, { waitUntil() {} });
  const d = await res.json();
  console.log(`\n== ${q}  [${res.status}, ${Date.now() - t}ms]`);
  if (d.mode === 'carrier') {
    console.log(d.carrier.legalName, '| DOT', d.carrier.dot, '| level:', d.level, '| searchedAs:', d.searchedAs, '| live:', d.meta.liveFmcsa);
    for (const s of d.signals) console.log(` - [${s.severity}] ${s.title}${s.evidence ? ` (${s.evidence.length} evidence)` : ''}`);
    if (d.meta.crossRefErrors.length) console.log(' cross-ref errors:', d.meta.crossRefErrors);
  } else if (d.mode === 'list') {
    console.log(d.matches.length, 'matches;', d.matches.slice(0, 3).map((m) => `${m.name} (${m.dot})`).join(', '));
  } else console.log(d);
}
