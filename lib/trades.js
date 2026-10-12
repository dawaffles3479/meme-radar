// Axiom-style live trades: see every buy/sell on a coin as it happens, and get pinged
// when a wallet you follow (whales, KOLs, smart money) buys or sells anything.
//
// Sources:
//  - PumpPortal websocket (free, real-time) for pump.fun / PumpSwap coins and wallets
//  - Solana RPC: parses recent transactions on a pool or wallet, works for any DEX
const { EventEmitter } = require("events");
const { rpc } = require("./solana");
const { isSolanaAddress } = require("./parse");
const dex = require("./dex");
const store = require("./store");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMPPORTAL_WS = process.env.PUMPPORTAL_WS || "wss://pumpportal.fun/api/data";
const TOKEN_POLL_MS = Number(process.env.TRADES_POLL_MS || 2000);
const WALLET_POLL_MS = Number(process.env.WALLET_POLL_MS || 4000);
const MAX_RECENT = 100;

// Work out what the trader did in one parsed transaction: which token, buy or sell, how much.
function parseSwap(tx, trader, onlyMint) {
  if (!tx || tx.meta?.err) return null;
  const keys = tx.transaction.message.accountKeys.map(k => (typeof k === "string" ? k : k.pubkey));
  trader = trader || keys[0];
  const idx = keys.indexOf(trader);

  const deltas = new Map();
  const pre = new Map();
  const post = new Map();
  const bump = (b, sign, totals) => {
    if (b.owner !== trader) return;
    const amt = Number(b.uiTokenAmount?.uiAmountString || 0);
    deltas.set(b.mint, (deltas.get(b.mint) || 0) + sign * amt);
    totals.set(b.mint, (totals.get(b.mint) || 0) + amt);
  };
  for (const b of tx.meta.preTokenBalances || []) bump(b, -1, pre);
  for (const b of tx.meta.postTokenBalances || []) bump(b, +1, post);

  let sol = deltas.get(SOL_MINT) || 0; // wrapped SOL
  deltas.delete(SOL_MINT);
  if (idx >= 0) {
    sol += (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
    if (idx === 0) sol += (tx.meta.fee || 0) / 1e9;
  }

  let mint = onlyMint;
  if (!mint) {
    let best = 0;
    for (const [m, d] of deltas) if (Math.abs(d) > best) { best = Math.abs(d); mint = m; }
  }
  const tokens = deltas.get(mint) || 0;
  if (!mint || tokens === 0) return null;
  // A buy spends SOL and gains tokens; a sell does the reverse. Ignore plain transfers.
  if ((tokens > 0 && sol >= 0) || (tokens < 0 && sol <= 0)) return null;

  const before = pre.get(mint) || 0;
  const after = post.get(mint) || 0;
  return {
    signature: tx.transaction.signatures[0],
    // For sells: how much of their bag they dumped (100 = sold everything).
    pctOfPosition: tokens < 0 && before > 0 ? Math.min(100, (Math.abs(tokens) / before) * 100) : null,
    soldAll: tokens < 0 && after < 1e-9,
    time: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
    wallet: trader,
    mint,
    side: tokens > 0 ? "buy" : "sell",
    tokenAmount: Math.abs(tokens),
    solAmount: Math.abs(sol),
    source: "rpc"
  };
}

class TradeWatcher extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(1000);
    this.wallets = store.load("wallets.json", []); // [{address, label}]
    this.tokenWatchers = new Map(); // client id -> Set(mint)
    this.pools = new Map(); // mint -> pairAddress
    this.created = new Map(); // mint -> pool creation time (for sniper icon)
    this.lastSig = new Map(); // address -> newest signature seen
    this.seen = new Set();
    this.recent = new Map(); // mint -> recent trades
    this.walletTrades = store.load("wallet-trades.json", []);
    this.solPrice = null;
    this.status = { pumpportal: "off", rpc: "idle" };
  }

  start() {
    this.connectPumpPortal();
    this.loop(() => this.pollTokens(), TOKEN_POLL_MS);
    this.loop(() => this.pollWallets(), WALLET_POLL_MS);
    this.loop(() => this.refreshSolPrice(), 30000);
  }

  loop(fn, ms) {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } catch (e) { this.status.rpc = "error: " + e.message; } finally { busy = false; }
    };
    run();
    setInterval(run, ms);
  }

  async refreshSolPrice() {
    const t = (await dex.tokens("solana", [SOL_MINT], 0)).get(SOL_MINT);
    if (t?.priceUsd) this.solPrice = t.priceUsd;
  }

  // ---- which tokens are open in someone's browser ------------------------------------
  watchTokens(id, mints) {
    const set = new Set(mints.filter(isSolanaAddress));
    this.tokenWatchers.set(id, set);
    this.resubscribe();
  }

  unwatch(id) {
    this.tokenWatchers.delete(id);
  }

  watchedMints() {
    const all = new Set();
    for (const s of this.tokenWatchers.values()) for (const m of s) all.add(m);
    return [...all];
  }

  // ---- PumpPortal (real-time push) ----------------------------------------------------
  connectPumpPortal(backoff = 1000) {
    if (typeof WebSocket === "undefined") return;
    let ws;
    try {
      ws = new WebSocket(PUMPPORTAL_WS);
    } catch {
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.status.pumpportal = "live";
      this.subscribed = { tokens: new Set(), wallets: new Set() };
      this.resubscribe();
      backoff = 1000;
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.txType !== "buy" && m.txType !== "sell") return;
      this.ingest({
        signature: m.signature,
        time: Date.now(),
        wallet: m.traderPublicKey,
        mint: m.mint,
        side: m.txType,
        tokenAmount: Number(m.tokenAmount) || 0,
        solAmount: Number(m.solAmount) || 0,
        marketCapSol: m.marketCapSol ?? null,
        source: "pumpportal"
      });
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status.pumpportal = "reconnecting";
      setTimeout(() => this.connectPumpPortal(Math.min(backoff * 2, 60000)), backoff);
    };
  }

  resubscribe() {
    if (!this.ws || this.ws.readyState !== 1 || !this.subscribed) return;
    const send = (method, keys) => keys.length && this.ws.send(JSON.stringify({ method, keys }));
    const mints = this.watchedMints();
    const wallets = this.wallets.map(w => w.address);
    send("subscribeTokenTrade", mints.filter(m => !this.subscribed.tokens.has(m)));
    send("unsubscribeTokenTrade", [...this.subscribed.tokens].filter(m => !mints.includes(m)));
    send("subscribeAccountTrade", wallets.filter(w => !this.subscribed.wallets.has(w)));
    send("unsubscribeAccountTrade", [...this.subscribed.wallets].filter(w => !wallets.includes(w)));
    this.subscribed = { tokens: new Set(mints), wallets: new Set(wallets) };
  }

  // ---- Solana RPC polling (any DEX) ---------------------------------------------------
  async newTransactions(address, limit) {
    const sigs = await rpc("getSignaturesForAddress", [address, { limit }]);
    const prev = this.lastSig.get(address);
    if (sigs[0]) this.lastSig.set(address, sigs[0].signature);
    if (!prev) return []; // first look: just remember where we are
    const fresh = [];
    for (const s of sigs) {
      if (s.signature === prev) break;
      if (!s.err && !this.seen.has(s.signature)) fresh.push(s.signature);
    }
    return Promise.all(fresh.slice(0, 10).reverse().map(sig =>
      rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]).catch(() => null)));
  }

  async poolFor(mint) {
    if (!this.pools.has(mint)) {
      const t = (await dex.tokens("solana", [mint])).get(mint);
      this.pools.set(mint, t?.pairAddress || null);
      if (t?.pairCreatedAt) this.created.set(mint, t.pairCreatedAt);
    }
    return this.pools.get(mint);
  }

  async pollTokens() {
    for (const mint of this.watchedMints().slice(0, 10)) {
      const pool = await this.poolFor(mint);
      if (!pool) continue;
      for (const tx of await this.newTransactions(pool, 25)) {
        const trade = parseSwap(tx, null, mint);
        if (trade) this.ingest(trade);
      }
    }
    this.status.rpc = "live";
  }

  async pollWallets() {
    for (const w of this.wallets) {
      for (const tx of await this.newTransactions(w.address, 10)) {
        const trade = parseSwap(tx, w.address);
        if (trade) this.ingest(trade);
      }
    }
  }

  // ---- common path ----------------------------------------------------------------------
  ingest(trade) {
    if (!trade.signature || this.seen.has(trade.signature + trade.wallet)) return;
    this.seen.add(trade.signature + trade.wallet);
    if (this.seen.size > 50000) this.seen = new Set([...this.seen].slice(-20000));

    trade.usd = this.solPrice ? trade.solAmount * this.solPrice : null;
    trade.badges = this.badges(trade);
    const followed = this.wallets.find(w => w.address === trade.wallet);
    if (followed) trade.walletLabel = followed.label;

    const list = this.recent.get(trade.mint) || [];
    list.unshift(trade);
    list.length = Math.min(list.length, MAX_RECENT);
    this.recent.set(trade.mint, list);
    this.emit("trade", trade);

    if (followed) this.walletAlert(trade);
  }

  // Axiom-style trader icons.
  badges(trade) {
    const b = [];
    const followed = this.wallets.find(w => w.address === trade.wallet);
    if (followed) b.push({ icon: "⭐", label: followed.label });
    const usd = trade.usd;
    if (usd != null) {
      if (usd >= 5000) b.push({ icon: "🐋", label: "Whale ($5k+)" });
      else if (usd >= 1000) b.push({ icon: "🐬", label: "Dolphin ($1k+)" });
      else if (usd >= 100) b.push({ icon: "🐟", label: "Fish ($100+)" });
      else b.push({ icon: "🦐", label: "Shrimp (<$100)" });
    }
    const created = this.created.get(trade.mint);
    if (trade.side === "buy" && created && trade.time - created < 5 * 60000) b.push({ icon: "🎯", label: "Sniper (bought in first 5 min)" });
    if (trade.side === "sell" && trade.soldAll) b.push({ icon: "🚪", label: "Sold entire bag" });
    else if (trade.side === "sell" && trade.pctOfPosition >= 50) b.push({ icon: "📉", label: `Sold ${Math.round(trade.pctOfPosition)}% of bag` });
    if (trade.side === "buy" && this.boughtBefore(trade)) b.push({ icon: "🔁", label: "Buying more" });
    return b;
  }

  boughtBefore(trade) {
    return (this.recent.get(trade.mint) || []).some(t => t.wallet === trade.wallet && t.side === "buy" && t.signature !== trade.signature);
  }

  async walletAlert(trade) {
    const t = (await dex.tokens("solana", [trade.mint]).catch(() => new Map())).get(trade.mint);
    const alert = { ...trade, symbol: t?.symbol || null, name: t?.name || null, marketCap: t?.marketCap ?? null, url: t?.url || `https://dexscreener.com/solana/${trade.mint}` };
    this.walletTrades.unshift(alert);
    this.walletTrades.length = Math.min(this.walletTrades.length, 300);
    store.save("wallet-trades.json", this.walletTrades);
    this.emit("wallet-trade", alert);
  }

  recentTrades(mint) {
    return this.recent.get(mint) || [];
  }

  addWallet(address, label) {
    address = String(address || "").trim();
    if (!isSolanaAddress(address)) throw new Error("Not a valid Solana wallet address");
    if (!this.wallets.some(w => w.address === address)) {
      this.wallets.push({ address, label: String(label || "").trim().slice(0, 40) || address.slice(0, 4) + "…" + address.slice(-4) });
      store.save("wallets.json", this.wallets);
      this.resubscribe();
    }
    return this.wallets;
  }

  removeWallet(address) {
    this.wallets = this.wallets.filter(w => w.address !== address);
    this.lastSig.delete(address);
    store.save("wallets.json", this.wallets);
    this.resubscribe();
    return this.wallets;
  }
}

module.exports = { TradeWatcher, parseSwap };
