// Meme Radar client: live signals, watchlist, KOL alerts, wallet tracker, coin chart + trades.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const compact = n => n == null || isNaN(n) ? "—" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: n < 1000 ? 2 : 1 }).format(n);
const usd = n => n == null || isNaN(n) ? "—" : "$" + compact(n);
const pct = n => n == null ? "—" : `${n > 0 ? "+" : ""}${Number(n).toFixed(Math.abs(n) < 10 ? 1 : 0)}%`;
const cls = n => n == null ? "" : n >= 0 ? "green" : "red";
const short = a => a ? a.slice(0, 4) + "…" + a.slice(-4) : "";
const ago = t => {
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  return s < 60 ? Math.floor(s) + "s" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d";
};
// $0.00001234 -> $0.0₄1234 (subscript zero count, like most DEX UIs)
function price(n) {
  if (n == null) return "—";
  if (n >= 1) return "$" + n.toLocaleString("en", { maximumFractionDigits: 4 });
  const s = n.toFixed(20).slice(2);
  const zeros = s.match(/^0*/)[0].length;
  if (zeros < 4) return "$" + n.toPrecision(4);
  const sub = String(zeros).split("").map(d => "₀₁₂₃₄₅₆₇₈₉"[d]).join("");
  return `$0.0${sub}${s.slice(zeros, zeros + 4)}`;
}
const key = t => `${t.chain}:${t.address}`;
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// The page only works when served by `npm start`; explain that instead of "Failed to fetch".
const SERVER_DOWN = location.protocol === "file:"
  ? "This page was opened as a file. Run `npm start` in the meme-radar folder and open http://localhost:3000 instead."
  : "Can't reach the Meme Radar server. Make sure `npm start` is still running in your terminal, then refresh.";

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(state.adminToken ? { "x-admin-token": state.adminToken } : {}), ...opts.headers }
    });
  } catch {
    throw new Error(SERVER_DOWN);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && /Admin/.test(data.error || "")) {
    const t = prompt("Admin token (set by ADMIN_TOKEN on the server):");
    if (t) { state.adminToken = t; save("adminToken", t); return api(path, opts); }
  }
  if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
  return data;
}

// ---------- state ----------
const state = {
  tab: "signals",
  filter: "all",
  signals: [],
  watch: load("watchlist", []),          // [{chain,address}]
  coins: new Map(),                       // key -> latest analyzed row
  spark: new Map(),                       // key -> [mcap...]
  alerts: [],
  unseenAlerts: 0,
  unseenWallet: 0,
  streamId: null,
  open: null,                             // coin currently open in the sheet
  adminToken: load("adminToken", null),
  sound: true
};

// ---------- tabs ----------
$$("nav button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(tab) {
  state.tab = tab;
  $$("nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab").forEach(s => s.classList.toggle("active", s.id === "tab-" + tab));
  if (tab === "alerts") { state.unseenAlerts = 0; badge("#alertBadge", 0); }
  if (tab === "wallets") { state.unseenWallet = 0; badge("#walletBadge", 0); }
  if (tab === "radar" && !state.radarLoaded) { state.radarLoaded = true; scanRadar(); }
}
function badge(sel, n) { const el = $(sel); el.hidden = !n; el.textContent = n > 99 ? "99+" : n; }

