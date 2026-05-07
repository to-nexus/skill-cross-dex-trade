#!/usr/bin/env node
// CROSS Chain Gametoken DEX trader (EOA mode).
// Bundled by the cross-dex-trade Claude skill.
//
// Usage (env: PRIVATE_KEY required, optional CROSS_RPC_URL, MAX_TRADE_CROSS, WALLET_ADDRESS):
//   node trade.mjs pairs
//   node trade.mjs balance
//   node trade.mjs buy        <SYMBOL> <PRICE_CROSS> <AMOUNT_TOKEN>
//   node trade.mjs sell       <SYMBOL> <PRICE_CROSS> <AMOUNT_TOKEN>
//   node trade.mjs market-buy <SYMBOL> <CROSS_SPEND>
//   node trade.mjs cancel     <SYMBOL> <ORDER_ID>
//
// Output is one JSON object per invocation on stdout. Errors go to stderr with
// a non-zero exit code. Buy / sell / market-buy emit a `fillState` block
// derived from pre/post balance diffs so callers can distinguish a tx whose
// receipt was `success` but whose order remained open (lot/price out of range)
// from one that actually filled.

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  encodeFunctionData,
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
const DEX_CONTRACT = "0x6690844Aac584AcA982E195B7BDeBd48740fbcb1";
const PAIR_INFO_URL = "https://dex-api.crosstoken.io/dex/pair-info";
const EXPLORER_TX = (h) => `https://explorer.crosstoken.io/612055/tx/${h}`;

const SELECTORS = {
  BUY: "0xeafff4e0",
  SELL: "0x349ed71f",
  CANCEL: "0x1ec482d7",
  // submitBuyMarket(address pair, uint256 spendAmount, uint256 maxMatchCount)
  // Computed via keccak256; surfaced from the live Gametoken router bundle.
  BUY_MARKET: "0x1e920084",
};
const MAX_MATCH = 50n;
const MAX_UINT256 = (1n << 256n) - 1n;

const ERC20_ABI = [
  { inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
];

function fail(msg, extra = {}) {
  console.error(`ERROR: ${msg}`);
  if (Object.keys(extra).length) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

function pad256(v) { return BigInt(v).toString(16).padStart(64, "0"); }
function padAddress(a) { return a.slice(2).toLowerCase().padStart(64, "0"); }

function buildOrderCalldata(selector, pair, price, amount, orderType = 0n, maxMatch = MAX_MATCH) {
  return (selector
    + padAddress(pair)
    + pad256(price)
    + pad256(amount)
    + pad256(orderType)
    + pad256(0n)
    + pad256(0n)
    + pad256(maxMatch));
}

function buildCancelCalldata(pair, orderId) {
  // selector + pair + offset(0x40) + len(1) + orderId
  return (SELECTORS.CANCEL
    + padAddress(pair)
    + pad256(64n)
    + pad256(1n)
    + pad256(BigInt(orderId)));
}

function buildMarketBuyCalldata(pair, spendWei, maxMatch = MAX_MATCH) {
  return (SELECTORS.BUY_MARKET
    + padAddress(pair)
    + pad256(spendWei)
    + pad256(maxMatch));
}

// Reject amounts that violate the pair's lot_size — the on-chain matcher
// reverts at gas estimation, so catching it here gives a clean error instead
// of an opaque estimateGas failure.
function assertLotMultiple(amountStr, lotSize) {
  if (!lotSize || lotSize === "0") return;
  const amount = parseEther(amountStr);
  const lot = parseEther(lotSize);
  if (lot === 0n) return;
  if (amount % lot !== 0n) {
    fail(
      `amount ${amountStr} is not a multiple of pair lot_size ${lotSize}.`,
      { hint: `round to nearest multiple of ${lotSize}` }
    );
  }
}

// Read native + base-token balances for an account, in one shot.
async function snapshotBalances(publicClient, address, baseTokenAddress) {
  const [native, base] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: baseTokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [address],
    }),
  ]);
  return { native, base };
}

