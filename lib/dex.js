// Prices, liquidity and volume from DexScreener's free public API (no key needed).
const BASE = "https://api.dexscreener.com";
const cache = new Map();
const CACHE_MS = 15000;

async function getJson(url, maxAge = CACHE_MS) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAge) return hit.data;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

function normalizePair(p) {
  return {
    chain: p.chainId,
    address: p.baseToken?.address,
    symbol: p.baseToken?.symbol,
    name: p.baseToken?.name,
    priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
    change: {
      m5: p.priceChange?.m5 ?? null,
      h1: p.priceChange?.h1 ?? null,
      h24: p.priceChange?.h24 ?? null
    },
    volume24h: p.volume?.h24 ?? null,
    txns: { m5: p.txns?.m5 || null, h1: p.txns?.h1 || null, h24: p.txns?.h24 || null },
    liquidity: p.liquidity?.usd ?? null,
    marketCap: p.marketCap ?? p.fdv ?? null,
    pairCreatedAt: p.pairCreatedAt ?? null,
    pairAddress: p.pairAddress || null,
    url: p.url,
    image: p.info?.imageUrl || null
  };
}

// DexScreener returns one entry per pool; keep the most liquid pool for each token.
function bestPerToken(pairs) {
  const best = new Map();
  for (const p of pairs || []) {
    const key = `${p.chainId}:${p.baseToken?.address}`;
    const cur = best.get(key);
    if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(key, p);
  }
  return [...best.values()].map(normalizePair);
}

async function search(q) {
  const data = await getJson(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`);
  return bestPerToken(data.pairs).sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
}

// Look up up to N token addresses on one chain; returns Map(address -> token info).
async function tokens(chain, addresses, maxAge = CACHE_MS) {
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30));
  const results = await Promise.all(chunks.map(chunk =>
    getJson(`${BASE}/tokens/v1/${chain}/${chunk.join(",")}`, maxAge)));
  const out = new Map();
  for (const data of results) {
    for (const t of bestPerToken(Array.isArray(data) ? data : data.pairs)) out.set(t.address, t);
  }
  return out;
}

// Real, tradable coins only: has a price, some liquidity and actual trades today.
function isReal(t) {
  const tx = t.txns?.h24;
  return t.priceUsd > 0 && (t.liquidity || 0) >= 1000 && (tx ? tx.buys + tx.sells >= 10 : false);
}

// Tokens currently being promoted / newly listed on DexScreener: a feed of fresh meme coins.
async function trending(chain) {
  const lists = await Promise.allSettled([
    getJson(`${BASE}/token-boosts/top/v1`),
    getJson(`${BASE}/token-boosts/latest/v1`),
    getJson(`${BASE}/token-profiles/latest/v1`)
  ]);
  const seen = new Set();
  for (const l of lists) {
    if (l.status !== "fulfilled" || !Array.isArray(l.value)) continue;
    for (const t of l.value) if (t.chainId === chain && t.tokenAddress) seen.add(t.tokenAddress);
  }
  if (!seen.size && lists.every(l => l.status === "rejected")) throw lists[0].reason;
  return [...seen];
}

module.exports = { search, tokens, trending, isReal };
