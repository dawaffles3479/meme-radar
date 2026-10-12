// J7-style tracker: watch a list of famous / influential X accounts and raise an alert
// the moment one of them tweets about a meme coin (ticker, contract address, or keywords).
const { EventEmitter } = require("events");
const { extractTickers, extractAddresses, isMemeRelated } = require("./parse");
const dex = require("./dex");
const store = require("./store");
const notify = require("./notify");

const DEFAULT_KOLS = [
  { handle: "elonmusk", name: "Elon Musk" },
  { handle: "cz_binance", name: "CZ" },
  { handle: "VitalikButerin", name: "Vitalik Buterin" },
  { handle: "aeyakovenko", name: "Anatoly Yakovenko" },
  { handle: "rajgokal", name: "Raj Gokal" },
  { handle: "blknoiz06", name: "Ansem" },
  { handle: "MustStopMurad", name: "Murad" },
  { handle: "frankdegods", name: "Frank" },
  { handle: "notthreadguy", name: "threadguy" },
  { handle: "a1lon9", name: "Alon (pump.fun)" },
  { handle: "0xMert_", name: "Mert" },
  { handle: "realDonaldTrump", name: "Donald Trump" },
  { handle: "IGGYAZALEA", name: "Iggy Azalea" },
  { handle: "saylor", name: "Michael Saylor" }
];

const MAX_ALERTS = 300;
const MAX_QUERY_LEN = 480; // X recent search allows 512 chars on basic plans

class KolTracker extends EventEmitter {
  constructor({ token, pollMs = 15000, alertAll = false, useStream = true }) {
    super();
    this.token = token;
    this.pollMs = pollMs;
    this.useStream = useStream;
    this.analyzer = null; // set to signals module so alerts carry rug + upside scores
    this.alertAll = alertAll;
    this.kols = store.load("kols.json", DEFAULT_KOLS);
    this.alerts = store.load("alerts.json", []);
    this.sinceIds = {}; // per query chunk
    this.status = { state: token ? "starting" : "no-token", mode: null, lastPoll: null, error: null };
  }

  start() {
    if (!this.token) return;
    if (this.useStream) this.stream();
    else this.startPolling();
  }