// ---------- coin cards ----------
function sparkSvg(k) {
  const pts = state.spark.get(k) || [];
  if (pts.length < 2) return "";
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const d = pts.map((v, i) => `${(i / (pts.length - 1) * 100).toFixed(1)},${(30 - (v - lo) / span * 28).toFixed(1)}`).join(" ");
  const up = pts[pts.length - 1] >= pts[0];
  return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none"><polyline fill="none" stroke="${up ? "#3ee07a" : "#ff5b6b"}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${d}"/></svg>`;
}
function logo(t) {
  return t.image ? `<img class="logo" src="${esc(t.image)}" alt="" loading="lazy">` : `<div class="logo">${esc((t.symbol || "?").slice(0, 3))}</div>`;
}
function caBox(t) {
  return `<div class="ca" onclick="event.stopPropagation()"><span class="muted">CA</span><code>${esc(t.address)}</code><button data-copy="${esc(t.address)}">Copy</button></div>`;
}
function coinCard(t, { reasons = true } = {}) {
  const k = key(t);
  return `<div class="card coin" data-key="${esc(k)}">
    <div class="coin-top">
      ${logo(t)}
      <div class="grow">
        <div class="row"><span class="sym">${esc(t.symbol)}</span><span class="badge ${t.signal}">${t.signal === "BUY" ? "🟢 BUY" : t.signal === "WATCH" ? "🟡 WATCH" : "🔴 AVOID"}</span></div>
        <div class="name">${esc(t.name)} · <span class="risk-${t.rug?.verdict}">rug risk ${esc(t.rug?.verdict)} (${t.rug?.risk ?? "?"})</span></div>
      </div>
      <div class="score">${t.score}<small>UPSIDE</small></div>
    </div>
    <div class="metrics">
      <div><b>${usd(t.marketCap)}</b><span>MCAP</span></div>
      <div><b>${price(t.priceUsd)}</b><span>PRICE</span></div>
      <div><b class="${cls(t.change?.h1)}">${pct(t.change?.h1)}</b><span>1H</span></div>
      <div><b>${usd(t.liquidity)}</b><span>LIQ</span></div>
    </div>
    ${sparkSvg(k)}
    ${reasons && t.reasons?.length ? `<ul class="reasons">${t.reasons.slice(0, 3).map(r => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    ${caBox(t)}
  </div>`;
}

document.addEventListener("click", e => {
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => { copy.textContent = "Copied ✓"; setTimeout(() => copy.textContent = "Copy", 1200); });
    return;
  }
  const coin = e.target.closest("[data-key]");
  if (coin && !e.target.closest("a,button")) openCoin(coin.dataset.key);
});

// ---------- signals ----------
$$(".filters .chip").forEach(c => c.onclick = () => {
  state.filter = c.dataset.filter;
  $$(".filters .chip").forEach(x => x.classList.toggle("active", x === c));
  renderSignals();
});
function renderSignals() {
  const rows = state.signals.filter(r => state.filter === "all" || r.signal === state.filter);
  $("#signals").innerHTML = rows.length ? rows.map(r => coinCard(state.coins.get(key(r)) || r)).join("")
    : `<div class="card muted">${state.signals.length ? "Nothing in this filter right now." : "Scanning trending coins…"}</div>`;
}

// ---------- watchlist ----------
function renderWatch() {
  if (!state.watch.length) { $("#watchlist").innerHTML = `<div class="card muted">Add coins by contract address or search. They update live every couple of seconds.</div>`; return; }
  $("#watchlist").innerHTML = state.watch.map(w => {
    const t = state.coins.get(key(w));
    return t ? coinCard(t) : `<div class="card coin" data-key="${esc(key(w))}"><b>${esc(short(w.address))}</b> <span class="muted">loading…</span>${caBox(w)}</div>`;
  }).join("");
}
function toggleWatch(chain, address) {
  const i = state.watch.findIndex(w => w.chain === chain && w.address === address);
  if (i >= 0) state.watch.splice(i, 1); else state.watch.unshift({ chain, address });
  save("watchlist", state.watch);
  renderWatch();
  updateWatch();
  refreshWatch();
}
async function refreshWatch() {
  const byChain = {};
  for (const w of state.watch) (byChain[w.chain] ||= []).push(w.address);
  for (const [chain, addrs] of Object.entries(byChain)) {
    try { ingestRows((await api(`/api/analyze?chain=${chain}&addresses=${addrs.join(",")}`)).rows); } catch {}
  }
  renderWatch();
}
$("#watchForm").onsubmit = async e => {
  e.preventDefault();
  const q = $("#watchInput").value.trim();
  if (!q) return;
  $("#searchResults").innerHTML = `<div class="card muted">Searching…</div>`;
  try {
    const { results } = await api("/api/coins/search?q=" + encodeURIComponent(q));
    // A pasted contract address that matches exactly: add it straight away.
    const exact = results.find(r => r.address?.toLowerCase() === q.toLowerCase());
    if (exact) { $("#searchResults").innerHTML = ""; $("#watchInput").value = ""; return toggleWatch(exact.chain, exact.address); }
    $("#searchResults").innerHTML = results.length ? results.slice(0, 8).map(r => `
      <div class="card">
        <div class="coin-top">${logo(r)}<div class="grow"><span class="sym">${esc(r.symbol)}</span> <span class="muted small">${esc(r.chain)}</span>
        <div class="name">${esc(r.name)} · mcap ${usd(r.marketCap)} · liq ${usd(r.liquidity)}</div></div>
        <button class="ghost" data-add="${esc(r.chain)}|${esc(r.address)}">+ Add</button></div>
        ${caBox(r)}
      </div>`).join("") : `<div class="card muted">No coins found.</div>`;
  } catch (err) { $("#searchResults").innerHTML = `<div class="card red">${esc(err.message)}</div>`; }
};
$("#searchResults").addEventListener("click", e => {
  const b = e.target.closest("[data-add]");
  if (!b) return;
  const [chain, address] = b.dataset.add.split("|");
  toggleWatch(chain, address);
  b.textContent = "✓ Added"; b.disabled = true;
});

// ---------- live rows ----------
function ingestRows(rows) {
  for (const r of rows || []) {
    const k = key(r);
    state.coins.set(k, r);
    if (r.marketCap != null) {
      const s = state.spark.get(k) || [];
      if (s[s.length - 1] !== r.marketCap) s.push(r.marketCap);
      if (s.length > 90) s.shift();
      state.spark.set(k, s);
    }
    if (state.open && key(state.open) === k) updateOpenCoin(r);
  }
}

// ---------- KOL alerts ----------
function alertCard(a, fresh) {
  return `<div class="card alert ${fresh ? "fresh" : ""}" data-alert="${esc(a.id)}">
    <div class="row">
      <div class="who">${a.avatar ? `<img src="${esc(a.avatar)}" alt="">` : ""}<div><b>${esc(a.name)}</b> <span class="muted">@${esc(a.handle)}</span></div></div>
      <a class="muted small" href="${esc(a.url)}" target="_blank" rel="noopener">${ago(a.created_at)} ago ↗</a>
    </div>
    <div class="tweet">${esc(a.text)}</div>
    ${a.tickers.length ? `<div class="small">${a.tickers.map(t => `<b class="yellow">${esc(t)}</b>`).join(" ")}</div>` : ""}
    ${(a.tokens || []).map(t => `<div class="mini-coin" data-key="${esc(key(t))}">
        <div class="row"><b>${esc(t.symbol)}</b>${t.signal ? `<span class="badge ${t.signal}">${t.signal}</span>` : ""}</div>
        <div class="small muted">mcap ${usd(t.marketCap)} · liq ${usd(t.liquidity)} · 1h <span class="${cls(t.change?.h1)}">${pct(t.change?.h1)}</span>${t.rug ? ` · <span class="risk-${t.rug.verdict}">rug risk ${t.rug.verdict}</span>` : ""}</div>
        ${caBox(t)}</div>`).join("")}
    ${!(a.tokens || []).length ? a.addresses.map(c => caBox(c)).join("") : ""}
    ${a.source === "test" ? `<div class="small muted">Test alert</div>` : ""}
  </div>`;
}
function renderAlerts() {
  $("#alerts").innerHTML = state.alerts.length ? state.alerts.map(a => alertCard(a)).join("")
    : `<div class="card muted">No alerts yet. When a tracked account tweets a ticker, contract address or coin talk, it shows up here instantly.</div>`;
}
function renderKolStatus(s) {
  if (!s) return;
  const modes = { stream: "⚡ real-time stream", polling: "polling" };
  $("#kolMode").textContent = s.state === "no-token" ? "X_BEARER_TOKEN not set" : `${modes[s.mode] || ""} ${s.state}`;
  $("#kolError").textContent = [s.error, s.note].filter(Boolean).join(" · ");
}
async function loadAlerts() {
  try {
    const d = await api("/api/alerts");
    state.alerts = d.alerts;
    renderAlerts();
    renderKolStatus(d.status);
  } catch {}
}
async function loadKols() {
  const { kols } = await api("/api/kols");
  renderKols(kols);
}
function renderKols(kols) {
  $("#kolCount").textContent = kols.length;
  $("#kolList").innerHTML = kols.map(k => `<span class="tag">@${esc(k.handle)}<button data-kol="${esc(k.handle)}" title="Stop tracking">✕</button></span>`).join("");
}
$("#toggleKols").onclick = () => { $("#kolEditor").hidden = !$("#kolEditor").hidden; };
$("#kolForm").onsubmit = async e => {
  e.preventDefault();
  try { renderKols((await api("/api/kols", { method: "POST", body: JSON.stringify({ handle: $("#kolInput").value }) })).kols); $("#kolInput").value = ""; }
  catch (err) { toast("⚠️ " + err.message); }
};
$("#kolList").onclick = async e => {
  const b = e.target.closest("[data-kol]");
  if (b) renderKols((await api("/api/kols/" + encodeURIComponent(b.dataset.kol), { method: "DELETE" })).kols);
};
$("#testAlert").onclick = () => api("/api/alerts/test", { method: "POST" }).catch(err => toast("⚠️ " + err.message));

// ---------- wallet tracker ----------
function walletTradeRow(t) {
  return `<div class="card" ${t.mint ? `data-key="solana:${esc(t.mint)}"` : ""}>
    <div class="row"><b>${t.side === "buy" ? "🟢" : "🔴"} ${esc(t.walletLabel || short(t.wallet))} ${t.side === "buy" ? "bought" : "sold"} ${esc(t.symbol || short(t.mint))}</b>
    <span class="muted small">${ago(t.time)} ago</span></div>
    <div class="small"><b class="${t.side === "buy" ? "green" : "red"}">${usd(t.usd)}</b> (${compact(t.solAmount)} SOL)
      ${t.side === "sell" && t.pctOfPosition != null ? ` · sold ${Math.round(t.pctOfPosition)}% of bag` : ""}
      · mcap ${usd(t.marketCap)} <span class="icons">${(t.badges || []).map(b => `<span title="${esc(b.label)}">${b.icon}</span>`).join("")}</span></div>
    ${caBox({ address: t.mint })}
  </div>`;
}
async function loadWallets() {
  try {
    const d = await api("/api/wallets");
    renderWalletList(d.wallets);
    state.walletTrades = d.trades;
    renderWalletTrades();
  } catch {}
}
function renderWalletList(ws) {
  $("#walletList").innerHTML = ws.map(w => `<span class="tag" title="${esc(w.address)}">${esc(w.label)} <span class="muted">${esc(short(w.address))}</span><button data-wallet="${esc(w.address)}">✕</button></span>`).join("");
}
function renderWalletTrades() {
  $("#walletTrades").innerHTML = (state.walletTrades || []).length ? state.walletTrades.slice(0, 100).map(walletTradeRow).join("")
    : `<div class="card muted">Follow a wallet and its buys/sells show up here the moment they land on-chain.</div>`;
}
$("#walletForm").onsubmit = async e => {
  e.preventDefault();
  try {
    renderWalletList((await api("/api/wallets", { method: "POST", body: JSON.stringify({ address: $("#walletAddr").value, label: $("#walletLabel").value }) })).wallets);
    $("#walletAddr").value = $("#walletLabel").value = "";
  } catch (err) { toast("⚠️ " + err.message); }
};
$("#walletList").onclick = async e => {
  const b = e.target.closest("[data-wallet]");
  if (b) renderWalletList((await api("/api/wallets/" + b.dataset.wallet, { method: "DELETE" })).wallets);
};

// ---------- coin sheet: chart + live trades ----------
const chartState = { chart: null, series: null, vol: null, tf: "minute", agg: 1, candles: [], trades: [], minTrade: 50, supply: null };

function bucketSec() { return (chartState.tf === "hour" ? 3600 : 60) * chartState.agg; }

async function openCoin(k) {
  const [chain, address] = k.split(":");
  state.open = { chain, address };
  chartState.trades = [];
  $("#coinView").hidden = false;
  document.body.style.overflow = "hidden";
  $("#coinTitle").innerHTML = `<b>${esc(state.coins.get(k)?.symbol || short(address))}</b>`;
  $("#trades").innerHTML = `<div class="muted small">Waiting for trades…</div>`;
  $("#coinHeader").innerHTML = $("#coinSignal").innerHTML = $("#coinRug").innerHTML = "";
  $("#flow").textContent = "";
  updateStar();
  updateWatch();
  try {
    const { coin, trades } = await api(`/api/coin/${chain}/${address}`);
    ingestRows([coin]);
    updateOpenCoin(coin);
    chartState.trades = trades;
    renderTrades();
  } catch (err) {
    $("#coinHeader").innerHTML = `<div class="card red">${esc(err.message)}</div>`;
  }
  if (chain !== "solana") $("#trades").innerHTML = `<div class="muted small">Live trade feed is available for Solana coins.</div>`;
  loadChart();
}
function closeCoin() {
  $("#coinView").hidden = true;
  document.body.style.overflow = "";
  state.open = null;
  updateWatch();
}
$("#closeCoin").onclick = closeCoin;
$("#coinStar").onclick = () => { if (state.open) { toggleWatch(state.open.chain, state.open.address); updateStar(); } };
function updateStar() {
  const on = state.open && state.watch.some(w => w.chain === state.open.chain && w.address === state.open.address);
  $("#coinStar").textContent = on ? "★" : "☆";
}

function updateOpenCoin(t) {
  if (t.priceUsd && t.marketCap) chartState.supply = t.marketCap / t.priceUsd;
  $("#coinTitle").innerHTML = `<b>${esc(t.symbol)}</b> <span class="muted small">${esc(t.name)}</span>`;
  $("#coinHeader").innerHTML = `
    <div class="row"><div class="coin-top">${logo(t)}<div><div class="big-price">${usd(t.marketCap)} <span class="muted small">MCAP</span></div>
      <div>${price(t.priceUsd)} <span class="${cls(t.change?.m5)}">5m ${pct(t.change?.m5)}</span> · <span class="${cls(t.change?.h1)}">1h ${pct(t.change?.h1)}</span> · <span class="${cls(t.change?.h24)}">24h ${pct(t.change?.h24)}</span></div></div></div>
      <a class="ghost small" href="${esc(t.url)}" target="_blank" rel="noopener" style="text-decoration:none">DexScreener ↗</a></div>
    <div class="metrics">
      <div><b>${usd(t.liquidity)}</b><span>LIQUIDITY</span></div>
      <div><b>${usd(t.volume24h)}</b><span>VOL 24H</span></div>
      <div><b><span class="green">${t.txns?.h1?.buys ?? "—"}</span>/<span class="red">${t.txns?.h1?.sells ?? "—"}</span></b><span>BUYS/SELLS 1H</span></div>
      <div><b>${t.pairCreatedAt ? ago(t.pairCreatedAt) : "—"}</b><span>AGE</span></div>
    </div>
    ${caBox(t)}`;
  $("#coinSignal").innerHTML = `
    <div class="row"><b>Upside score</b><span class="badge ${t.signal}">${t.signal}</span></div>
    <div class="score" style="text-align:left;margin:6px 0">${t.score}<small>/ 100</small></div>
    <ul class="reasons">${(t.reasons || []).map(r => `<li>${esc(r)}</li>`).join("") || "<li>No strong signals either way</li>"}</ul>`;
  const rug = t.rug || {};
  $("#coinRug").innerHTML = `
    <div class="row"><b>🛡️ Rug check</b><b class="risk-${rug.verdict}">${esc((rug.verdict || "?").toUpperCase())} RISK · ${rug.risk ?? "?"}/100</b></div>
    ${(rug.flags || []).map(f => `<div class="flag ${f.level}">${esc(f.msg)}</div>`).join("")}
    <div class="small muted" style="margin-top:6px">Sources: ${esc((rug.sources || []).join(", "))}</div>`;
  liveCandle(t);
}

async function loadChart() {
  const { chain, address } = state.open;
  if (!chartState.chart) initChart();
  $("#chartNote").textContent = "Loading chart…";
  try {
    const d = await api(`/api/chart/${chain}/${address}?tf=${chartState.tf}&agg=${chartState.agg}`);
    if (!state.open || state.open.address !== address) return;
    chartState.candles = d.candles;
    chartState.series.setData(d.candles);
    chartState.vol.setData(d.candles.map(c => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? "#3ee07a55" : "#ff5b6b55" })));
    chartState.chart.timeScale().scrollToRealTime();
    $("#chartNote").textContent = d.candles.length
      ? `${d.unit === "mcap" ? "Market cap" : "Price"} candles · ${d.source === "geckoterminal" ? "history from GeckoTerminal" : "recorded live"} · updates every ~2s · buy/sell markers show $ size`
      : "No candle history yet — chart fills in live from now.";
    drawMarkers();
  } catch (err) { $("#chartNote").textContent = "Chart unavailable: " + err.message; }
}

function initChart() {
  if (!window.LightweightCharts) { $("#chart").innerHTML = `<div class="muted small" style="padding:12px">Chart library failed to load.</div>`; return; }
  const el = $("#chart");
  chartState.chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: "#0b0f15" }, textColor: "#8491a2" },
    grid: { vertLines: { color: "#151c26" }, horzLines: { color: "#151c26" } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#25303d" },
    rightPriceScale: { borderColor: "#25303d" },
    localization: { priceFormatter: v => usd(v) }
  });
  chartState.series = chartState.chart.addCandlestickSeries({
    upColor: "#3ee07a", downColor: "#ff5b6b", wickUpColor: "#3ee07a", wickDownColor: "#ff5b6b", borderVisible: false,
    priceFormat: { type: "custom", formatter: v => usd(v), minMove: 1e-12 }
  });
  chartState.vol = chartState.chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chartState.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
}

// Move the last candle with every live tick (or start a new one).
function liveCandle(t) {
  if (!chartState.series || !chartState.candles.length) return;
  const v = t.marketCap ?? t.priceUsd;
  if (v == null) return;
  const b = bucketSec();
  const time = Math.floor(Date.now() / 1000 / b) * b;
  const last = chartState.candles[chartState.candles.length - 1];
  if (time < last.time) return;
  let c;
  if (time === last.time) { c = { ...last, high: Math.max(last.high, v), low: Math.min(last.low, v), close: v }; chartState.candles[chartState.candles.length - 1] = c; }
  else { c = { time, open: last.close, high: Math.max(last.close, v), low: Math.min(last.close, v), close: v }; chartState.candles.push(c); }
  chartState.series.update(c);
}

// One marker per candle per side: total $ bought/sold there + the biggest trader's icons.
function drawMarkers() {
  if (!chartState.series || !chartState.candles.length) return;
  const b = bucketSec();
  const first = chartState.candles[0].time, last = chartState.candles[chartState.candles.length - 1].time;
  const groups = new Map();
  for (const t of chartState.trades) {
    if ((t.usd ?? 0) < chartState.minTrade) continue;
    const time = Math.min(last, Math.floor(t.time / 1000 / b) * b);
    if (time < first) continue;
    const g = groups.get(time + t.side) || { time, side: t.side, usd: 0, n: 0, top: null, all: false };
    g.usd += t.usd || 0; g.n++;
    if (!g.top || (t.usd || 0) > (g.top.usd || 0)) g.top = t;
    if (t.soldAll) g.all = true;
    groups.set(time + t.side, g);
  }
  const markers = [...groups.values()].sort((a, b) => a.time - b.time).slice(-150).map(g => {
    const icons = (g.top.badges || []).map(x => x.icon).join("");
    const sold = g.side === "sell" && g.n === 1 && g.top.pctOfPosition != null ? ` ${Math.round(g.top.pctOfPosition)}%` : "";
    return {
      time: g.time,
      position: g.side === "buy" ? "belowBar" : "aboveBar",
      color: g.side === "buy" ? "#3ee07a" : "#ff5b6b",
      shape: g.side === "buy" ? "arrowUp" : "arrowDown",
      text: `${g.side === "buy" ? "B" : "S"} ${usd(g.usd)}${g.n > 1 ? " ×" + g.n : ""}${sold} ${icons}`
    };
  });
  chartState.series.setMarkers(markers);
}

function tradeRow(t, isNew) {
  const icons = (t.badges || []).map(b => `<span title="${esc(b.label)}">${b.icon}</span>`).join("");
  const how = t.side === "sell"
    ? (t.soldAll ? "sold ALL" : t.pctOfPosition != null ? `sold ${Math.round(t.pctOfPosition)}%` : "sold")
    : "bought";
  return `<div class="trade ${t.side} ${isNew ? "new" : ""}">
    <span class="muted">${ago(t.time)}</span>
    <span><span class="icons">${icons}</span> <a href="https://solscan.io/account/${esc(t.wallet)}" target="_blank" rel="noopener">${esc(t.walletLabel || short(t.wallet))}</a> <span class="muted">${how}</span></span>
    <span class="amt">${t.side === "buy" ? "+" : "−"}${usd(t.usd)}<br><span class="muted small" style="font-weight:400">${compact(t.solAmount)} SOL</span></span>
  </div>`;
}
function renderTrades() {
  const list = chartState.trades.filter(t => (t.usd ?? 0) >= chartState.minTrade || t.walletLabel);
  $("#trades").innerHTML = list.length ? list.slice(0, 100).map(t => tradeRow(t)).join("") : `<div class="muted small">Waiting for trades…</div>`;
  const since = Date.now() - 5 * 60000;
  let buy = 0, sell = 0;
  for (const t of chartState.trades) if (t.time > since) t.side === "buy" ? buy += t.usd || 0 : sell += t.usd || 0;
  $("#flow").innerHTML = buy || sell ? `5m flow: <span class="green">+${usd(buy)}</span> / <span class="red">−${usd(sell)}</span>` : "";
  drawMarkers();
}
$$(".tf .chip").forEach(c => c.onclick = () => {
  chartState.tf = c.dataset.tf; chartState.agg = Number(c.dataset.agg);
  $$(".tf .chip").forEach(x => x.classList.toggle("active", x === c));
  loadChart();
});
$("#minTrade").oninput = e => { chartState.minTrade = Number(e.target.value) || 0; renderTrades(); };

// ---------- live stream ----------
let es;
function connect() {
  const watch = state.watch.map(key).join(",");
  const open = state.open?.chain === "solana" ? state.open.address : "";
  es = new EventSource(`/api/stream?watch=${encodeURIComponent(watch)}&open=${encodeURIComponent(open)}`);
  es.addEventListener("hello", e => { state.streamId = JSON.parse(e.data).id; setStatus("live"); });
  es.addEventListener("signals", e => {
    const d = JSON.parse(e.data);
    if (d.rows?.length) { state.signals = d.rows; ingestRows(d.rows); }
    if (state.tab === "signals") renderSignals();
  });
  es.addEventListener("prices", e => {
    const d = JSON.parse(e.data);
    ingestRows(d.rows);
    $("#tick").textContent = new Date(d.at).toLocaleTimeString();
    if (state.tab === "signals") renderSignals();
    if (state.tab === "watch") renderWatch();
  });
  es.addEventListener("trade", e => {
    const t = JSON.parse(e.data);
    if (!state.open || t.mint !== state.open.address) return;
    chartState.trades.unshift(t);
    if (chartState.trades.length > 300) chartState.trades.pop();
    renderTrades();
    const first = $("#trades .trade");
    if (first) first.classList.add("new");
  });
  es.addEventListener("alert", e => {
    const a = JSON.parse(e.data);
    if (state.alerts.some(x => x.id === a.id)) return;
    state.alerts.unshift(a);
    if (a.backfill) return renderAlerts();
    renderAlerts();
    $(`[data-alert="${CSS.escape(a.id)}"]`)?.classList.add("fresh");
    if (state.tab !== "alerts") badge("#alertBadge", ++state.unseenAlerts);
    const title = `🚨 @${a.handle} tweeted ${a.tickers.join(" ") || (a.addresses.length ? "a contract address" : "about coins")}`;
    notifyUser(title, a.text, a.url, () => showTab("alerts"));
  });
  es.addEventListener("alert-update", e => {
    const a = JSON.parse(e.data);
    const i = state.alerts.findIndex(x => x.id === a.id);
    if (i >= 0) { state.alerts[i] = a; renderAlerts(); }
    for (const t of a.tokens || []) if (t.signal) toast(`${t.symbol}: ${t.signal} · rug risk ${t.rug?.verdict} · mcap ${usd(t.marketCap)}`, () => openCoin(key(t)));
  });
  es.addEventListener("wallet-trade", e => {
    const t = JSON.parse(e.data);
    (state.walletTrades ||= []).unshift(t);
    renderWalletTrades();
    if (state.tab !== "wallets") badge("#walletBadge", ++state.unseenWallet);
    notifyUser(`${t.side === "buy" ? "🟢" : "🔴"} ${t.walletLabel} ${t.side === "buy" ? "bought" : "sold"} ${t.symbol || short(t.mint)}`,
      `${usd(t.usd)} · mcap ${usd(t.marketCap)}`, t.url, () => openCoin("solana:" + t.mint));
  });
  es.addEventListener("status", e => renderKolStatus(JSON.parse(e.data)));
  es.onerror = () => setStatus("reconnecting");
}
function setStatus(s) {
  const el = $("#status");
  el.className = "pill " + (s === "live" ? "live" : "warn");
  el.textContent = s === "live" ? "● LIVE" : "● SERVER OFFLINE";
  el.title = s === "live" ? "" : SERVER_DOWN;
}
// Tell the server which coins this screen needs live (watchlist + the open coin's trades).
let watchTimer;
function updateWatch() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (!state.streamId) return;
    api(`/api/stream/${state.streamId}/watch`, {
      method: "POST",
      body: JSON.stringify({ watch: state.watch.map(key), open: state.open?.chain === "solana" ? [state.open.address] : [] })
    }).catch(() => { es?.close(); connect(); });
  }, 150);
}

// ---------- notifications ----------
let audioCtx;
function beep() {
  if (!state.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.15);
  } catch {}
}
function toast(text, onClick) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  el.onclick = () => { el.remove(); onClick?.(); };
  $("#toasts").prepend(el);
  setTimeout(() => el.remove(), 8000);
}
async function notifyUser(title, body, url, onClick) {
  toast(title + (body ? " — " + body.slice(0, 120) : ""), onClick);
  beep();
  navigator.vibrate?.([120, 60, 120]);
  if (document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification(title, { body, data: { url }, tag: title });
  else new Notification(title, { body });
}
$("#notifyBtn").onclick = async () => {
  if (!("Notification" in window)) return toast("This browser doesn't support notifications — on iPhone, add to Home Screen first.");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "🔔 Alerts on — you'll be pinged even when this tab is in the background." : "Notifications blocked in browser settings.");
  beep();
};
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// ---------- radar (ticker mentions on X) ----------
$("#radarForm").onsubmit = e => { e.preventDefault(); scanRadar(); };
async function scanRadar() {
  try {
    const d = await api("/api/search?q=" + encodeURIComponent($("#radarQuery").value));
    const coins = {};
    for (const p of d.posts) for (const t of p.tickers) {
      const c = coins[t] ||= { posts: 0, views: 0, engagement: 0, accounts: new Set() };
      const m = p.metrics || {};
      c.posts++; c.accounts.add(p.author);
      c.engagement += (m.like_count || 0) + (m.retweet_count || 0) + (m.reply_count || 0) + (m.quote_count || 0);
      if (typeof m.impression_count === "number") c.views += m.impression_count;
    }
    const rows = Object.entries(coins).sort((a, b) => b[1].posts - a[1].posts);
    $("#radarTop").innerHTML = rows.length ? `<div class="muted small">🚨 TOP ACTIVITY</div><div class="sym" style="font-size:26px">${esc(rows[0][0])}</div>` : `<div class="muted">No tickers found.</div>`;
    $("#radarCoins").innerHTML = rows.map(([t, c]) => `<div class="card"><div class="row"><span class="sym">${esc(t)}</span></div>
      <div class="metrics"><div><b>${c.posts}</b><span>POSTS</span></div><div><b>${compact(c.views)}</b><span>VIEWS</span></div>
      <div><b>${compact(c.engagement)}</b><span>ENGAGEMENT</span></div><div><b>${c.accounts.size}</b><span>ACCOUNTS</span></div></div></div>`).join("");
    $("#radarPosts").innerHTML = d.posts.slice(0, 20).map(p => `<div class="post"><b>@${esc(p.author)}</b> <span class="muted">${ago(p.created_at)} ago</span><div class="tweet">${esc(p.text)}</div></div>`).join("");
  } catch (err) {
    $("#radarTop").innerHTML = `<span class="red">${esc(err.message)}</span>`;
  }
}

// ---------- boot ----------
if (location.protocol === "file:") {
  document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="card red"><b>⚠️ Not connected.</b> ${esc(SERVER_DOWN)}</div>`);
}
renderWatch();
renderAlerts();
connect();
loadAlerts();
loadKols().catch(() => {});
loadWallets();
refreshWatch();
api("/api/signals").then(d => { state.signals = d.rows; ingestRows(d.rows); renderSignals(); }).catch(err => {
  $("#signals").innerHTML = `<div class="card red">Couldn't load signals: ${esc(err.message)}</div>`;
});
setInterval(() => { if (state.tab === "alerts") renderAlerts(); }, 30000);
