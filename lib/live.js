// Live engine: re-prices every coin anyone is looking at every few seconds and pushes it
// to browsers over SSE, so charts and signals update without the page polling.
const { EventEmitter } = require("events");

const TICK_MS = Number(process.env.LIVE_TICK_MS || 2000);
const DISCOVER_MS = Number(process.env.DISCOVER_MS || 15000);
const CHAIN = process.env.DISCOVER_CHAIN || "solana";

class LiveEngine extends EventEmitter {
  constructor(signals) {
    super();
    this.signals = signals;
    this.watchers = new Map(); // client id -> Set("chain:address")
    this.top = [];
    this.setMaxListeners(1000);
  }

  start() {
    this.discover();
    setInterval(() => this.discover(), DISCOVER_MS);
    setInterval(() => this.tick(), TICK_MS);
  }

  watch(id, keys) {
    this.watchers.set(id, new Set(keys));
  }

  unwatch(id) {
    this.watchers.delete(id);
  }

  async discover() {
    try {
      this.top = await this.signals.discover(CHAIN, DISCOVER_MS - 1000);
      this.emit("signals", { chain: CHAIN, at: Date.now(), rows: this.top });
    } catch (e) {
      this.emit("signals", { chain: CHAIN, at: Date.now(), rows: this.top, error: e.message });
    }
  }

  async tick() {
    if (this.ticking || !this.watchers.size) return;
    this.ticking = true;
    try {
      const byChain = new Map();
      const add = (chain, address) => {
        if (!byChain.has(chain)) byChain.set(chain, new Set());
        byChain.get(chain).add(address);
      };
      for (const t of this.top.slice(0, 30)) add(t.chain, t.address);
      for (const keys of this.watchers.values()) {
        for (const k of keys) {
          const [chain, address] = k.split(":");
          if (chain && address) add(chain, address);
        }
      }
      const rows = [];
      for (const [chain, set] of byChain) {
        rows.push(...await this.signals.analyze(chain, [...set].slice(0, 90), { maxAge: TICK_MS - 200 }));
      }
      this.emit("prices", { at: Date.now(), rows });
    } catch (e) {
      this.emit("prices", { at: Date.now(), rows: [], error: e.message });
    } finally {
      this.ticking = false;
    }
  }
}

module.exports = { LiveEngine, TICK_MS };