// Derive a fill-state block from pre/post balance diffs.
//   side: "buy" | "market-buy" | "sell"
//   requestedAmount (wei): for buy/sell — the submitted token amount
//   requestedSpend (wei):  for market-buy — the CROSS spend
//   gasCost (wei):         gasUsed * effectiveGasPrice from the receipt
function computeFillState({ side, before, after, requestedAmount, requestedSpend, gasCost }) {
  const baseDelta = after.base - before.base;            // + for buy fills
  const nativeDelta = before.native - after.native;       // + for native spent
  const nativeSpentNet = nativeDelta - gasCost;            // exclude gas
  if (side === "buy" || side === "market-buy") {
    const filled = baseDelta;
    let openRemainder = 0n;
    let fillState;
    if (filled === 0n) fillState = "open";
    else if (side === "buy" && filled < requestedAmount) { fillState = "partial"; openRemainder = requestedAmount - filled; }
    else if (side === "buy" && filled === requestedAmount) fillState = "filled";
    else if (side === "market-buy") fillState = nativeSpentNet < requestedSpend ? "partial" : "filled";
    else fillState = "filled";
    return {
      fillState,
      filledTokens: formatEther(filled),
      openRemainder: formatEther(openRemainder),
      nativeSpentNetCROSS: formatEther(nativeSpentNet < 0n ? 0n : nativeSpentNet),
      nativeRefundedCROSS: side === "market-buy"
        ? formatEther(requestedSpend - nativeSpentNet > 0n ? requestedSpend - nativeSpentNet : 0n)
        : null,
    };
  }
  // sell: tokens leave the wallet on order placement; CROSS arrives only on
  // matched fills. We surface diffs without claiming filled vs open since the
  // DEX may hold unmatched tokens in the order book under either outcome.
  return {
    fillState: null,
    tokensTransferredOut: formatEther(before.base - after.base),
    nativeReceivedNetCROSS: formatEther(after.native - before.native + gasCost),
    note: "for sell, tokens leaving the wallet does not by itself imply a fill — check open-orders to disambiguate",
  };
}

