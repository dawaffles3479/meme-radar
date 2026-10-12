// In-memory time series of market cap / price / liquidity per token, for live charts.
const MAX_POINTS = 720; // ~6h at 30s sampling
const MIN_GAP_MS = 10000;
const series = new Map();

function record(t) {
  if (!t?.address) return;
  const key = `${t.chain}:${t.address}`;
  const arr = series.get(key) || [];
  const now = Date.now();
  if (arr.length && now - arr[arr.length - 1].t < MIN_GAP_MS) return;
  arr.push({ t: now, mc: t.marketCap, p: t.priceUsd, liq: t.liquidity, vol: t.volume24h });
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
  series.set(key, arr);
}

function get(chain, address) {
  return series.get(`${chain}:${address}`) || [];
}

module.exports = { record, get };
