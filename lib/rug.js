// Rug-pull risk check. Combines market heuristics (any chain), on-chain Solana checks
// (mint / freeze authority, holder concentration) and RugCheck.xyz's report when reachable.
const { getMintSafety } = require("./solana");

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

async function rugcheckXyz(mint) {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
  if (!res.ok) throw new Error(`RugCheck ${res.status}`);
  return res.json();
}

function marketFlags(t, add) {
  const liq = t.liquidity;
  if (liq == null || liq < 5000) add("danger", 30, `Very low liquidity (${liq == null ? "none" : "$" + Math.round(liq)}) — easy to rug or impossible to sell`);
  else if (liq < 20000) add("warn", 15, `Low liquidity ($${Math.round(liq).toLocaleString()})`);
  else add("good", 0, `Liquidity $${Math.round(liq).toLocaleString()}`);

  if (liq && t.marketCap && liq / t.marketCap < 0.03) add("warn", 10, "Liquidity is under 3% of market cap — price can collapse on a few sells");

  if (t.pairCreatedAt) {
    const ageMin = (Date.now() - t.pairCreatedAt) / 60000;
    if (ageMin < 15) add("danger", 15, `Brand new pool (${Math.round(ageMin)} min old)`);
    else if (ageMin < 120) add("warn", 8, `Young pool (${Math.round(ageMin)} min old)`);
  }

  const h1 = t.txns?.h1;
  if (h1 && h1.sells > 2 * Math.max(h1.buys, 1) && h1.sells > 20) add("warn", 12, `Heavy selling: ${h1.sells} sells vs ${h1.buys} buys in 1h`);
  if (h1 && h1.buys + h1.sells > 30 && h1.sells === 0) add("danger", 25, "Lots of buys but zero sells in 1h — possible honeypot (can't sell)");

  if (t.change?.h24 != null && t.change.h24 < -70) add("danger", 25, `Price down ${Math.round(-t.change.h24)}% in 24h — looks already rugged`);
  if (t.liquidity && t.volume24h / t.liquidity > 60) add("warn", 5, "Volume is extreme vs liquidity — possible wash trading");
}

async function solanaFlags(mint, add, sources) {
  try {
    const s = await getMintSafety(mint);
    sources.push("on-chain");
    if (s.mintAuthority) add("danger", 30, "Mint authority is ON — dev can print unlimited tokens");
    else add("good", 0, "Mint authority revoked");
    if (s.freezeAuthority) add("danger", 25, "Freeze authority is ON — dev can freeze your tokens");
    else add("good", 0, "Freeze authority revoked");
    // The largest account is often the liquidity pool / bonding curve, so be gentle on top1.
    if (s.top10Pct != null && s.top10Pct > 70) add("warn", 15, `Top 10 wallets hold ${s.top10Pct.toFixed(0)}% of supply (incl. LP)`);
    return s;
  } catch (e) {
    add("warn", 5, `On-chain check failed: ${e.message}`);
    return null;
  }
}

async function rugXyzFlags(mint, add, sources) {
  try {
    const r = await rugcheckXyz(mint);
    sources.push("rugcheck.xyz");
    for (const risk of r.risks || []) {
      const level = risk.level === "danger" ? "danger" : "warn";
      add(level, level === "danger" ? 15 : 5, `RugCheck: ${risk.name}${risk.description ? " — " + risk.description : ""}`);
    }
    return r.score_normalised ?? null;
  } catch {
    return null;
  }
}

async function checkRug(token) {
  const key = `${token.chain}:${token.address}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    // Market data moves fast; only the slow on-chain part is cached.
    return finish(token, hit.chainFlags, hit.sources, hit.extra);
  }

  const chainFlags = [];
  const sources = [];
  const addChain = (level, points, msg) => chainFlags.push({ level, points, msg });
  const extra = {};
  if (token.chain === "solana") {
    const [onchain, rugcheckScore] = await Promise.all([
      solanaFlags(token.address, addChain, sources),
      rugXyzFlags(token.address, addChain, sources)
    ]);
    extra.onchain = onchain;
    extra.rugcheckScore = rugcheckScore;
  }
  cache.set(key, { at: Date.now(), chainFlags, sources, extra });
  return finish(token, chainFlags, sources, extra);
}

function finish(token, chainFlags, sources, extra) {
  const flags = [...chainFlags];
  marketFlags(token, (level, points, msg) => flags.push({ level, points, msg }));
  const risk = Math.min(100, flags.reduce((s, f) => s + f.points, 0));
  const verdict = risk >= 55 ? "high" : risk >= 25 ? "medium" : "low";
  const order = { danger: 0, warn: 1, good: 2 };
  flags.sort((a, b) => order[a.level] - order[b.level]);
  return { risk, verdict, flags, sources: ["dexscreener", ...sources], ...extra };
}

module.exports = { checkRug };
