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

Socrata app token (`SOCRATA_APP_TOKEN`) is optional and only needed if queries get throttled.

## Signals

Inactive census status or docket, no docket, stale MCS-150 (24+ months), conditional/unsatisfactory safety rating, no fleet reported, mailbox address, prior-revocation flag, phone / address / email / name shared with other DOTs (louder when the others are inactive), shared officer within the same state. With a webKey: not allowed to operate, out-of-service order, insurance below required.

## Known limits

- QCMobile response field names are coded from FMCSA's docs and are **not yet verified against a live response**. Run `FMCSA_WEB_KEY=... npm run test:live` and check the `live` block.
- Census `add_date` is not the authority grant date, so there is no "new authority" signal yet.
- No change history (needs a database): no "contact info changed after approval", watchlists or alerts.
- Census data lags FMCSA systems and is self-reported.
- Responses are cached (Cache API, 1h).
- Rate limiting is off until you bind a Cloudflare rate limiter named `RL` (dashboard or `wrangler.toml`); the Worker uses it automatically when present. Do this before sharing the URL publicly.

## Pages

`/` (general), `/dot-lookup/` and `/mc-number-lookup/` share `public/app.js`; the last two are the SEO landing pages for the "dot lookup" and "mc number lookup" keywords.
