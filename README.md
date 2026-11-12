# Dotty

FMCSA carrier lookup with cross-reference trust signals. Search by DOT number, MC number or name; get the carrier record plus signals like inactive authority, stale MCS-150 filings, and phones, addresses, emails or officers shared with other DOT records.

Stateless Cloudflare Worker. No database: cross-referencing is done live by filtering the FMCSA Company Census File with Socrata queries.

These are trust signals, not fraud findings. Related companies legitimately share phones and addresses.

## Run it

```bash
npm install
cp .dev.vars.example .dev.vars    # optional: add FMCSA_WEB_KEY
npm run dev                       # http://localhost:8787
npm test                          # unit tests, no network
npm run test:live                 # smoke test against the real FMCSA API
```

Deploy: `npx wrangler secret put FMCSA_WEB_KEY` (optional), then `npm run deploy`.

## API

`GET /api/lookup?q=<query>&type=auto|dot|mc|name`

- `auto` reads `MC123456`, `DOT 44110`, a bare number (tried as DOT, then MC), or a name.
- A name with several matches returns `{ mode: "list", matches }`; one match returns the full carrier.
- Carrier response: `{ mode: "carrier", level, carrier, signals[], live, meta }`. `level` is `high | medium | low | clear`; each signal has `severity`, `title`, `detail` and optional `evidence` (other carriers).

`GET /api/health`

## Data sources

| Source | Auth | Used for |
|---|---|---|
| Company Census File, `data.transportation.gov/resource/az4n-8mr2` | none | carrier record and all cross-referencing. Refreshed daily from a ~24h-old database |
| QCMobile `mobile.fmcsa.dot.gov/qc/services/carriers/:dot` | `FMCSA_WEB_KEY` | optional live check: allowed-to-operate, out-of-service date, BIPD insurance, OOS rates |

| Authority History (`9mw4-x3tu` legacy, `yu5v-wbh6` new) | none | first grant date, revocations, revocation notices, docket status and FMCSA reason |
| Insur / InsHist (`ypjt-5ydn`, `c5y8-a4uz`, `6sqe-dvqs`, `3uet-3z4i`) | none | filings on record, cancelled or replaced filings, gaps, pending cancellations |

FMCSA is moving from the legacy licensing system to Motus. The legacy datasets are frozen at 2026-05-14 and the Motus ones continue from there, so both are queried and merged. Formats differ (dates, docket padding, coverage in $000s vs dollars) and are normalized in `src/lib.js`.

Socrata app token (`SOCRATA_APP_TOKEN`) is optional and only needed if queries get throttled.

## Reverse lookup

Search by phone, email or `street, ZIP` (choose Address) to list every carrier on file with it. Phone and email are auto-detected in Auto mode. Results show up to 50 carriers.

## California permits (CA numbers)

Search a CA number (auto-detected as `CA 123456`, or choose "CA number"). It is looked up in the California DMV's public Active Motor Carriers dashboard (`SearchResults.csv` export, exact-match filters, one request per uncached lookup, cached 1 hour) and matched to FMCSA records by exact name or phone. Carrier pages for California carriers also check that list by exact legal name and show CA number, phone, and liability / workers' comp insurers. A missing permit never produces a signal: the match is by exact name, so absence is not proof. The DMV page terms were not reviewed; if the DMV objects or blocks requests, remove `caForCarrier` and the `ca` search type.

### CHP inspection results

California carriers also get the CHP Carrier Inspection Results (carriersafety.chp.ca.gov, AB 529): CA/MCP number, status, Cal-T/PSC numbers, drug and alcohol testing (CSAT) audit ratings, and per-terminal inspection ratings. The CHP site is now the first source for CA-number search (it maps a CA number straight to a DOT number); the DMV CSV is used for permit details (insurers) and as a fallback when CHP does not respond. Out-of-state carriers are not checked against CHP. Ratings are leads to review, not findings.

## Signals

Inactive census status or docket, no docket, stale MCS-150 (24+ months), conditional/unsatisfactory safety rating, no fleet reported, mailbox address, prior-revocation flag, phone / address / email / name shared with other DOTs (louder when the others are inactive), shared officer within the same state. History signals: new authority (granted within 12 months), recent revocation (36 months), repeated revocation notices, gaps between liability or bond filings, filing set to cancel (high within 14 days), recently changed insurer. Possible re-registration ("chameleon"): new authority (18 months) that shares phone, address or email with inactive carriers; high when two attributes match or FMCSA flags a prior revocation, medium for one. A shared officer name alone never triggers it. With a webKey: not allowed to operate, out-of-service order, insurance below required.

## Known limits

- QCMobile response field names are coded from FMCSA's docs and are **not yet verified against a live response**. Run `FMCSA_WEB_KEY=... npm run test:live` and check the `live` block.
- History is built from filing dates, not actual coverage. The current-policy datasets are incomplete, so there is deliberately no "no insurance on file" signal; use the live check for that.
- Legacy insurance history is limited to cancellations from 2024 onward. The legacy authority query is capped at 300 rows.
- No change history (needs a database): no "contact info changed after approval", watchlists or alerts.
- Census data lags FMCSA systems and is self-reported.
- Responses are cached (Cache API, 1h).
- Rate limiting is off until you bind a Cloudflare rate limiter named `RL` (dashboard or `wrangler.toml`); the Worker uses it automatically when present. Do this before sharing the URL publicly.

## Pages

`/` (general), `/dot-lookup/` and `/mc-number-lookup/` share `public/app.js`; the last two are the SEO landing pages for the "dot lookup" and "mc number lookup" keywords.