  startPolling() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  // ---- Real-time mode: X Filtered Stream pushes tweets the instant they're posted. ----
  // Needs an X API plan with filtered-stream access (Pro or above). Falls back to polling.
  async syncStreamRules() {
    const headers = { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
    const url = "https://api.x.com/2/tweets/search/stream/rules";
    const cur = await fetch(url, { headers });
    const curJson = await cur.json();
    if (!cur.ok) throw Object.assign(new Error(curJson.detail || curJson.title || `X ${cur.status}`), { status: cur.status });
    const old = (curJson.data || []).filter(r => r.tag?.startsWith("meme-radar"));
    if (old.length) {
      await fetch(url, { method: "POST", headers, body: JSON.stringify({ delete: { ids: old.map(r => r.id) } }) });
    }
    const add = this.queries().map((value, i) => ({ value, tag: `meme-radar-${i}` }));
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ add }) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(j.detail || j.title || `X ${res.status}`), { status: res.status });
    }
  }

  async stream(backoff = 1000) {
    try {
      await this.syncStreamRules();
      this.rulesDirty = false;
      const params = new URLSearchParams({
        "tweet.fields": "created_at,public_metrics,author_id,entities",
        expansions: "author_id",
        "user.fields": "username,name,profile_image_url"
      });
      this.streamAbort = new AbortController();
      const res = await fetch("https://api.x.com/2/tweets/search/stream?" + params, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: this.streamAbort.signal
      });
      if (!res.ok) throw Object.assign(new Error(`X stream ${res.status}`), { status: res.status });
      this.setStatus({ state: "live", mode: "stream", lastPoll: new Date().toISOString(), error: null });
      backoff = 1000;

      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue; // keep-alive
          try {
            const msg = JSON.parse(line);
            if (msg.data) {
              const u = (msg.includes?.users || []).find(x => x.id === msg.data.author_id) || {};
              this.handleTweet(this.toTweet(msg.data, u), { source: "x-stream" }).catch(() => {});
            }
          } catch { /* partial or non-JSON line */ }
        }
      }
      throw new Error("X stream closed");
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        // Plan has no filtered-stream access: poll fast instead.
        this.setStatus({ mode: "polling", note: `Real-time stream needs X API Pro (${e.message}); polling every ${this.pollMs / 1000}s instead` });
        this.useStream = false;
        return this.startPolling();
      }
      if (this.rulesDirty) backoff = 0;
      this.setStatus({ state: "reconnecting", mode: "stream", error: e.message });
      setTimeout(() => this.stream(Math.min(backoff * 2, 60000)), backoff);
    }
  }

  // KOL list changed: restart the stream so it picks up new rules.
  restartStream() {
    if (!this.useStream || !this.streamAbort) return;
    this.rulesDirty = true;
    this.streamAbort.abort();
  }

  toTweet(tweet, u) {
    return {
      id: tweet.id,
      handle: u.username || "unknown",
      name: u.name,
      avatar: u.profile_image_url,
      text: tweet.text,
      created_at: tweet.created_at,
      metrics: tweet.public_metrics,
      expandedUrls: (tweet.entities?.urls || []).map(x => x.expanded_url).filter(Boolean)
    };
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  // Split "from:a OR from:b ..." into queries that fit X's length limit.
  queries() {
    const chunks = [];
    let cur = [];
    for (const k of this.kols) {
      const next = [...cur, `from:${k.handle}`];
      if (`(${next.join(" OR ")}) -is:retweet`.length > MAX_QUERY_LEN && cur.length) {
        chunks.push(cur);
        cur = [`from:${k.handle}`];
      } else {
        cur = next;
      }
    }
    if (cur.length) chunks.push(cur);
    return chunks.map(c => `(${c.join(" OR ")}) -is:retweet`);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const query of this.queries()) {
        const firstRun = !(query in this.sinceIds);
        const params = new URLSearchParams({
          query,
          max_results: firstRun ? "25" : "100",
          "tweet.fields": "created_at,public_metrics,author_id,entities",
          expansions: "author_id",
          "user.fields": "username,name,profile_image_url"
        });
        if (this.sinceIds[query]) params.set("since_id", this.sinceIds[query]);

        const res = await fetch("https://api.x.com/2/tweets/search/recent?" + params, {
          headers: { Authorization: `Bearer ${this.token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || data.title || `X API ${res.status}`);

        const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]));
        if (data.meta?.newest_id) this.sinceIds[query] = data.meta.newest_id;
        else if (firstRun) this.sinceIds[query] = null;

        // Oldest first so alerts arrive in order. First run is backfill: stored, not pinged.
        for (const tweet of (data.data || []).reverse()) {
          await this.handleTweet(this.toTweet(tweet, users[tweet.author_id] || {}), { backfill: firstRun });
        }
      }
      this.setStatus({ state: "live", mode: "polling", lastPoll: new Date().toISOString(), error: null });
    } catch (e) {
      this.setStatus({ state: "error", lastPoll: new Date().toISOString(), error: e.message });
    } finally {
      this.polling = false;
    }
  }

  async handleTweet(t, { backfill = false, source = "x" } = {}) {
    if (this.alerts.some(a => a.id === t.id)) return null;

    // Links like dexscreener.com/solana/<CA> or pump.fun/<CA> hide the address behind t.co.
    const haystack = [t.text, ...(t.expandedUrls || [])].join(" ");
    const tickers = extractTickers(t.text);
    const addresses = extractAddresses(haystack);
    const memeRelated = isMemeRelated(t.text, tickers, addresses);
    if (!memeRelated && !this.alertAll) return null;

    const alert = {
      id: t.id,
      source,
      handle: t.handle,
      name: t.name || this.kols.find(k => k.handle.toLowerCase() === t.handle.toLowerCase())?.name || t.handle,
      avatar: t.avatar || null,
      text: t.text,
      created_at: t.created_at || new Date().toISOString(),
      detected_at: new Date().toISOString(),
      url: t.url || `https://x.com/${t.handle}/status/${t.id}`,
      metrics: t.metrics || {},
      tickers,
      addresses,
      memeRelated,
      tokens: [],
      backfill
    };

    // Emit immediately (no waiting on price lookups), then follow up with token analysis.
    this.alerts.unshift(alert);
    this.alerts.length = Math.min(this.alerts.length, MAX_ALERTS);
    this.emit("alert", alert);
    if (!backfill && alert.addresses.length) {
      alert.tokens = await this.lookupTokens(alert).catch(() => []);
      if (alert.tokens.length) this.emit("alert-update", alert);
    }
    store.save("alerts.json", this.alerts);
    if (!backfill) notify.sendExternal(alert).catch(() => {});
    return alert;
  }

  // Attach live price / mcap for any contract addresses mentioned.
  async lookupTokens(alert) {
    const found = [];
    const sol = alert.addresses.filter(a => a.chain === "solana").map(a => a.address);
    if (sol.length) found.push(...(await dex.tokens("solana", sol, 0)).values());
    for (const a of alert.addresses.filter(a => a.chain === "evm").slice(0, 3)) {
      const [top] = await dex.search(a.address);
      if (top) found.push(top);
    }
    return this.analyzer ? this.analyzer.analyzeTokens(found) : found;
  }

  addKol(handle, name) {
    handle = String(handle || "").replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid X handle");
    if (this.kols.some(k => k.handle.toLowerCase() === handle.toLowerCase())) return this.kols;
    this.kols.push({ handle, name: name?.trim() || handle });
    store.save("kols.json", this.kols);
    this.restartStream();
    return this.kols;
  }

  removeKol(handle) {
    this.kols = this.kols.filter(k => k.handle.toLowerCase() !== String(handle).toLowerCase());
    store.save("kols.json", this.kols);
    this.restartStream();
    return this.kols;
  }

  clearAlerts() {
    this.alerts = [];
    store.save("alerts.json", this.alerts);
  }
}

module.exports = { KolTracker, DEFAULT_KOLS };
