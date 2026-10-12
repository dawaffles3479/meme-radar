// Optional push to Discord / Telegram so alerts reach your phone even when the app is closed.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function formatAlert(a) {
  const lines = [`🚨 @${a.handle} tweeted${a.tickers.length ? " " + a.tickers.join(" ") : ""}`, a.text];
  for (const t of a.tokens) {
    lines.push(`• ${t.symbol || "?"} — mcap ${t.marketCap ? "$" + Math.round(t.marketCap).toLocaleString() : "?"} — ${t.url}`);
  }
  for (const c of a.addresses) lines.push(`CA: ${c.address}`);
  lines.push(a.url);
  return lines.join("\n");
}

async function sendExternal(alert) {
  const text = formatAlert(alert);
  const jobs = [];
  if (DISCORD_WEBHOOK_URL) {
    jobs.push(fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900) })
    }));
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    jobs.push(fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
    }));
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.warn("notify failed:", r.reason?.message);
}

module.exports = { sendExternal, enabled: () => !!(DISCORD_WEBHOOK_URL || (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)) };