function getPrivateKey() {
  const pk = process.env.PRIVATE_KEY || process.env.TRADE_PRIVATE_KEY;
  if (!pk) fail("PRIVATE_KEY env var required.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) fail("PRIVATE_KEY must be 0x-prefixed 32-byte hex.");
  return pk;
}

function checkSafetyCap(crossNotional) {
  const cap = process.env.MAX_TRADE_CROSS;
  if (!cap) return;
  if (Number(crossNotional) > Number(cap)) {
    fail(`trade size ${crossNotional} CROSS exceeds MAX_TRADE_CROSS=${cap}.`);
  }
}

function makeClients() {
  const account = privateKeyToAccount(getPrivateKey());
  const publicClient = createPublicClient({ chain: CROSS_CHAIN, transport: http(RPC_URL) });
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

async function fetchPairs() {
  const res = await fetch(PAIR_INFO_URL);
  if (!res.ok) fail(`pair-info HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((p) => ({
    pairName: p.pair_name,
    pairAddress: p.pair_address,
    baseSymbol: p.base_symbol,
    baseAddress: p.base_address,
    quoteSymbol: p.quote_symbol,
    quoteAddress: p.quote_address,
    active: p.active,
    price: p.billboard?.price ?? "0",
    minAmount: p.min_amount ?? "0",
    lotSize: p.lot_size ?? "1",
    tickSize: p.tick_size ?? "0.0001",
  }));
}

async function findPair(symbol) {
  const pairs = await fetchPairs();
  const p = pairs.find((x) => x.baseSymbol.toUpperCase() === symbol.toUpperCase());
  if (!p) {
    const active = pairs.filter((x) => x.active).map((x) => x.baseSymbol);
    fail(`pair "${symbol}" not found.`, { activePairs: active });
  }
  return p;
}

/* ─────────── commands ─────────── */

async function cmdPairs() {
  const pairs = await fetchPairs();
  const out = pairs
    .filter((p) => p.active)
    .map((p) => ({
      symbol: p.baseSymbol,
      price: p.price,
      pair: p.pairAddress,
      token: p.baseAddress,
      minAmount: p.minAmount,
      tickSize: p.tickSize,
    }));
  console.log(JSON.stringify({ activePairs: out }, null, 2));
}

async function cmdBalance() {
  const { account, publicClient } = makeClients();
  await ensureChainId(publicClient);
  const native = await publicClient.getBalance({ address: account.address });
  const tokens = {};
  const pairs = await fetchPairs();
  await Promise.all(pairs.map(async (p) => {
    try {
      const bal = await publicClient.readContract({
        address: p.baseAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
      });
      if (bal > 0n) tokens[p.baseSymbol] = formatEther(bal);
    } catch { /* skip unreadable token */ }
  }));
  console.log(JSON.stringify({
    address: account.address,
    chainId: CROSS_CHAIN.id,
    CROSS: formatEther(native),
    tokens,
  }, null, 2));
}

async function cmdBuy(symbol, priceStr, amountStr) {
  const pair = await findPair(symbol);
  assertLotMultiple(amountStr, pair.lotSize);
  const price = parseEther(priceStr);
  const amount = parseEther(amountStr);
  const totalCost = (price * amount) / parseEther("1");
  checkSafetyCap(formatEther(totalCost));

  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);

  const before = await snapshotBalances(publicClient, account.address, pair.baseAddress);
  if (before.native < totalCost) {
    fail(`CROSS balance ${formatEther(before.native)} < required ${formatEther(totalCost)}.`);
  }

  const data = buildOrderCalldata(SELECTORS.BUY, pair.pairAddress, price, amount);
  const gas = await publicClient.estimateGas({
    account: account.address, to: DEX_CONTRACT, data, value: totalCost,
  });
  const hash = await walletClient.sendTransaction({
    to: DEX_CONTRACT, data, value: totalCost, gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshotBalances(publicClient, account.address, pair.baseAddress);
  const gasCost = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  const fill = receipt.status === "success"
    ? computeFillState({ side: "buy", before, after, requestedAmount: amount, gasCost })
    : { fillState: "reverted", filledTokens: "0", openRemainder: amountStr, nativeSpentNetCROSS: "0", nativeRefundedCROSS: null };
  console.log(JSON.stringify({
    action: "buy",
    symbol: pair.baseSymbol,
    price: priceStr,
    amount: amountStr,
    totalCostCROSS: formatEther(totalCost),
    address: account.address,
    txHash: hash,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
    fill,
  }, null, 2));
}

async function cmdMarketBuy(symbol, spendStr) {
  const pair = await findPair(symbol);
  const spend = parseEther(spendStr);
  if (spend <= 0n) fail(`spend amount must be positive (got "${spendStr}")`);
  checkSafetyCap(spendStr);

  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);

  const before = await snapshotBalances(publicClient, account.address, pair.baseAddress);
  if (before.native < spend) {
    fail(`CROSS balance ${formatEther(before.native)} < spend ${spendStr}.`);
  }

  const data = buildMarketBuyCalldata(pair.pairAddress, spend);
  const gas = await publicClient.estimateGas({
    account: account.address, to: DEX_CONTRACT, data, value: spend,
  });
  const hash = await walletClient.sendTransaction({
    to: DEX_CONTRACT, data, value: spend, gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshotBalances(publicClient, account.address, pair.baseAddress);
  const gasCost = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  const fill = receipt.status === "success"
    ? computeFillState({ side: "market-buy", before, after, requestedSpend: spend, gasCost })
    : { fillState: "reverted", filledTokens: "0", openRemainder: "0", nativeSpentNetCROSS: "0", nativeRefundedCROSS: spendStr };
  console.log(JSON.stringify({
    action: "market-buy",
    symbol: pair.baseSymbol,
    spendCROSS: spendStr,
    address: account.address,
    txHash: hash,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
    fill,
  }, null, 2));
}

async function cmdSell(symbol, priceStr, amountStr) {
  const pair = await findPair(symbol);
  assertLotMultiple(amountStr, pair.lotSize);
  const price = parseEther(priceStr);
  const amount = parseEther(amountStr);
  const totalProceeds = (price * amount) / parseEther("1");
  checkSafetyCap(formatEther(totalProceeds));

  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);

  const before = await snapshotBalances(publicClient, account.address, pair.baseAddress);
  if (before.base < amount) {
    fail(`${pair.baseSymbol} balance ${formatEther(before.base)} < requested ${amountStr}.`);
  }

  let approveTx = null;
  const allowance = await publicClient.readContract({
    address: pair.baseAddress, abi: ERC20_ABI, functionName: "allowance", args: [account.address, DEX_CONTRACT],
  });
  if (allowance < amount) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [DEX_CONTRACT, MAX_UINT256],
    });
    approveTx = await walletClient.sendTransaction({
      to: pair.baseAddress, data: approveData,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  const data = buildOrderCalldata(SELECTORS.SELL, pair.pairAddress, price, amount);
  const gas = await publicClient.estimateGas({
    account: account.address, to: DEX_CONTRACT, data, value: 0n,
  });
  const hash = await walletClient.sendTransaction({
    to: DEX_CONTRACT, data, value: 0n, gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await snapshotBalances(publicClient, account.address, pair.baseAddress);
  const gasCost = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);
  const fill = receipt.status === "success"
    ? computeFillState({ side: "sell", before, after, requestedAmount: amount, gasCost })
    : { fillState: "reverted", tokensTransferredOut: "0", nativeReceivedNetCROSS: "0", note: "tx reverted" };
  console.log(JSON.stringify({
    action: "sell",
    symbol: pair.baseSymbol,
    price: priceStr,
    amount: amountStr,
    expectedProceedsCROSS: formatEther(totalProceeds),
    address: account.address,
    approveTx,
    txHash: hash,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
    fill,
  }, null, 2));
}

async function cmdCancel(symbol, orderIdStr) {
  const pair = await findPair(symbol);
  const { account, publicClient, walletClient } = makeClients();
  await ensureChainId(publicClient);

  const data = buildCancelCalldata(pair.pairAddress, orderIdStr);
  const gas = await publicClient.estimateGas({
    account: account.address, to: DEX_CONTRACT, data, value: 0n,
  });
  const hash = await walletClient.sendTransaction({
    to: DEX_CONTRACT, data, value: 0n, gas: (gas * 120n) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({
    action: "cancel",
    symbol: pair.baseSymbol,
    orderId: orderIdStr,
    address: account.address,
    txHash: hash,
    status: receipt.status,
    explorer: EXPLORER_TX(hash),
  }, null, 2));
}

/* ─────────── dispatch ─────────── */

const [, , cmd, ...rest] = process.argv;

const commands = {
  pairs:        () => cmdPairs(),
  balance:      () => cmdBalance(),
  buy:          () => cmdBuy(rest[0], rest[1], rest[2]),
  sell:         () => cmdSell(rest[0], rest[1], rest[2]),
  "market-buy": () => cmdMarketBuy(rest[0], rest[1]),
  cancel:       () => cmdCancel(rest[0], rest[1]),
};

if (!cmd || !commands[cmd]) {
  console.error("Usage: node trade.mjs <pairs|balance|buy|sell|market-buy|cancel> [args]");
  process.exit(2);
}

try {
  await commands[cmd]();
} catch (err) {
  console.error(`ERROR: ${err?.shortMessage || err?.message || err}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
}
