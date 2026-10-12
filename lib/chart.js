// Candles for the coin chart. GeckoTerminal gives free OHLCV per pool; we convert price
// candles to market-cap candles. Falls back to our own recorded history.
const history = require("./history");

const NETWORKS = { solana: "solana", ethereum: "eth", bsc: "bsc", base: "base", arbitrum: "arbitrum", polygon: "polygon_pos", avalanche: "avax" };
const cache = new Map();

async function candles({ chain, pairAddress, address, priceUsd, marketCap, tf = "minute", aggregate = 1 }) {
  const supply = priceUsd && marketCap ? marketCap / priceUsd : null;
  const net = NETWORKS[chain];
  if (net && pairAddress) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pairAddress}/ohlcv/${tf}?aggregate=${aggregate}&limit=300&currency=usd`;
    try {
      const hit = cache.get(url);
      let data;
      if (hit && Date.now() - hit.at < 20000) data = hit.data;
      else {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
        data = await res.json();
        cache.set(url, { at: Date.now(), data });
      }
      const list = data?.data?.attributes?.ohlcv_list || [];
      if (list.length) {
        const k = supply || 1;
        return {
          source: "geckoterminal",
          unit: supply ? "mcap" : "price",
          candles: list.map(([t, o, h, l, c, v]) => ({ time: t, open: o * k, high: h * k, low: l * k, close: c * k, volume: v })).sort((a, b) => a.time - b.time)
        };
      }
    } catch { /* fall through to local history */ }
  }
  // Local history: build 1-minute candles from our own 2s samples.
  const byMin = new Map();
  for (const pt of history.get(chain, address)) {
    const v = pt.mc ?? pt.p;
    if (v == null) continue;
    const t = Math.floor(pt.t / 60000) * 60;
    const c = byMin.get(t);
    if (!c) byMin.set(t, { time: t, open: v, high: v, low: v, close: v });
    else { c.high = Math.max(c.high, v); c.low = Math.min(c.low, v); c.close = v; }
  }
  return { source: "live-history", unit: "mcap", candles: [...byMin.values()].sort((a, b) => a.time - b.time) };
}

module.exports = { candles };
