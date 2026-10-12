const express = require("express");
const path = require("path");
const { extractTickers, isSolanaAddress } = require("./lib/parse");
const dex = require("./lib/dex");
const { KolTracker } = require("./lib/kols");
const { createSignals } = require("./lib/signals");
const { LiveEngine, TICK_MS } = require("./lib/live");
const { TradeWatcher } = require("./lib/trades");
const { checkRug } = require("./lib/rug");
const chart = require("./lib/chart");
const notify = require("./lib/notify");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.X_BEARER_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const INGEST_SECRET = process.env.INGEST_SECRET;

const tracker = new KolTracker({
  token: TOKEN,
  pollMs: Number(process.env.KOL_POLL_SECONDS || 15) * 1000,
  alertAll: process.env.KOL_ALERT_ALL === "1",
  useStream: process.env.KOL_STREAM !== "0"
});
const signals = createSignals(tracker);
tracker.analyzer = signals;
const live = new LiveEngine(signals);
const trades = new TradeWatcher();

const CHAIN_RE = /^[a-z0-9-]{2,20}$/;
const ADDR_RE = /^[A-Za-z0-9]{20,64}$/;

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor", express.static(path.join(path.dirname(require.resolve("lightweight-charts/package.json")), "dist")));

// If ADMIN_TOKEN is set, editing the KOL list / clearing alerts needs it (x-admin-token header).
function admin(req, res, next) {
  if (ADMIN_TOKEN && req.get("x-admin-token") !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Admin token required" });
  }
  next();
}

const wrap = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(e => res.status(502).json({ error: e.message }));

// ---- Radar: ticker mentions across all of X ------------------------------------------
app.get("/api/search", wrap(async (req, res) => {
  if (!TOKEN) return res.status(500).json({ error: "X_BEARER_TOKEN is not configured." });

  const query = String(req.query.q || "$PEPE OR $DOGE OR $SHIB OR $BONK OR $WIF").slice(0, 480);
  const params = new URLSearchParams({
    query: `(${query}) -is:retweet`,
    max_results: "100",
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username"
  });

  const response = await fetch("https://api.x.com/2/tweets/search/recent?" + params, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const data = await response.json();
  if (!response.ok) return res.status(response.status).json(data);

  const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u.username]));
  const posts = (data.data || []).map(tweet => ({
    id: tweet.id,
    text: tweet.text,
    created_at: tweet.created_at,
    author: users[tweet.author_id] || "unknown",
    metrics: tweet.public_metrics || {},
    tickers: extractTickers(tweet.text)
  }));
  res.json({ posts });
}));

// ---- Coin tracker: prices via DexScreener --------------------------------------------
app.get("/api/coins/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q is required" });
  res.json({ results: (await dex.search(q)).slice(0, 20) });
}));

app.get("/api/coins/tokens", wrap(async (req, res) => {
  const chain = String(req.query.chain || "solana").toLowerCase();
  if (!/^[a-z0-9-]{2,20}$/.test(chain)) return res.status(400).json({ error: "Invalid chain" });
  const addresses = String(req.query.addresses || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 60);
  if (!addresses.length) return res.json({ tokens: [] });
  res.json({ tokens: [...(await dex.tokens(chain, addresses)).values()] });
}));

// ---- Signals: what has the best odds of going up, with rug checks -------------------
app.get("/api/signals", wrap(async (req, res) => {
  const rows = live.top.length ? live.top : await signals.discover("solana");
  res.json({ rows, tickMs: TICK_MS });
}));

app.get("/api/analyze", wrap(async (req, res) => {
  const chain = String(req.query.chain || "solana").toLowerCase();
  if (!CHAIN_RE.test(chain)) return res.status(400).json({ error: "Invalid chain" });
  const addresses = String(req.query.addresses || "").split(",").map(s => s.trim()).filter(a => ADDR_RE.test(a)).slice(0, 60);
  res.json({ rows: addresses.length ? await signals.analyze(chain, addresses) : [] });
}));

app.get("/api/coin/:chain/:address", wrap(async (req, res) => {
  const { chain, address } = req.params;
  if (!CHAIN_RE.test(chain) || !ADDR_RE.test(address)) return res.status(400).json({ error: "Invalid coin" });
  const [row] = await signals.analyze(chain, [address], { maxAge: 2000 });
  if (!row) return res.status(404).json({ error: "No trading pool found for this address" });
  res.json({ coin: row, trades: trades.recentTrades(address) });
}));

app.get("/api/rugcheck/:chain/:address", wrap(async (req, res) => {
  const { chain, address } = req.params;
  if (!CHAIN_RE.test(chain) || !ADDR_RE.test(address)) return res.status(400).json({ error: "Invalid coin" });
  const t = (await dex.tokens(chain, [address])).get(address);
  if (!t) return res.status(404).json({ error: "No trading pool found for this address" });
  res.json({ token: t, rug: await checkRug(t) });
}));

app.get("/api/chart/:chain/:address", wrap(async (req, res) => {
  const { chain, address } = req.params;
  if (!CHAIN_RE.test(chain) || !ADDR_RE.test(address)) return res.status(400).json({ error: "Invalid coin" });
  const t = (await dex.tokens(chain, [address])).get(address);
  if (!t) return res.status(404).json({ error: "No trading pool found for this address" });
  const tf = ["minute", "hour", "day"].includes(req.query.tf) ? req.query.tf : "minute";
  const aggregate = Math.max(1, Math.min(15, Number(req.query.agg) || 1));
  res.json(await chart.candles({ ...t, tf, aggregate }));
}));

