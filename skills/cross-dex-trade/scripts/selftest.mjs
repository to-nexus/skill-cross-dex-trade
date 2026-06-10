#!/usr/bin/env node
// Network-backed smoke test for the swap/liquidity migration. It avoids
// signing and validates the public API, quote schema, router selectors, and legacy removal.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { encodeFunctionData, parseEther, parseUnits } from "viem";

const execFileAsync = promisify(execFile);

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

const WRAPPED_NATIVE = "0x8739bC962460a8a25184aaa9166b74dd8448a194";
const RUBYX = "0x7bd648b4b0169c1c12d1060dfdb4005f2ac881c0";
const TEST_TO = "0x000000000000000000000000000000000000dEaD";
const DEADLINE = 4_102_444_800n;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runJson(args) {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/trade.mjs", ...args], {
    cwd: new URL("..", import.meta.url),
    maxBuffer: 1024 * 1024 * 4,
  });
  return JSON.parse(stdout);
}

function assertSelector(functionName, args, selector) {
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName, args });
  assert(data.startsWith(selector), `${functionName} selector mismatch: ${data.slice(0, 10)} !== ${selector}`);
}

async function main() {
  const tokens = await runJson(["tokens", "--query=RUBY", "--limit=3"]);
  assert(tokens.tokens.some((t) => t.symbol === "RUBYx" && /^0x[0-9a-fA-F]{40}$/.test(t.address)), "RUBYx token not found");

  const allInfo = await runJson(["token-info", "all", "--query=SHILTZ", "--limit=3"]);
  assert(allInfo.tokenInfo.some((t) => t.symbol === "SHILTZx" && t.game?.name === "SEAL M on CROSS"), "SHILTZx token-info all not found");

  const tokenInfo = await runJson(["token-info", "SHILTZx", "--history=2", "--liquidity-events=2", "--candles=2", "--tick=1h"]);
  assert(tokenInfo.token.symbol === "SHILTZx", "token-info symbol mismatch");
  assert(tokenInfo.token.game.name === "SEAL M on CROSS", "token-info game mismatch");
  assert(tokenInfo.token.game.genre === "MMORPG", "token-info genre mismatch");
  assert(tokenInfo.token.market.priceCROSS, "token-info missing price");
  assert(tokenInfo.recentSwaps.items.length > 0, "token-info swaps missing");
  assert(tokenInfo.recentLiquidityEvents.items.length > 0, "token-info liquidity events missing");
  assert(tokenInfo.candles.items.length > 0, "token-info candles missing");

  const pairs = await runJson(["pairs"]);
  const rubyPair = pairs.pairs.find((p) => p.symbol === "RUBYx");
  assert(rubyPair, "RUBYx pair not found");
  assert(pairs.router === "0x639Adf46ac111399361c422bC32c3892f0cbb70c", "unexpected router address");
  assert(pairs.wrappedNative.toLowerCase() === WRAPPED_NATIVE.toLowerCase(), "unexpected wrapped native address");

  const buy = await runJson(["quote", "buy", "RUBYx", "1"]);
  assert(buy.exact === "in", "buy quote exact mode mismatch");
  assert(BigInt(buy.raw.amount_in) === parseEther("1"), "buy amount_in mismatch");
  assert(BigInt(buy.raw.amount_out) > 0n, "buy amount_out is zero");

  const buyExact = await runJson(["quote", "buy-exact", "RUBYx", "10"]);
  assert(buyExact.exact === "out", "buy-exact quote exact mode mismatch");
  assert(BigInt(buyExact.raw.amount_out) === parseUnits("10", 18), "buy-exact amount_out mismatch");
  assert(BigInt(buyExact.raw.amount_in) > 0n, "buy-exact amount_in is zero");

  const sell = await runJson(["quote", "sell", "RUBYx", "10"]);
  assert(sell.exact === "in", "sell quote exact mode mismatch");
  assert(BigInt(sell.raw.amount_in) === parseUnits("10", 18), "sell amount_in mismatch");
  assert(BigInt(sell.raw.amount_out) > 0n, "sell amount_out is zero");

  const deposit = await runJson(["quote-deposit", "RUBYx", "1"]);
  assert(deposit.action === "quote-deposit", "deposit quote action mismatch");
  assert(deposit.inputCROSS === "1", "deposit quote CROSS input mismatch");
  assert(Number(deposit.requiredToken) > 0, "deposit requiredToken is zero");
  assert(Number(deposit.minCROSS) > 0, "deposit minCROSS is zero");
  assert(Number(deposit.expectedLpTokens) > 0, "deposit expected LP is zero");

  const depositToken = await runJson(["quote-deposit-token", "SHILTZx", "20"]);
  assert(depositToken.action === "quote-deposit-token", "deposit-token quote action mismatch");
  assert(depositToken.inputToken === "20", "deposit-token quote input mismatch");
  assert(Number(depositToken.requiredCROSS) > 0, "deposit-token requiredCROSS is zero");
  assert(Number(depositToken.minCROSS) > 0, "deposit-token minCROSS is zero");
  assert(Number(depositToken.expectedLpTokens) > 0, "deposit-token expected LP is zero");

  const withdraw = await runJson(["quote-withdraw", "RUBYx", "1"]);
  assert(withdraw.action === "quote-withdraw", "withdraw quote action mismatch");
  assert(withdraw.liquidity === "1", "withdraw liquidity mismatch");
  assert(Number(withdraw.expectedTokenOut) > 0, "withdraw expectedTokenOut is zero");
  assert(Number(withdraw.expectedCROSSOut) > 0, "withdraw expectedCROSSOut is zero");

  assertSelector(
    "swapExactNativeForTokens",
    [1n, [WRAPPED_NATIVE, RUBYX], TEST_TO, DEADLINE],
    "0xc075a591",
  );
  assertSelector(
    "swapNativeForExactTokens",
    [parseUnits("10", 18), [WRAPPED_NATIVE, RUBYX], TEST_TO, DEADLINE],
    "0x800a758a",
  );
  assertSelector(
    "swapExactTokensForNative",
    [parseUnits("10", 18), 1n, [RUBYX, WRAPPED_NATIVE], TEST_TO, DEADLINE],
    "0x029e384f",
  );
  assertSelector(
    "addLiquidity",
    [RUBYX, parseUnits("10", 18), parseUnits("9", 18), parseEther("0.97"), TEST_TO, DEADLINE],
    "0xe5d89365",
  );
  assertSelector(
    "removeLiquidity",
    [RUBYX, parseEther("1"), parseUnits("2", 18), parseEther("0.3"), TEST_TO, DEADLINE],
    "0x96c92f5e",
  );

  const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
  assert(!skill.includes("market-buy"), "legacy market-buy command leaked into SKILL.md");
  assert(!skill.includes("PRICE_CROSS"), "legacy PRICE_CROSS leaked into SKILL.md");
  assert(!skill.includes("ORDER_ID"), "legacy ORDER_ID leaked into SKILL.md");

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "tokens API",
      "token-info API",
      "pairs API",
      "buy quote",
      "buy-exact quote",
      "sell quote",
      "deposit quote",
      "deposit-token quote",
      "withdraw quote",
      "router calldata selectors",
      "SKILL legacy command removal",
    ],
  }, null, 2));
}

try {
  await main();
} catch (err) {
  console.error(`SELFTEST FAILED: ${err.message}`);
  process.exit(1);
}
