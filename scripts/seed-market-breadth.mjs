#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import {
  BREADTH_HISTORY_KEY,
  MAX_SESSION_AGE_MIN,
  fetchSp500Breadth,
  mergeBreadthHistory,
  readBreadthHistory,
  readSavedConstituents,
  requireCompleteReadings,
  SP500_CONSTITUENTS_KEY,
} from './_sp500-breadth.mjs';
loadEnvFile(import.meta.url);

const BREADTH_TTL = 2592000; // 30 days

// Barchart's $S5TW/$S5FI/$S5TH breadth symbols went behind an AWS WAF
// JavaScript challenge (confirmed live: the response is a challenge.js page,
// not the quote page, from every egress tried — not an IP block, so a proxy
// doesn't fix it). Compute the same three readings ourselves instead: pull
// the live S&P 500 constituent list from Wikipedia (public, unauthenticated)
// and, for each, fetch a year of daily closes via this repo's existing
// fetchYahooJson helper (already handles Yahoo's rate limiting + proxy
// fallback — see scripts/_yahoo-fetch.mjs) to compute whether the latest
// close sits above its own 20/50/200-day SMA. This runs via its own
// dedicated GitHub Actions workflow (seed-market-breadth.yml), not
// seed-all.yml's shard loop: ~500 staggered Yahoo calls takes several
// minutes, far past that workflow's 90s-per-script budget, and the 30-day
// TTL here means once/day is plenty anyway.
const SP500_LIST_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';
const SMA_WINDOWS = { pctAbove20d: 20, pctAbove50d: 50, pctAbove200d: 200 };
// Yahoo throttles aggressively on high-volume egress (see _yahoo-fetch.mjs
// header) — 300ms is above this codebase's general 150ms staggering
// convention (AGENTS.md) because this script alone issues ~500 requests in
// one run, an order of magnitude more than any existing Yahoo caller.
const YAHOO_STAGGER_MS = 300;
// Below this fraction of constituents, the aggregate percentage is not
// trustworthy enough to publish — better to leave the last-good reading in
// place (runSeed's existing last-good preservation) than ship a skewed one.
const MIN_SUCCESS_FRACTION = 0.5;

