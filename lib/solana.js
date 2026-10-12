// Minimal Solana JSON-RPC client for on-chain token safety checks.
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Solana RPC ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Solana RPC: ${data.error.message}`);
  return data.result;
}

// Mint/freeze authority + holder concentration for one SPL token.
async function getMintSafety(mint) {
  const [info, largest, supply] = await Promise.all([
    rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
    rpc("getTokenLargestAccounts", [mint]),
    rpc("getTokenSupply", [mint])
  ]);
  const parsed = info?.value?.data?.parsed?.info || {};
  const total = Number(supply?.value?.uiAmountString || 0);
  const amounts = (largest?.value || []).map(a => Number(a.uiAmountString || 0));
  const pct = n => (total > 0 ? (n / total) * 100 : null);
  return {
    mintAuthority: parsed.mintAuthority ?? null,
    freezeAuthority: parsed.freezeAuthority ?? null,
    top1Pct: pct(amounts[0] || 0),
    top10Pct: pct(amounts.slice(0, 10).reduce((s, n) => s + n, 0))
  };
}

module.exports = { rpc, getMintSafety };
