// Upside score: ranks coins by how likely they look to keep going up, using momentum,
// buy pressure, volume, KOL tweets and rug risk. It's a heuristic, not a prediction.
const dex = require("./dex");
const { checkRug } = require("./rug");
const history = require("./history");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function scoreToken(t, rug, kolMentions) {
  const reasons = [];
  let score = 50;

  const h1 = t.change.h1 ?? 0;
  const m5 = t.change.m5 ?? 0;
  score += clamp(h1, -50, 100) * 0.25;
  score += clamp(m5, -20, 20) * 0.5;
  if (h1 > 20) reasons.push(`+${h1.toFixed(0)}% in 1h`);
  if (m5 > 5) reasons.push(`Accelerating: +${m5.toFixed(1)}% in 5m`);
  if (h1 < -20) reasons.push(`Dumping: ${h1.toFixed(0)}% in 1h`);

  const tx = t.txns?.h1;
  if (tx && tx.buys + tx.sells >= 10) {
    const ratio = tx.buys / (tx.buys + tx.sells);
    score += (ratio - 0.5) * 40;
    if (ratio > 0.6) reasons.push(`Buy pressure: ${Math.round(ratio * 100)}% of 1h trades are buys`);
  }

  if (t.liquidity) {
    const turnover = (t.volume24h || 0) / t.liquidity;
    score += Math.min(turnover, 10) * 1.5;
    if (turnover > 3) reasons.push(`High volume: ${turnover.toFixed(1)}× liquidity traded in 24h`);
  }

  if (kolMentions > 0) {
    score += Math.min(kolMentions, 3) * 10;
    reasons.push(`Tweeted by ${kolMentions} tracked KOL${kolMentions > 1 ? "s" : ""} in 24h`);
  }

  score -= rug.risk * 0.6;
  if (rug.verdict !== "low") reasons.push(`Rug risk ${rug.verdict} (${rug.risk}/100)`);
  score = Math.round(clamp(score, 0, 100));

  let signal = score >= 70 ? "BUY" : score >= 50 ? "WATCH" : "AVOID";
  if (rug.verdict === "high") signal = "AVOID";
  return { score, signal, reasons };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]).catch(() => null);
    }
  }));
  return out;
}

function createSignals(tracker) {
  function kolMentions(t) {
    const since = Date.now() - 24 * 3600 * 1000;
    const handles = new Set();
    for (const a of tracker.alerts) {
      if (a.source === "test" || new Date(a.detected_at).getTime() < since) continue;
      const hit = a.addresses.some(x => x.address.toLowerCase() === String(t.address).toLowerCase()) ||
        (t.symbol && a.tickers.includes("$" + t.symbol.toUpperCase()));
      if (hit) handles.add(a.handle.toLowerCase());
    }
    return handles.size;
  }

  async function analyzeTokens(tokens) {
    const rows = await mapLimit(tokens, 5, async t => {
      const rug = await checkRug(t);
      history.record(t);
      return { ...t, rug, ...scoreToken(t, rug, kolMentions(t)) };
    });
    return rows.filter(Boolean).sort((a, b) => b.score - a.score);
  }

  async function analyze(chain, addresses, { realOnly = false, maxAge } = {}) {
    let tokens = [...(await dex.tokens(chain, addresses, maxAge)).values()];
    if (realOnly) tokens = tokens.filter(dex.isReal);
    return analyzeTokens(tokens);
  }

  // Discovery feed: trending/new DexScreener tokens + anything KOLs tweeted a CA for.
  let cached = { at: 0, chain: null, data: null };
  async function discover(chain = "solana", maxAgeMs = 15000) {
    if (cached.chain === chain && Date.now() - cached.at < maxAgeMs) return cached.data;
    const fromKols = tracker.alerts.flatMap(a => a.addresses)
      .filter(a => a.chain === chain).map(a => a.address);
    const addresses = [...new Set([...fromKols.slice(0, 15), ...(await dex.trending(chain))])].slice(0, 60);
    const rows = await analyze(chain, addresses, { realOnly: true });
    cached = { at: Date.now(), chain, data: rows };
    return rows;
  }

  return { analyze, analyzeTokens, discover };
}

module.exports = { createSignals, scoreToken };
