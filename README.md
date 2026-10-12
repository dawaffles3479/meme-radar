# 📡 Meme Radar

A live meme-coin tracker. It ranks coins by how likely they look to keep going up, checks each one for rug-pull risk, and pings you when famous accounts tweet about a coin or when wallets you follow buy or sell.

| Tab | What it does |
| --- | --- |
| 🔥 **Signals** | Trending and new coins from real DEX pools, ranked by **upside score** (0–100) and labelled 🟢 BUY / 🟡 WATCH / 🔴 AVOID. Coins with no liquidity or no trades are filtered out. |
| ⭐ **Watchlist** | Add any coin by contract address, name or $TICKER. Prices update every ~2 seconds. |
| 🚨 **KOL alerts** | J7-style tracker. Get an instant alert when Elon, CZ, Ansem, Murad, Trump and others (editable list) tweet a ticker, contract address or coin talk. The alert includes the coin's live signal and rug check. |
| 👀 **Wallets** | Follow whale, KOL or smart-money wallets and get pinged the moment they buy or sell. |
| 📡 **Radar** | Ticker-mention volume across all of X. |

Tap any coin to open its page:
- **Live market-cap candles** (1m / 5m / 15m / 1h). The candles move with every price tick.
- **Buy/sell markers on the chart** showing the $ size of each trade.
- **Axiom-style live trade feed:** every buy and sell with its $ amount, SOL amount, wallet, and how much of the bag a seller dumped. Trader icons: 🐋 $5k+ · 🐬 $1k+ · 🐟 $100+ · 🦐 <$100 · 🎯 sniper (bought in first 5 min) · 🔁 buying more · 📉 sold 50%+ · 🚪 sold everything · ⭐ a wallet you follow.
- **Rug check:** mint authority, freeze authority, holder concentration, liquidity, pool age, honeypot pattern (buys but no sells), dumps, wash trading, plus RugCheck.xyz findings.
- **Contract address** with a copy button, shown on every card.

> ⚠️ The upside score is a heuristic built from momentum, buy pressure, volume, KOL tweets and rug risk. It cannot know the future. Meme coins are extremely risky. A "BUY" signal is not financial advice, and a "low" rug risk does not mean a coin is safe.

## Run it

```bash
npm install
X_BEARER_TOKEN=your_x_token npm start
# open http://localhost:3000. On a phone: Share → Add to Home Screen, then tap 🔔 to allow alerts
```

The coin, signal, rug-check, chart and trade features work **without any API key**. They use DexScreener, GeckoTerminal, RugCheck.xyz, PumpPortal and Solana RPC. An X token is needed only for KOL alerts and Radar.

## Settings (environment variables)

| Variable | Default | What it's for |
| --- | --- | --- |
| `X_BEARER_TOKEN` | — | X API token for KOL alerts and Radar. |
| `KOL_STREAM` | `1` | Use X **Filtered Stream**, which delivers a tweet the instant it's posted. Needs X API Pro. Without Pro the app falls back to polling automatically. |
| `KOL_POLL_SECONDS` | `15` | Polling interval when streaming isn't available. Lower values use up your X quota faster. |
| `KOL_ALERT_ALL` | `0` | `1` = alert on every tweet from tracked accounts, not only coin-related ones. |
| `SOLANA_RPC_URL` | public mainnet | **Strongly recommended:** a private RPC such as Helius or QuickNode. The public one is rate-limited, which slows trade feeds and rug checks. |
| `LIVE_TICK_MS` | `2000` | How often prices are pushed to the browser. |
| `DISCOVER_MS` | `15000` | How often the Signals list is re-ranked. |
| `DISCORD_WEBHOOK_URL` | — | Also send alerts to Discord, which works when the app is closed. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | — | Also send alerts to Telegram. |
| `ADMIN_TOKEN` | — | If set, required to edit tracked accounts and wallets. Set this when the app is public. |
| `INGEST_SECRET` | — | If set, required by `POST /api/ingest`. |

### Feed tweets in from another tracker
If you already use J7 Tracker or a Discord/Telegram tweet feed, forward it with a webhook (Zapier, IFTTT, a Discord bot and so on):

```
POST /api/ingest   { "handle": "elonmusk", "text": "...", "url": "https://x.com/elonmusk/status/123" }
```

Tweets sent this way get the same contract-address detection, signal, rug check and alerts as tweets from the built-in tracker.

## How "real-time" it is
- **Prices and charts:** pushed to the browser every ~2s over a live stream. DexScreener's own updates are the limit.
- **Trades:** pump.fun and PumpSwap coins arrive instantly through the PumpPortal websocket. Other DEXes are read from Solana RPC every ~2s, so this is much faster with a private RPC.
- **Followed wallets:** PumpPortal pushes their trades instantly, and Solana RPC is checked every ~4s.
- **KOL tweets:** instant with X API Pro (Filtered Stream). Otherwise the app polls every `KOL_POLL_SECONDS`.

Chart history comes from GeckoTerminal, and the live candle is built from the app's own price ticks. Live trades are Solana only; other chains get prices, signals, charts and the market-based rug checks.
