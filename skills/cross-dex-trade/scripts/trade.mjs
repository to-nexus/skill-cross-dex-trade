#!/usr/bin/env node
// CROSS Chain GameToken swap and AMM liquidity trader (EOA mode).
//
// Usage:
//   node trade.mjs tokens [--query=RUBY] [--limit=20]
//   node trade.mjs token-info <SYMBOL|all> [--history=5] [--liquidity-events=5] [--candles=12] [--tick=1h]
//   node trade.mjs pairs
//   node trade.mjs balance
//   node trade.mjs quote <buy|sell|buy-exact> <SYMBOL> <AMOUNT>
//   node trade.mjs buy <SYMBOL> <CROSS_SPEND> [--slippage-bps=300]
//   node trade.mjs buy-exact <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]
//   node trade.mjs sell <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]
//   node trade.mjs quote-deposit <SYMBOL> <CROSS_AMOUNT> [--slippage-bps=300]
//   node trade.mjs deposit <SYMBOL> <CROSS_AMOUNT> [--slippage-bps=300]
//   node trade.mjs quote-deposit-token <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]
//   node trade.mjs deposit-token <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]
//   node trade.mjs quote-withdraw <SYMBOL> <LP_AMOUNT|all> [--slippage-bps=300]
//   node trade.mjs withdraw <SYMBOL> <LP_AMOUNT|all> [--slippage-bps=300]
//
// Output is one JSON object per invocation on stdout. Write commands require
// PRIVATE_KEY and submit real transactions on CROSS Chain.

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CROSS_CHAIN = {
  id: 612055,
  name: "CROSS Chain",
  nativeCurrency: { name: "CROSS", symbol: "CROSS", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.crosstoken.io:22001/"] } },
  blockExplorers: {
    default: { name: "CROSS Explorer", url: "https://explorer.crosstoken.io/612055" },
  },
};

const RPC_URL = process.env.CROSS_RPC_URL || CROSS_CHAIN.rpcUrls.default.http[0];
const GAME_SWAP_API = process.env.GAME_SWAP_API_URL || "https://game-swap-api.cross.nexus/v1";
const GAME_SWAP_ROUTER = "0x639Adf46ac111399361c422bC32c3892f0cbb70c";
const WRAPPED_NATIVE = "0x8739bC962460a8a25184aaa9166b74dd8448a194";
const EXPLORER_TX = (h) => `https://explorer.crosstoken.io/612055/tx/${h}`;
const DEFAULT_SLIPPAGE_BPS = 300n;
const DEFAULT_DEADLINE_SEC = 20 * 60;
const BPS_DENOMINATOR = 10000n;
const MAX_UINT256 = (1n << 256n) - 1n;

const ERC20_ABI = [
  { inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
];

const ROUTER_ABI = [
  {
    name: "swapExactNativeForTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "swapNativeForExactTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOut", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "swapExactTokensForNative",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "addLiquidity",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountTokenDesired", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountNativeMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "removeLiquidity",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountNativeMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

function fail(msg, extra = {}) {
  console.error(`ERROR: ${msg}`);
  if (Object.keys(extra).length) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

function parseOptions(args) {
  const opts = {};
  const rest = [];
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const [key, value = "true"] = arg.slice(2).split("=");
    opts[key] = value;
  }
  return { opts, rest };
}

function getPrivateKey() {
  const pk = process.env.PRIVATE_KEY || process.env.TRADE_PRIVATE_KEY;
  if (!pk) fail("PRIVATE_KEY env var required for write commands.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) fail("PRIVATE_KEY must be 0x-prefixed 32-byte hex.");
  return pk;
}

function makePublicClient() {
  return createPublicClient({ chain: CROSS_CHAIN, transport: http(RPC_URL) });
}

function makeClients() {
  const account = privateKeyToAccount(getPrivateKey());
  const publicClient = makePublicClient();
  const walletClient = createWalletClient({ account, chain: CROSS_CHAIN, transport: http(RPC_URL) });
  const declared = process.env.WALLET_ADDRESS;
  if (declared && declared.toLowerCase() !== account.address.toLowerCase()) {
    fail(`WALLET_ADDRESS (${declared}) does not match address derived from PRIVATE_KEY (${account.address}).`);
  }
  return { account, publicClient, walletClient };
}

async function ensureChainId(publicClient) {
  const cid = await publicClient.getChainId();
  if (cid !== CROSS_CHAIN.id) fail(`connected chainId ${cid}, expected ${CROSS_CHAIN.id}.`);
}

async function fetchJson(path, params = {}) {
  const url = new URL(`${GAME_SWAP_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) fail(`${path} HTTP ${res.status}`, json);
  return json;
}

async function fetchTokens() {
  const json = await fetchJson("/tokens");
  return json.items ?? [];
}

async function fetchPairs() {
  const json = await fetchJson("/pairs");
  return json.items ?? [];
}

async function fetchGames() {
  const json = await fetchJson("/games");
  return json.items ?? [];
}

async function fetchGame(slug) {
  if (!slug) return null;
  return fetchJson(`/games/${slug}`);
}

async function fetchTokenDetail(address) {
  return fetchJson(`/tokens/${address}`);
}

async function fetchPairDetail(address) {
  return fetchJson(`/pairs/${address}`);
}

async function findToken(symbol) {
  const tokens = await fetchTokens();
  const token = tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
  if (!token) fail(`token "${symbol}" not found.`, { listed: tokens.map((t) => t.symbol) });
  return token;
}

async function findPairBySymbol(symbol) {
  const pairs = await fetchPairs();
  const pair = pairs.find((p) => p.token_a_symbol.toUpperCase() === symbol.toUpperCase());
  if (!pair) fail(`swap pair for "${symbol}" not found.`, { pairs: pairs.map((p) => p.token_a_symbol) });
  return pair;
}

async function findTokenAndPair(symbol) {
  if (!symbol) fail("missing symbol.");
  const [pair, token] = await Promise.all([
    findPairBySymbol(symbol),
    findToken(symbol),
  ]);
  return { pair, token, decimals: token.decimals ?? pair.token_a_decimals ?? 18 };
}

function slippageBps(opts) {
  const raw = opts["slippage-bps"] ?? opts.slippage ?? `${DEFAULT_SLIPPAGE_BPS}`;
  if (!/^\d+$/.test(String(raw))) fail(`slippage bps must be an integer, got "${raw}".`);
  const bps = BigInt(raw);
  if (bps > 5000n) fail("slippage bps above 5000 (50%) refused.");
  return bps;
}

function deadline(opts) {
  const sec = Number(opts["deadline-sec"] ?? DEFAULT_DEADLINE_SEC);
  if (!Number.isFinite(sec) || sec <= 0) fail("deadline-sec must be positive.");
  return BigInt(Math.floor(Date.now() / 1000) + Math.floor(sec));
}

function applySlippageDown(amount, bps) {
  return (amount * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR;
}

function applySlippageUp(amount, bps) {
  return (amount * (BPS_DENOMINATOR + bps) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

function checkSafetyCap(crossNotionalWei) {
  const cap = process.env.MAX_TRADE_CROSS;
  if (!cap) return;
  if (crossNotionalWei > parseEther(cap)) {
    fail(`trade size ${formatEther(crossNotionalWei)} CROSS exceeds MAX_TRADE_CROSS=${cap}.`);
  }
}

function decimalString(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function formatRawUnits(value, decimals = 18) {
  const raw = decimalString(value);
  if (!raw) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return raw;
  }
}

function formatRawEther(value) {
  return formatRawUnits(value, 18);
}

function maybeNumber(value) {
  const raw = decimalString(value);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function tokenPriceUsd(stats) {
  const direct = decimalString(stats?.price_usd);
  if (direct) return direct;
  const price = maybeNumber(stats?.last_price);
  const crossUsd = maybeNumber(stats?.cross_usd);
  if (price == null || crossUsd == null) return null;
  return String(price * crossUsd);
}

function liquidityUsd(pair, stats) {
  if (!pair?.reserve_b) return null;
  const reserveCross = Number(formatEther(BigInt(pair.reserve_b)));
  const crossUsd = maybeNumber(stats?.cross_usd);
  if (!Number.isFinite(reserveCross) || crossUsd == null) return null;
  return String(reserveCross * crossUsd * 2);
}

function integerOption(opts, key, fallback, { min = 0, max = 100 } = {}) {
  const raw = opts[key] ?? fallback;
  if (raw === undefined || raw === null || raw === false) return fallback;
  if (!/^\d+$/.test(String(raw))) fail(`${key} must be an integer.`);
  const n = Number(raw);
  if (n < min || n > max) fail(`${key} must be between ${min} and ${max}.`);
  return n;
}

function candleTick(opts) {
  const tick = opts.tick ?? "1h";
  const allowed = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
  if (!allowed.has(tick)) fail(`tick must be one of ${[...allowed].join(", ")}.`);
  return tick;
}

function shortAddress(address) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function compactTokenSummary(token, pair = null, game = null) {
  const stats = token.stats ?? {};
  const decimals = token.decimals ?? pair?.token_a_decimals ?? 18;
  return {
    symbol: token.symbol,
    name: token.name,
    address: token.address,
    decimals,
    listStatus: token.list_status,
    game: {
      slug: token.game?.slug ?? game?.slug,
      name: token.game?.name ?? game?.name,
      genre: game?.genre,
      developer: game?.developer,
      publisher: game?.publisher,
      platforms: game?.platforms,
      releaseYear: game?.release_year,
      website: game?.homepage_url ?? token.game?.play_url ?? game?.play_url,
    },
    market: {
      priceCROSS: stats.last_price ?? null,
      priceUSD: tokenPriceUsd(stats),
      change24hPercent: stats.change_24h ?? null,
      totalSupply: formatRawUnits(stats.total_supply, decimals),
      holders: stats.holders_count ?? null,
      marketCapUSD: stats.market_cap_usd ?? null,
      liquidityUSD: liquidityUsd(pair, stats),
      buy24hCROSS: formatRawEther(stats.volume_buy_24h),
      sell24hCROSS: formatRawEther(stats.volume_sell_24h),
      volume24hUSD: stats.volume_24h_usd ?? null,
    },
    pair: pair ? {
      address: pair.address,
      reserveToken: formatRawUnits(pair.reserve_a, decimals),
      reserveCROSS: formatRawEther(pair.reserve_b),
      swapCount24h: pair.swap_count_24h ?? null,
      creationBlock: pair.creation_block ?? null,
    } : null,
  };
}

async function quoteSwap({ side, symbol, amountStr, exact = "in" }) {
  if (!symbol || !amountStr) fail(`missing arguments: expected <SYMBOL> <AMOUNT>.`);
  const pair = await findPairBySymbol(symbol);
  const token = await findToken(symbol);
  const decimals = token.decimals ?? pair.token_a_decimals ?? 18;
  const tokenIn = side === "sell" ? token.address : WRAPPED_NATIVE;
  const amountKey = exact === "in" ? "amount_in" : "amount_out";
  const amount = side === "sell" || exact === "out"
    ? parseUnits(amountStr, decimals)
    : parseEther(amountStr);
  const quote = await fetchJson("/quote", {
    pair: pair.address,
    token_in: tokenIn,
    [amountKey]: amount.toString(),
    exact,
  });
  return { pair, token, decimals, quote };
}

async function snapshot(publicClient, address, tokenAddress, decimals) {
  const [native, token] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  return {
    native,
    token,
    nativeFormatted: formatEther(native),
    tokenFormatted: formatUnits(token, decimals),
  };
}

async function snapshotLiquidity(publicClient, address, tokenAddress, pairAddress, decimals) {
  const [native, token, lp] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
    publicClient.readContract({
      address: pairAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  return {
    native,
    token,
    lp,
    nativeFormatted: formatEther(native),
    tokenFormatted: formatUnits(token, decimals),
    lpFormatted: formatEther(lp),
  };
}

async function liquidityState({ publicClient, pair, address = null }) {
  const calls = [
    publicClient.readContract({
      address: pair.address,
      abi: [{ inputs: [], name: "totalSupply", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }],
      functionName: "totalSupply",
    }),
  ];
  if (address) {
    calls.push(publicClient.readContract({
      address: pair.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    }));
  }
  const [totalSupply, walletLp = null] = await Promise.all(calls);
  return {
    reserveToken: BigInt(pair.reserve_a),
    reserveNative: BigInt(pair.reserve_b),
    totalSupply,
    walletLp,
  };
}

async function approveIfNeeded({ publicClient, walletClient, account, token, amount }) {
  const allowance = await publicClient.readContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, GAME_SWAP_ROUTER],
  });
  if (allowance >= amount) return null;
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [GAME_SWAP_ROUTER, MAX_UINT256],
  });
  const hash = await walletClient.sendTransaction({ to: token.address, data });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function approveAddressIfNeeded({ publicClient, walletClient, account, tokenAddress, spender, amount }) {
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (allowance >= amount) return null;
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, MAX_UINT256],
  });
  const hash = await walletClient.sendTransaction({ to: tokenAddress, data });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

function buildSwapResult({ action, symbol, amountIn, amountOut, quote, token, address, hash, receipt, before, after, approveTx, slippage }) {
  const tokenDelta = after.token - before.token;
  const nativeDelta = after.native - before.native;
  const gasCost = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  return {
    action,
    symbol,
    token: token.address,
    address,
    txHash: hash,
    approveTx,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
    slippageBps: slippage.toString(),
    quote,
    requested: {
      amountIn,
      amountOut,
    },
    balanceDiff: {
      nativeCROSS: formatEther(nativeDelta + gasCost),
      token: formatUnits(tokenDelta, token.decimals ?? 18),
      gasCROSS: formatEther(gasCost),
    },
  };
}

async function cmdTokens(opts) {
  const tokens = await fetchTokens();
  const q = (opts.query ?? "").toUpperCase();
  const limit = Number(opts.limit ?? 50);
  const items = tokens
    .filter((t) => !q || t.symbol.toUpperCase().includes(q) || t.name.toUpperCase().includes(q))
    .slice(0, limit)
    .map((t) => ({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      decimals: t.decimals,
      priceCROSS: t.stats?.last_price,
      change24h: t.stats?.change_24h,
      game: t.game?.name,
      listStatus: t.list_status,
    }));
  console.log(JSON.stringify({ tokens: items }, null, 2));
}

async function cmdTokenInfo(symbolOrAll, opts) {
  if (!symbolOrAll) fail("missing arguments: expected <SYMBOL|all>.");
  const [tokens, pairs, games] = await Promise.all([fetchTokens(), fetchPairs(), fetchGames()]);
  const gameBySlug = new Map(games.map((g) => [g.slug, g]));
  const pairBySymbol = new Map(pairs.map((p) => [p.token_a_symbol.toUpperCase(), p]));

  if (symbolOrAll.toLowerCase() === "all") {
    const q = (opts.query ?? "").toUpperCase();
    const limit = integerOption(opts, "limit", 100, { min: 1, max: 500 });
    const items = tokens
      .filter((t) => !q || t.symbol.toUpperCase().includes(q) || t.name.toUpperCase().includes(q) || t.game?.name?.toUpperCase().includes(q))
      .slice(0, limit)
      .map((t) => compactTokenSummary(t, pairBySymbol.get(t.symbol.toUpperCase()), gameBySlug.get(t.game?.slug)));
    console.log(JSON.stringify({ tokenInfo: items }, null, 2));
    return;
  }

  const listed = tokens.find((t) => t.symbol.toUpperCase() === symbolOrAll.toUpperCase());
  if (!listed) fail(`token "${symbolOrAll}" not found.`, { listed: tokens.map((t) => t.symbol) });
  const basePair = pairBySymbol.get(listed.symbol.toUpperCase()) ?? null;
  const historyLimit = integerOption(opts, "history", 0, { min: 0, max: 100 });
  const liquidityLimit = integerOption(opts, "liquidity-events", 0, { min: 0, max: 100 });
  const candleSize = integerOption(opts, "candles", 0, { min: 0, max: 500 });
  const tick = candleTick(opts);

  const detailPromise = fetchTokenDetail(listed.address);
  const pairPromise = basePair ? fetchPairDetail(basePair.address) : Promise.resolve(null);
  const gamePromise = listed.game?.slug ? fetchGame(listed.game.slug) : Promise.resolve(null);
  const [detail, pairDetail, game] = await Promise.all([detailPromise, pairPromise, gamePromise]);
  const pair = pairDetail ?? basePair;
  const decimals = detail.decimals ?? listed.decimals ?? pair?.token_a_decimals ?? 18;

  const optional = {};
  if (historyLimit > 0 && pair) {
    const swaps = await fetchJson(`/pairs/${pair.address}/swaps`, { limit: historyLimit });
    optional.recentSwaps = {
      nextCursor: swaps.next_cursor ?? null,
      items: (swaps.items ?? []).map((s) => ({
        side: s.side,
        account: shortAddress(s.sender),
        sender: s.sender,
        recipient: s.recipient,
        priceCROSS: s.price,
        avgPriceCROSS: s.avg_price,
        tokenAmount: s.side === "buy" ? formatRawUnits(s.amount_out, decimals) : formatRawUnits(s.amount_in, decimals),
        crossAmount: s.side === "buy" ? formatRawEther(s.amount_in) : formatRawEther(s.amount_out),
        txHash: s.tx_hash,
        blockTime: s.block_time,
      })),
    };
  }
  if (liquidityLimit > 0 && pair) {
    const events = await fetchJson(`/pairs/${pair.address}/liquidity`, { limit: liquidityLimit });
    optional.recentLiquidityEvents = {
      nextCursor: events.next_cursor ?? null,
      items: (events.items ?? []).map((e) => ({
        kind: e.kind,
        provider: e.provider,
        tokenAmount: formatRawUnits(e.amount_a, decimals),
        crossAmount: formatRawEther(e.amount_b),
        txHash: e.tx_hash,
        blockTime: e.block_time,
      })),
    };
  }
  if (candleSize > 0) {
    const candles = await fetchJson(`/tokens/${detail.address}/candles`, { tick, size: candleSize });
    optional.candles = {
      tick,
      items: (Array.isArray(candles) ? candles : candles.items ?? []).map((c) => ({
        openTimeUtc: c.open_time_utc,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        avgPrice: c.avg_price,
        volumeToken: c.volume,
        tradeVolumeCROSS: c.trade_volume,
        crossUsdClose: c.cross_usd_close ?? null,
      })),
    };
  }

  console.log(JSON.stringify({
    token: {
      ...compactTokenSummary(detail, pair, game),
      description: detail.description ?? null,
      logoUrl: detail.logo_url ?? null,
      game: {
        ...compactTokenSummary(detail, pair, game).game,
        description: game?.description ?? null,
        logoUrl: game?.logo_url ?? detail.game?.logo_url ?? null,
        logoWideUrl: game?.logo_wide_url ?? detail.game?.logo_wide_url ?? null,
        bannerUrl: game?.banner_url ?? detail.game?.banner_url ?? null,
        playUrl: game?.play_url ?? detail.game?.play_url ?? null,
        homepageUrl: game?.homepage_url ?? null,
      },
      fee: pair ? {
        devFeeRate: pair.dev_fee_rate ?? null,
        protocolFeeRate: pair.protocol_fee_rate ?? null,
        foundationFeeRate: pair.foundation_fee_rate ?? null,
        devFeeRecipient: pair.dev_fee_recipient ?? null,
      } : null,
      primaryPair: detail.primary_pair ?? pair?.address ?? null,
    },
    ...optional,
  }, null, 2));
}

async function cmdPairs() {
  const pairs = await fetchPairs();
  console.log(JSON.stringify({
    router: GAME_SWAP_ROUTER,
    wrappedNative: WRAPPED_NATIVE,
    pairs: pairs.map((p) => ({
      symbol: p.token_a_symbol,
      pair: p.address,
      token: p.token_a,
      wrappedNative: p.token_b,
      reserveToken: formatUnits(BigInt(p.reserve_a), p.token_a_decimals ?? 18),
      reserveCROSS: formatEther(BigInt(p.reserve_b)),
    })),
  }, null, 2));
}

async function cmdBalance() {
  const { account, publicClient } = makeClients();
  await ensureChainId(publicClient);
  const [native, tokens] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    fetchTokens(),
  ]);
  const balances = {};
  await Promise.all(tokens.map(async (t) => {
    try {
      const bal = await publicClient.readContract({
        address: t.address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (bal > 0n) balances[t.symbol] = formatUnits(bal, t.decimals ?? 18);
    } catch {
      // Skip unreadable token metadata.
    }
  }));
  const lpTokens = {};
  const pairs = await fetchPairs();
  await Promise.all(pairs.map(async (p) => {
    try {
      const bal = await publicClient.readContract({
        address: p.address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (bal > 0n) lpTokens[`${p.token_a_symbol}-CROSS-LP`] = {
        pair: p.address,
        balance: formatEther(bal),
      };
    } catch {
      // Skip unreadable pair balances.
    }
  }));
  console.log(JSON.stringify({
    address: account.address,
    chainId: CROSS_CHAIN.id,
    CROSS: formatEther(native),
    tokens: balances,
    lpTokens,
  }, null, 2));
}

async function cmdQuote(side, symbol, amountStr) {
  if (!["buy", "sell", "buy-exact"].includes(side)) fail("quote side must be buy, sell, or buy-exact.");
  const exact = side === "buy-exact" ? "out" : "in";
  const quoteSide = side === "sell" ? "sell" : "buy";
  const { pair, token, decimals, quote } = await quoteSwap({ side: quoteSide, symbol, amountStr, exact });
  console.log(JSON.stringify({
    side,
    symbol: token.symbol,
    token: token.address,
    pair: pair.address,
    exact,
    amountIn: formatUnits(BigInt(quote.amount_in), quoteSide === "sell" ? decimals : 18),
    amountOut: formatUnits(BigInt(quote.amount_out), quoteSide === "sell" ? 18 : decimals),
    price: quote.price,
    priceImpact: quote.price_impact,
    raw: quote,
  }, null, 2));
}

async function cmdBuy(symbol, spendStr, opts) {
  const slippage = slippageBps(opts);
  const { pair, token, decimals, quote } = await quoteSwap({ side: "buy", symbol, amountStr: spendStr, exact: "in" });
  const spend = BigInt(quote.amount_in);
  const quotedOut = BigInt(quote.amount_out);
  const amountOutMin = applySlippageDown(quotedOut, slippage);
  checkSafetyCap(spend);

  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);
  const before = await snapshot(publicClient, account.address, token.address, decimals);
  if (before.native < spend) fail(`CROSS balance ${formatEther(before.native)} < spend ${formatEther(spend)}.`);

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactNativeForTokens",
    args: [amountOutMin, [WRAPPED_NATIVE, token.address], account.address, deadline(opts)],
  });
  const gas = await publicClient.estimateGas({ account: account.address, to: GAME_SWAP_ROUTER, data, value: spend });
  const hash = await walletClient.sendTransaction({
    to: GAME_SWAP_ROUTER,
    data,
    value: spend,
    gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshot(publicClient, account.address, token.address, decimals);
  console.log(JSON.stringify(buildSwapResult({
    action: "buy",
    symbol: token.symbol,
    token,
    address: account.address,
    hash,
    receipt,
    before,
    after,
    slippage,
    quote: {
      pair: pair.address,
      spendCROSS: formatEther(spend),
      quotedTokenOut: formatUnits(quotedOut, decimals),
      minTokenOut: formatUnits(amountOutMin, decimals),
      priceImpact: quote.price_impact,
    },
    amountIn: formatEther(spend),
    amountOut: formatUnits(amountOutMin, decimals),
  }), null, 2));
}

async function cmdBuyExact(symbol, amountStr, opts) {
  const slippage = slippageBps(opts);
  const { pair, token, decimals, quote } = await quoteSwap({ side: "buy", symbol, amountStr, exact: "out" });
  const quotedIn = BigInt(quote.amount_in);
  const desiredOut = BigInt(quote.amount_out);
  const maxIn = applySlippageUp(quotedIn, slippage);
  checkSafetyCap(maxIn);

  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);
  const before = await snapshot(publicClient, account.address, token.address, decimals);
  if (before.native < maxIn) fail(`CROSS balance ${formatEther(before.native)} < max spend ${formatEther(maxIn)}.`);

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapNativeForExactTokens",
    args: [desiredOut, [WRAPPED_NATIVE, token.address], account.address, deadline(opts)],
  });
  const gas = await publicClient.estimateGas({ account: account.address, to: GAME_SWAP_ROUTER, data, value: maxIn });
  const hash = await walletClient.sendTransaction({
    to: GAME_SWAP_ROUTER,
    data,
    value: maxIn,
    gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshot(publicClient, account.address, token.address, decimals);
  console.log(JSON.stringify(buildSwapResult({
    action: "buy-exact",
    symbol: token.symbol,
    token,
    address: account.address,
    hash,
    receipt,
    before,
    after,
    slippage,
    quote: {
      pair: pair.address,
      desiredTokenOut: formatUnits(desiredOut, decimals),
      quotedCROSSIn: formatEther(quotedIn),
      maxCROSSIn: formatEther(maxIn),
      priceImpact: quote.price_impact,
    },
    amountIn: formatEther(maxIn),
    amountOut: formatUnits(desiredOut, decimals),
  }), null, 2));
}

async function cmdSell(symbol, amountStr, opts) {
  const slippage = slippageBps(opts);
  const { pair, token, decimals, quote } = await quoteSwap({ side: "sell", symbol, amountStr, exact: "in" });
  const amountIn = BigInt(quote.amount_in);
  const quotedOut = BigInt(quote.amount_out);
  const amountOutMin = applySlippageDown(quotedOut, slippage);
  checkSafetyCap(quotedOut);

  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);
  const before = await snapshot(publicClient, account.address, token.address, decimals);
  if (before.token < amountIn) fail(`${token.symbol} balance ${formatUnits(before.token, decimals)} < amount ${amountStr}.`);
  const approveTx = await approveIfNeeded({ publicClient, walletClient, account, token, amount: amountIn });

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactTokensForNative",
    args: [amountIn, amountOutMin, [token.address, WRAPPED_NATIVE], account.address, deadline(opts)],
  });
  const gas = await publicClient.estimateGas({ account: account.address, to: GAME_SWAP_ROUTER, data, value: 0n });
  const hash = await walletClient.sendTransaction({
    to: GAME_SWAP_ROUTER,
    data,
    value: 0n,
    gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshot(publicClient, account.address, token.address, decimals);
  console.log(JSON.stringify(buildSwapResult({
    action: "sell",
    symbol: token.symbol,
    token,
    address: account.address,
    hash,
    receipt,
    before,
    after,
    approveTx,
    slippage,
    quote: {
      pair: pair.address,
      tokenIn: formatUnits(amountIn, decimals),
      quotedCROSSOut: formatEther(quotedOut),
      minCROSSOut: formatEther(amountOutMin),
      priceImpact: quote.price_impact,
    },
    amountIn: formatUnits(amountIn, decimals),
    amountOut: formatEther(amountOutMin),
  }), null, 2));
}

async function quoteDeposit(symbol, crossAmountStr, opts, address = null) {
  if (!crossAmountStr) fail("missing arguments: expected <SYMBOL> <CROSS_AMOUNT>.");
  const { pair, token, decimals } = await findTokenAndPair(symbol);
  const publicClient = makePublicClient();
  await ensureChainId(publicClient);
  const slippage = slippageBps(opts);
  const nativeDesired = parseEther(crossAmountStr);
  if (nativeDesired <= 0n) fail("CROSS amount must be positive.");
  const state = await liquidityState({ publicClient, pair, address });
  if (state.reserveNative <= 0n || state.reserveToken <= 0n || state.totalSupply <= 0n) {
    fail(`pair ${pair.address} has insufficient liquidity for quote.`);
  }
  const tokenDesired = (nativeDesired * state.reserveToken + state.reserveNative - 1n) / state.reserveNative;
  const tokenMin = applySlippageDown(tokenDesired, slippage);
  const nativeMin = applySlippageDown(nativeDesired, slippage);
  const expectedLp = nativeDesired * state.totalSupply / state.reserveNative;
  return {
    symbol: token.symbol,
    token,
    decimals,
    pair,
    slippage,
    nativeDesired,
    tokenDesired,
    tokenMin,
    nativeMin,
    expectedLp,
    state,
  };
}

async function cmdQuoteDeposit(symbol, crossAmountStr, opts) {
  const q = await quoteDeposit(symbol, crossAmountStr, opts);
  console.log(JSON.stringify({
    action: "quote-deposit",
    symbol: q.symbol,
    token: q.token.address,
    pair: q.pair.address,
    slippageBps: q.slippage.toString(),
    inputCROSS: formatEther(q.nativeDesired),
    requiredToken: formatUnits(q.tokenDesired, q.decimals),
    minToken: formatUnits(q.tokenMin, q.decimals),
    minCROSS: formatEther(q.nativeMin),
    expectedLpTokens: formatEther(q.expectedLp),
    pool: {
      reserveToken: formatUnits(q.state.reserveToken, q.decimals),
      reserveCROSS: formatEther(q.state.reserveNative),
      totalLpSupply: formatEther(q.state.totalSupply),
    },
  }, null, 2));
}

async function cmdDeposit(symbol, crossAmountStr, opts) {
  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);
  const q = await quoteDeposit(symbol, crossAmountStr, opts, account.address);
  checkSafetyCap(q.nativeDesired);

  const before = await snapshotLiquidity(publicClient, account.address, q.token.address, q.pair.address, q.decimals);
  if (before.native < q.nativeDesired) fail(`CROSS balance ${formatEther(before.native)} < deposit ${formatEther(q.nativeDesired)}.`);
  if (before.token < q.tokenDesired) fail(`${q.symbol} balance ${formatUnits(before.token, q.decimals)} < required ${formatUnits(q.tokenDesired, q.decimals)}.`);
  const approveTx = await approveAddressIfNeeded({
    publicClient,
    walletClient,
    account,
    tokenAddress: q.token.address,
    spender: GAME_SWAP_ROUTER,
    amount: q.tokenDesired,
  });

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "addLiquidity",
    args: [q.token.address, q.tokenDesired, q.tokenMin, q.nativeMin, account.address, deadline(opts)],
  });
  const gas = await publicClient.estimateGas({ account: account.address, to: GAME_SWAP_ROUTER, data, value: q.nativeDesired });
  const hash = await walletClient.sendTransaction({
    to: GAME_SWAP_ROUTER,
    data,
    value: q.nativeDesired,
    gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshotLiquidity(publicClient, account.address, q.token.address, q.pair.address, q.decimals);
  const gasCost = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  console.log(JSON.stringify({
    action: "deposit",
    symbol: q.symbol,
    token: q.token.address,
    pair: q.pair.address,
    address: account.address,
    approveTx,
    txHash: hash,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
    slippageBps: q.slippage.toString(),
    requested: {
      crossIn: formatEther(q.nativeDesired),
      tokenDesired: formatUnits(q.tokenDesired, q.decimals),
      tokenMin: formatUnits(q.tokenMin, q.decimals),
      crossMin: formatEther(q.nativeMin),
      expectedLpTokens: formatEther(q.expectedLp),
    },
    balanceDiff: {
      nativeCROSS: formatEther(after.native - before.native + gasCost),
      token: formatUnits(after.token - before.token, q.decimals),
      lpTokens: formatEther(after.lp - before.lp),
      gasCROSS: formatEther(gasCost),
    },
  }, null, 2));
}

async function quoteDepositToken(symbol, tokenAmountStr, opts, address = null) {
  if (!tokenAmountStr) fail("missing arguments: expected <SYMBOL> <TOKEN_AMOUNT>.");
  const { pair, token, decimals } = await findTokenAndPair(symbol);
  const publicClient = makePublicClient();
  await ensureChainId(publicClient);
  const slippage = slippageBps(opts);
  const tokenDesired = parseUnits(tokenAmountStr, decimals);
  if (tokenDesired <= 0n) fail("token amount must be positive.");
  const state = await liquidityState({ publicClient, pair, address });
  if (state.reserveNative <= 0n || state.reserveToken <= 0n || state.totalSupply <= 0n) {
    fail(`pair ${pair.address} has insufficient liquidity for quote.`);
  }
  const nativeDesired = (tokenDesired * state.reserveNative + state.reserveToken - 1n) / state.reserveToken;
  const tokenMin = applySlippageDown(tokenDesired, slippage);
  const nativeMin = applySlippageDown(nativeDesired, slippage);
  const expectedLp = tokenDesired * state.totalSupply / state.reserveToken;
  return {
    symbol: token.symbol,
    token,
    decimals,
    pair,
    slippage,
    nativeDesired,
    tokenDesired,
    tokenMin,
    nativeMin,
    expectedLp,
    state,
  };
}

async function cmdQuoteDepositToken(symbol, tokenAmountStr, opts) {
  const q = await quoteDepositToken(symbol, tokenAmountStr, opts);
  console.log(JSON.stringify({
    action: "quote-deposit-token",
    symbol: q.symbol,
    token: q.token.address,
    pair: q.pair.address,
    slippageBps: q.slippage.toString(),
    inputToken: formatUnits(q.tokenDesired, q.decimals),
    requiredCROSS: formatEther(q.nativeDesired),
    minToken: formatUnits(q.tokenMin, q.decimals),
    minCROSS: formatEther(q.nativeMin),
    expectedLpTokens: formatEther(q.expectedLp),
    pool: {
      reserveToken: formatUnits(q.state.reserveToken, q.decimals),
      reserveCROSS: formatEther(q.state.reserveNative),
      totalLpSupply: formatEther(q.state.totalSupply),
    },
  }, null, 2));
}

async function cmdDepositToken(symbol, tokenAmountStr, opts) {
  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);
  const q = await quoteDepositToken(symbol, tokenAmountStr, opts, account.address);
  checkSafetyCap(q.nativeDesired);

  const before = await snapshotLiquidity(publicClient, account.address, q.token.address, q.pair.address, q.decimals);
  if (before.native < q.nativeDesired) fail(`CROSS balance ${formatEther(before.native)} < required ${formatEther(q.nativeDesired)}.`);
  if (before.token < q.tokenDesired) fail(`${q.symbol} balance ${formatUnits(before.token, q.decimals)} < deposit ${formatUnits(q.tokenDesired, q.decimals)}.`);
  const approveTx = await approveAddressIfNeeded({
    publicClient,
    walletClient,
    account,
    tokenAddress: q.token.address,
    spender: GAME_SWAP_ROUTER,
    amount: q.tokenDesired,
  });

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "addLiquidity",
    args: [q.token.address, q.tokenDesired, q.tokenMin, q.nativeMin, account.address, deadline(opts)],
  });
  const gas = await publicClient.estimateGas({ account: account.address, to: GAME_SWAP_ROUTER, data, value: q.nativeDesired });
  const hash = await walletClient.sendTransaction({
    to: GAME_SWAP_ROUTER,
    data,
    value: q.nativeDesired,
    gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshotLiquidity(publicClient, account.address, q.token.address, q.pair.address, q.decimals);
  const gasCost = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  console.log(JSON.stringify({
    action: "deposit-token",
    symbol: q.symbol,
    token: q.token.address,
    pair: q.pair.address,
    address: account.address,
    approveTx,
    txHash: hash,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
    slippageBps: q.slippage.toString(),
    requested: {
      tokenDesired: formatUnits(q.tokenDesired, q.decimals),
      crossIn: formatEther(q.nativeDesired),
      tokenMin: formatUnits(q.tokenMin, q.decimals),
      crossMin: formatEther(q.nativeMin),
      expectedLpTokens: formatEther(q.expectedLp),
    },
    balanceDiff: {
      nativeCROSS: formatEther(after.native - before.native + gasCost),
      token: formatUnits(after.token - before.token, q.decimals),
      lpTokens: formatEther(after.lp - before.lp),
      gasCROSS: formatEther(gasCost),
    },
  }, null, 2));
}

async function resolveLiquidityAmount(amountStr, walletLp = null) {
  if (!amountStr) fail("missing arguments: expected <SYMBOL> <LP_AMOUNT|all>.");
  if (amountStr.toLowerCase() === "all") {
    if (walletLp == null) fail("LP amount 'all' requires a configured wallet. Use a numeric LP amount for read-only quotes.");
    if (walletLp <= 0n) fail("LP balance is zero.");
    return walletLp;
  }
  const amount = parseEther(amountStr);
  if (amount <= 0n) fail("LP amount must be positive.");
  return amount;
}

async function quoteWithdraw(symbol, lpAmountStr, opts, address = null) {
  const { pair, token, decimals } = await findTokenAndPair(symbol);
  const publicClient = makePublicClient();
  await ensureChainId(publicClient);
  const slippage = slippageBps(opts);
  const state = await liquidityState({ publicClient, pair, address });
  if (state.reserveNative <= 0n || state.reserveToken <= 0n || state.totalSupply <= 0n) {
    fail(`pair ${pair.address} has insufficient liquidity for quote.`);
  }
  const liquidity = await resolveLiquidityAmount(lpAmountStr, state.walletLp);
  if (address && liquidity > state.walletLp) fail(`LP balance ${formatEther(state.walletLp)} < requested ${formatEther(liquidity)}.`);
  const tokenOut = liquidity * state.reserveToken / state.totalSupply;
  const nativeOut = liquidity * state.reserveNative / state.totalSupply;
  const tokenMin = applySlippageDown(tokenOut, slippage);
  const nativeMin = applySlippageDown(nativeOut, slippage);
  return {
    symbol: token.symbol,
    token,
    decimals,
    pair,
    slippage,
    liquidity,
    tokenOut,
    nativeOut,
    tokenMin,
    nativeMin,
    state,
  };
}

async function cmdQuoteWithdraw(symbol, lpAmountStr, opts) {
  const q = await quoteWithdraw(symbol, lpAmountStr, opts);
  console.log(JSON.stringify({
    action: "quote-withdraw",
    symbol: q.symbol,
    token: q.token.address,
    pair: q.pair.address,
    slippageBps: q.slippage.toString(),
    liquidity: formatEther(q.liquidity),
    expectedTokenOut: formatUnits(q.tokenOut, q.decimals),
    expectedCROSSOut: formatEther(q.nativeOut),
    minTokenOut: formatUnits(q.tokenMin, q.decimals),
    minCROSSOut: formatEther(q.nativeMin),
    pool: {
      reserveToken: formatUnits(q.state.reserveToken, q.decimals),
      reserveCROSS: formatEther(q.state.reserveNative),
      totalLpSupply: formatEther(q.state.totalSupply),
    },
  }, null, 2));
}

async function cmdWithdraw(symbol, lpAmountStr, opts) {
  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);
  const q = await quoteWithdraw(symbol, lpAmountStr, opts, account.address);
  checkSafetyCap(q.nativeOut);

  const before = await snapshotLiquidity(publicClient, account.address, q.token.address, q.pair.address, q.decimals);
  if (before.lp < q.liquidity) fail(`LP balance ${formatEther(before.lp)} < requested ${formatEther(q.liquidity)}.`);
  const approveTx = await approveAddressIfNeeded({
    publicClient,
    walletClient,
    account,
    tokenAddress: q.pair.address,
    spender: GAME_SWAP_ROUTER,
    amount: q.liquidity,
  });

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "removeLiquidity",
    args: [q.token.address, q.liquidity, q.tokenMin, q.nativeMin, account.address, deadline(opts)],
  });
  const gas = await publicClient.estimateGas({ account: account.address, to: GAME_SWAP_ROUTER, data, value: 0n });
  const hash = await walletClient.sendTransaction({
    to: GAME_SWAP_ROUTER,
    data,
    value: 0n,
    gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshotLiquidity(publicClient, account.address, q.token.address, q.pair.address, q.decimals);
  const gasCost = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  console.log(JSON.stringify({
    action: "withdraw",
    symbol: q.symbol,
    token: q.token.address,
    pair: q.pair.address,
    address: account.address,
    approveTx,
    txHash: hash,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
    slippageBps: q.slippage.toString(),
    requested: {
      liquidity: formatEther(q.liquidity),
      expectedTokenOut: formatUnits(q.tokenOut, q.decimals),
      expectedCROSSOut: formatEther(q.nativeOut),
      minTokenOut: formatUnits(q.tokenMin, q.decimals),
      minCROSSOut: formatEther(q.nativeMin),
    },
    balanceDiff: {
      nativeCROSS: formatEther(after.native - before.native + gasCost),
      token: formatUnits(after.token - before.token, q.decimals),
      lpTokens: formatEther(after.lp - before.lp),
      gasCROSS: formatEther(gasCost),
    },
  }, null, 2));
}

const [, , cmd, ...argv] = process.argv;
const { opts, rest } = parseOptions(argv);

const commands = {
  tokens: () => cmdTokens(opts),
  "token-info": () => cmdTokenInfo(rest[0], opts),
  pairs: () => cmdPairs(),
  balance: () => cmdBalance(),
  quote: () => cmdQuote(rest[0], rest[1], rest[2]),
  buy: () => cmdBuy(rest[0], rest[1], opts),
  "buy-exact": () => cmdBuyExact(rest[0], rest[1], opts),
  sell: () => cmdSell(rest[0], rest[1], opts),
  "quote-deposit": () => cmdQuoteDeposit(rest[0], rest[1], opts),
  deposit: () => cmdDeposit(rest[0], rest[1], opts),
  "quote-deposit-token": () => cmdQuoteDepositToken(rest[0], rest[1], opts),
  "deposit-token": () => cmdDepositToken(rest[0], rest[1], opts),
  "quote-withdraw": () => cmdQuoteWithdraw(rest[0], rest[1], opts),
  withdraw: () => cmdWithdraw(rest[0], rest[1], opts),
};

if (!cmd || !commands[cmd]) {
  console.error("Usage: node trade.mjs <tokens|token-info|pairs|balance|quote|buy|buy-exact|sell|quote-deposit|deposit|quote-deposit-token|deposit-token|quote-withdraw|withdraw> [args] [--slippage-bps=300]");
  process.exit(2);
}

try {
  await commands[cmd]();
} catch (err) {
  console.error(`ERROR: ${err?.shortMessage || err?.message || err}`);
  if (process.env.DEBUG) console.error(err?.stack ?? String(err));
  process.exit(1);
}