async function fetchSp500Symbols() {
  const resp = await fetch(SP500_LIST_URL, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Wikipedia S&P 500 list HTTP ${resp.status}`);
  const html = await resp.text();
  const tableStart = html.indexOf('id="constituents"');
  if (tableStart === -1) throw new Error('Wikipedia S&P 500 constituents table not found (page structure changed?)');
  const tableEnd = html.indexOf('</table>', tableStart);
  const tableHtml = html.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  const rowRe = /<tr[^>]*>\s*<td[^>]*><a[^>]*>([A-Z.-]+)<\/a><\/td>/g;
  const symbols = [];
  let m;
  while ((m = rowRe.exec(tableHtml))) {
    // Yahoo uses '-' where Wikipedia lists '.' for dual-class tickers (BRK.B -> BRK-B).
    symbols.push(m[1].replace(/\./g, '-'));
  }
  if (symbols.length < 400) {
    throw new Error(`Only parsed ${symbols.length} S&P 500 symbols (expected ~500) — Wikipedia page structure likely changed`);
  }
  return symbols;
}

function computeSma(closes, window) {
  if (closes.length < window) return null;
  const slice = closes.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

async function fetchSymbolAboveSma(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    // maxRetries=1 (not the helper's default 3): with ~500 symbols in one
    // run, a slow/broken single symbol retrying 3x with exponential backoff
    // costs minutes on its own. One retry is enough to absorb a transient
    // blip; a genuinely down symbol just drops out of the aggregate, which
    // MIN_SUCCESS_FRACTION guards against doing too much of.
    const chart = await fetchYahooJson(url, { label: symbol, maxRetries: 1, retryBaseMs: 2_000 });
    const closes = (chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((v) => v != null);
    if (closes.length < 20) return null;
    const lastClose = closes[closes.length - 1];
    const above = {};
    for (const [field, window] of Object.entries(SMA_WINDOWS)) {
      const sma = computeSma(closes, window);
      above[field] = sma != null ? lastClose > sma : null;
    }
    return above;
  } catch {
    return null;
  }
}

function redisOpts() {
  return { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
}

// Primary: self-computed from Wikipedia constituents + Yahoo closes (no
// third-party scanner dependency, runs in seed-market-breadth.yml). Fallback:
// the single-request TradingView scan, much cheaper but an external scanner.
async function computeYahooBreadth() {
  const symbols = await fetchSp500Symbols();
  console.log(`  S&P 500 constituents: ${symbols.length} symbols`);
  // [aboveCount, validCount] per field; valid < fetched for recent IPOs.
  const counts = { pctAbove20d: [0, 0], pctAbove50d: [0, 0], pctAbove200d: [0, 0] };
  let fetchedCount = 0;
  for (const symbol of symbols) {
    const above = await fetchSymbolAboveSma(symbol);
    if (above) {
      fetchedCount++;
      for (const field of Object.keys(SMA_WINDOWS)) {
        if (above[field] != null) {
          counts[field][1]++;
          if (above[field]) counts[field][0]++;
        }
      }
    }
    await sleep(YAHOO_STAGGER_MS);
  }
  console.log(`  Fetched ${fetchedCount}/${symbols.length} symbols`);
  if (fetchedCount < symbols.length * MIN_SUCCESS_FRACTION) {
    throw new Error(`Only fetched ${fetchedCount}/${symbols.length} symbols (below ${MIN_SUCCESS_FRACTION * 100}% threshold)`);
  }
  const readings = {};
  for (const field of Object.keys(SMA_WINDOWS)) {
    const [above, valid] = counts[field];
    readings[field] = valid > 0 ? Math.round((above / valid) * 1000) / 10 : null;
  }
  console.log(`    20d=${readings.pctAbove20d ?? 'null'}% | 50d=${readings.pctAbove50d ?? 'null'}% | 200d=${readings.pctAbove200d ?? 'null'}%`);
  // ET trading day (the run lands after US close, i.e. next UTC date).
  const sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  return { readings, sessionDate, sourceSessionAt: new Date().toISOString(), symbols: null };
}

async function computeTradingViewBreadth() {
  const {
    readings, constituents, valid, sessionDate, sourceSessionAt, otherSessions, membership, indexConstituents, symbols,
  } = await fetchSp500Breadth({ loadSavedConstituents: () => readSavedConstituents(redisOpts()) });

  if (membership === 'saved') {
    console.warn(`  TradingView S&P 500 symbol set returned ${indexConstituents} rows; scored the saved constituent list instead`);
  }
  console.log(`  TradingView: ${constituents} S&P 500 constituents on ${sessionDate} (valid 20d=${valid.pctAbove20d} | 50d=${valid.pctAbove50d} | 200d=${valid.pctAbove200d} | other sessions=${otherSessions})`);
  console.log(`    20d=${readings.pctAbove20d ?? 'null'} | 50d=${readings.pctAbove50d ?? 'null'} | 200d=${readings.pctAbove200d ?? 'null'}`);
  return { readings, sessionDate, sourceSessionAt, symbols };
}

async function fetchAll() {
  let result;
  try {
    result = await computeYahooBreadth();
    requireCompleteReadings(result.readings);
  } catch (err) {
    console.warn(`  Yahoo-computed breadth failed (${err.message}); falling back to TradingView scan`);
    result = await computeTradingViewBreadth();
  }
  const { readings, sessionDate, sourceSessionAt, symbols } = result;

  requireCompleteReadings(readings);

  const existing = await readBreadthHistory(redisOpts());
  const { history, current, updatedExisting } = mergeBreadthHistory(
    existing?.history ?? [],
    readings,
    sessionDate,
  );
  if (updatedExisting) {
    console.log(`  Updated existing entry for ${sessionDate}`);
  } else {
    console.log(`  Appended new entry for ${sessionDate} (history: ${history.length} days)`);
  }

  return {
    updatedAt: new Date().toISOString(),
    sourceSessionAt,
    current,
    history,
    // Written to SP500_CONSTITUENTS_KEY, never to the published history.
    savedConstituents: symbols ? { savedAt: Date.now(), symbols } : null,
  };
}

function validate(data) {
  return (
    data?.current != null &&
    Number.isFinite(data.current.pctAbove20d) &&
    Number.isFinite(data.current.pctAbove50d) &&
    Number.isFinite(data.current.pctAbove200d) &&
    Array.isArray(data?.history) &&
    data.history.length > 0
  );
}

export function declareRecords(data) {
  return Array.isArray(data?.history) ? data.history.length : 0;
}

function publishBreadth({ savedConstituents: _saved, ...data }) {
  return data;
}

runSeed('market', 'breadth-history', BREADTH_HISTORY_KEY, fetchAll, {
  validateFn: validate,
  ttlSeconds: BREADTH_TTL,
  publishTransform: publishBreadth,
  // A fallback run has no new list to save; skipWhenEmpty keeps the old one.
  extraKeys: [{
    key: SP500_CONSTITUENTS_KEY,
    transform: (data) => data.savedConstituents ?? { symbols: [] },
    declareRecords: (list) => list.symbols.length,
    ttl: BREADTH_TTL,
    skipWhenEmpty: true,
    allowMissingOnSkip: true,
  }],
  fetchPhaseTimeoutMs: 15 * 60_000, // ~500 staggered Yahoo calls; yml job cap is 20 min
  contentMeta: (data) => ({ newestItemAt: data.sourceSessionAt, oldestItemAt: data.sourceSessionAt }),
  maxContentAgeMin: MAX_SESSION_AGE_MIN,

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 2880,
  sourceVersion: 'market-breadth-v2',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