// ---- Wallet tracker: get pinged when wallets you follow buy/sell ------------------------
app.get("/api/wallets", (req, res) => res.json({ wallets: trades.wallets, trades: trades.walletTrades, status: trades.status }));

app.post("/api/wallets", admin, (req, res) => {
  try {
    res.json({ wallets: trades.addWallet(req.body?.address, req.body?.label) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/wallets/:address", admin, (req, res) => res.json({ wallets: trades.removeWallet(req.params.address) }));

// ---- KOL tweet alerts (J7-style tracker) ---------------------------------------------
app.get("/api/kols", (req, res) => res.json({ kols: tracker.kols, status: tracker.status }));

app.post("/api/kols", admin, (req, res) => {
  try {
    res.json({ kols: tracker.addKol(req.body?.handle, req.body?.name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/kols/:handle", admin, (req, res) => res.json({ kols: tracker.removeKol(req.params.handle) }));

app.get("/api/alerts", (req, res) => res.json({
  alerts: tracker.alerts,
  status: tracker.status,
  externalNotify: notify.enabled()
}));

app.delete("/api/alerts", admin, (req, res) => {
  tracker.clearAlerts();
  res.json({ ok: true });
});

// Fire a fake alert so you can check notifications/sound/Discord/Telegram end to end.
app.post("/api/alerts/test", admin, wrap(async (req, res) => {
  const alert = await tracker.handleTweet({
    id: "test-" + Date.now(),
    handle: "elonmusk",
    name: "Elon Musk (TEST)",
    text: "TEST ALERT — $DOGE to the moon 🚀",
    url: "https://x.com/elonmusk"
  }, { source: "test" });
  res.json({ alert });
}));

// Push tweets in from any other tracker (e.g. a J7 Tracker / Discord / Zapier / IFTTT
// webhook). Body: { handle, text, url?, id?, name?, created_at? }
app.post("/api/ingest", wrap(async (req, res) => {
  if (INGEST_SECRET && req.get("x-ingest-secret") !== INGEST_SECRET && req.query.secret !== INGEST_SECRET) {
    return res.status(401).json({ error: "Bad ingest secret" });
  }
  const { handle, text } = req.body || {};
  if (!handle || !text) return res.status(400).json({ error: "handle and text are required" });
  const idFromUrl = String(req.body.url || "").match(/status\/(\d+)/)?.[1];
  const alert = await tracker.handleTweet({
    id: String(req.body.id || idFromUrl || "ingest-" + Date.now()),
    handle: String(handle).replace(/^@/, ""),
    name: req.body.name,
    text: String(text),
    url: req.body.url,
    created_at: req.body.created_at,
    expandedUrls: [].concat(req.body.urls || [])
  }, { source: "ingest" });
  res.json({ alert, skipped: !alert });
}));

// One live stream per browser: KOL alerts, signal list, ~2s price ticks, live trades.
const clients = new Map();

function parseWatch(id, body) {
  const watch = [].concat(body.watch || []).map(String).filter(k => /^[a-z0-9-]{2,20}:[A-Za-z0-9]{20,64}$/.test(k)).slice(0, 60);
  const open = [].concat(body.open || []).map(String).filter(a => ADDR_RE.test(a)).slice(0, 3);
  live.watch(id, [...watch, ...open.map(a => "solana:" + a)]);
  trades.watchTokens(id, open);
  const c = clients.get(id);
  if (c) c.open = new Set(open);
}

app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const id = crypto.randomUUID();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const client = { open: new Set() };
  clients.set(id, client);
  parseWatch(id, { watch: String(req.query.watch || "").split(","), open: String(req.query.open || "").split(",") });

  const handlers = {
    alert: a => send("alert", a),
    "alert-update": a => send("alert-update", a),
    status: s => send("status", s)
  };
  for (const [ev, fn] of Object.entries(handlers)) tracker.on(ev, fn);
  const onSignals = d => send("signals", d);
  const onPrices = d => send("prices", d);
  const onTrade = t => { if (client.open.has(t.mint)) send("trade", t); };
  const onWalletTrade = t => send("wallet-trade", t);
  live.on("signals", onSignals);
  live.on("prices", onPrices);
  trades.on("trade", onTrade);
  trades.on("wallet-trade", onWalletTrade);

  send("hello", { id, tickMs: TICK_MS });
  send("status", tracker.status);
  if (live.top.length) send("signals", { at: Date.now(), rows: live.top });
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);

  req.on("close", () => {
    clearInterval(ping);
    for (const [ev, fn] of Object.entries(handlers)) tracker.off(ev, fn);
    live.off("signals", onSignals);
    live.off("prices", onPrices);
    trades.off("trade", onTrade);
    trades.off("wallet-trade", onWalletTrade);
    live.unwatch(id);
    trades.unwatch(id);
    clients.delete(id);
  });
});

// Change what a stream is watching without reconnecting.
app.post("/api/stream/:id/watch", (req, res) => {
  if (!clients.has(req.params.id)) return res.status(404).json({ error: "Unknown stream" });
  parseWatch(req.params.id, req.body || {});
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Meme Radar running on http://localhost:${PORT}`);
    if (!TOKEN) console.log("X_BEARER_TOKEN not set — radar and KOL alerts are off (ingest/test still work).");
    tracker.start();
    live.start();
    trades.start();
  });
}

module.exports = { app, tracker, live, trades };
