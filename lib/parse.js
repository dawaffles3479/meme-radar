// Pull tickers, contract addresses and "is this about meme coins?" out of tweet text.

const TICKER_RE = /\$[A-Za-z][A-Za-z0-9_]{1,14}\b/g;
const SOL_ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_ADDR_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const MEME_WORDS_RE =
  /\b(meme ?coins?|memes?|doge|pepe|shib|bonk|wif|pump\.?fun|solana|sol|degen|ape[ds]?|ca|contract|token|coin|airdrop|launch(ed|ing)?|moon|send it|lfg|ticker|chart|dex)\b/i;

function extractTickers(text) {
  return [...new Set((text.match(TICKER_RE) || []).map(x => x.toUpperCase()))];
}

// Base58 strings of the right length are Solana addresses only if they look random:
// require a digit plus both letter cases so long plain words never match.
function isLikelySolanaAddress(s) {
  return /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}

function extractAddresses(text) {
  const solana = (text.match(SOL_ADDR_RE) || []).filter(isLikelySolanaAddress);
  const evm = (text.match(EVM_ADDR_RE) || []).map(a => a.toLowerCase());
  return [
    ...[...new Set(solana)].map(address => ({ chain: "solana", address })),
    ...[...new Set(evm)].map(address => ({ chain: "evm", address }))
  ];
}

function isMemeRelated(text, tickers, addresses) {
  return tickers.length > 0 || addresses.length > 0 || MEME_WORDS_RE.test(text);
}

function isSolanaAddress(s) {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

module.exports = { extractTickers, extractAddresses, isMemeRelated, isSolanaAddress };
