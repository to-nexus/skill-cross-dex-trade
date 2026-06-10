---
name: cross-dex-trade
description: Use this skill when the user asks to list, inspect, quote, buy, sell, swap, deposit liquidity, or withdraw liquidity for GameTokens on CROSS Chain (chain id 612055). The service is now AMM swap-based, not orderbook-based. Supports token/game metadata, market stats, chart candles, trade history, token/pair discovery, quote, CROSS -> GameToken swaps, exact-output buys, GameToken -> CROSS swaps, GameToken+CROSS LP deposits, LP withdrawals, balances, local EOA signing, slippage controls, and per-trade CROSS caps. Triggers on phrases like "CROSS chain swap", "GameToken info", "SHILTZx 정보", "GameToken buy/sell", "deposit RUBYx liquidity", "withdraw RUBYx LP", "buy 5 CROSS worth of RUBYx", "sell 100 CROMx", "quote SHOUT", "크로스 게임토큰 스왑", "RUBYx 매수/매도/예치/인출".
version: 0.3.0
license: MIT
---

# CROSS Chain GameToken Swap

This skill lets Claude quote and execute **swap-based GameToken trades and AMM liquidity actions** on CROSS Chain (`612055`). The previous orderbook flow is obsolete; do not use orderbook, limit price, open order, fill-state, or cancel semantics.

Execution path is local **EOA + viem**. Write commands sign and broadcast real transactions using the user's local `.env`.

---

## 1. Activation

Activate when the user wants to:
- List GameTokens or AMM pairs on `x.crosstoken.io/tokens`
- Inspect token/game metadata, market stats, chart candles, recent swaps, and liquidity events
- Quote a GameToken swap
- Buy a GameToken with CROSS
- Buy an exact amount of a GameToken with a max CROSS spend
- Sell a GameToken back to CROSS
- Deposit GameToken+CROSS liquidity into an AMM pair
- Withdraw GameToken+CROSS liquidity from LP tokens
- Check the configured wallet's CROSS and GameToken balances
- Have OpenClaw run one of the same commands

If the user asks for an orderbook, limit order, order cancellation, bid/ask depth, or open orders, explain that `cross-dex-trade` has moved to AMM-based GameToken swaps and liquidity actions, so orderbook operations are no longer supported.

---

## 2. Prerequisites

Run these checks before execution:

```bash
node --version          # require >= 20
which openclaw          # optional; only needed for explicit OpenClaw dispatch
```

Install dependencies once:

```bash
SKILL_DIR="$HOME/.claude/skills/cross-dex-trade"
[ -d "$SKILL_DIR/node_modules" ] || (cd "$SKILL_DIR" && npm install --silent)
```

---

## 3. Credential Resolution

Resolve the trading EOA in this order. Never echo secrets, never ask the user to paste a private key into chat, and never pass it on the command line.

1. `./.env` in the user's current working directory
2. `$HOME/.claude/skills/cross-dex-trade/.env`
3. If both lack `PRIVATE_KEY`, stop and tell the user to create:

```bash
PRIVATE_KEY=<0x-prefixed-64-hex-secret>
MAX_TRADE_CROSS=10
```

Supported env vars:
- `PRIVATE_KEY` — required for `buy`, `buy-exact`, `sell`, `deposit`, `withdraw`, `balance`
- `MAX_TRADE_CROSS` — optional but recommended per-trade CROSS notional cap
- `CROSS_RPC_URL` — optional RPC override
- `WALLET_ADDRESS` — optional derived-address cross-check
- `GAME_SWAP_API_URL` — optional API override; default `https://game-swap-api.cross.nexus/v1`

---

## 4. Safety Rails

Apply every time:

1. The script aborts unless `eth_chainId == 612055`.
2. `MAX_TRADE_CROSS` aborts writes whose CROSS notional exceeds the cap. For liquidity, this means deposit CROSS input or withdraw quoted CROSS output.
3. Default slippage is `300` bps (`3%`). Let the user set `--slippage-bps=N`; refuse above `5000`.
4. Confirm with the user before any write where CROSS notional is greater than `1`. Show side, symbol, input amount, quoted output, slippage, cap, and wallet suffix.
5. Never invent a limit price. This DEX is swap-based; use quote output and slippage bounds.

---

## 5. Execution

Default direct mode:

```bash
cd "$HOME/.claude/skills/cross-dex-trade"
node scripts/trade.mjs <subcommand> [args]
```

Subcommands:
- `tokens [--query=TEXT] [--limit=N]` — list GameTokens from the GameToken API; no signer required
- `token-info <SYMBOL|all> [--query=TEXT] [--limit=N] [--history=N] [--liquidity-events=N] [--candles=N] [--tick=1m|5m|15m|1h|4h|1d]` — inspect token, game, market, pair, recent swap, liquidity, and candle data; no signer required
- `pairs` — list AMM pairs, reserves, router, and wrapped native token; no signer required
- `quote <buy|sell|buy-exact> <SYMBOL> <AMOUNT>` — quote without signing
- `balance` — show CROSS and nonzero GameToken balances for the configured EOA
- `buy <SYMBOL> <CROSS_SPEND> [--slippage-bps=300]` — exact-input CROSS -> token swap
- `buy-exact <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]` — exact-output token buy with max CROSS input
- `sell <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]` — exact-input token -> CROSS swap; auto-approves router if needed
- `quote-deposit <SYMBOL> <CROSS_AMOUNT> [--slippage-bps=300]` — quote token needed and expected LP tokens for adding liquidity
- `deposit <SYMBOL> <CROSS_AMOUNT> [--slippage-bps=300]` — add token+CROSS liquidity from a CROSS amount; auto-approves token if needed
- `quote-deposit-token <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]` — quote CROSS needed and expected LP tokens for adding liquidity from a token amount
- `deposit-token <SYMBOL> <TOKEN_AMOUNT> [--slippage-bps=300]` — add token+CROSS liquidity from a token amount; auto-approves token if needed
- `quote-withdraw <SYMBOL> <LP_AMOUNT|all> [--slippage-bps=300]` — quote token+CROSS outputs for removing liquidity
- `withdraw <SYMBOL> <LP_AMOUNT|all> [--slippage-bps=300]` — remove liquidity; auto-approves LP token if needed

Examples:

```bash
node scripts/trade.mjs tokens --query=RUBY
node scripts/trade.mjs token-info SHILTZx --history=5 --candles=12 --tick=1h
node scripts/trade.mjs token-info all --limit=20
node scripts/trade.mjs pairs
node scripts/trade.mjs quote buy RUBYx 1
node scripts/trade.mjs buy RUBYx 1 --slippage-bps=300
node scripts/trade.mjs buy-exact RUBYx 10 --slippage-bps=300
node scripts/trade.mjs sell RUBYx 10 --slippage-bps=300
node scripts/trade.mjs quote-deposit RUBYx 1
node scripts/trade.mjs deposit RUBYx 1 --slippage-bps=300
node scripts/trade.mjs quote-deposit-token SHILTZx 20
node scripts/trade.mjs deposit-token SHILTZx 20 --slippage-bps=300
node scripts/trade.mjs quote-withdraw RUBYx 1
node scripts/trade.mjs withdraw RUBYx 1 --slippage-bps=300
```

Intent mapping:
- "1 CROSS어치 RUBYx 사줘" -> `buy RUBYx 1`
- "SHILTZx가 무슨 게임 토큰인지 알려줘" -> `token-info SHILTZx`
- "GameToken 전체 상세 목록 보여줘" -> `token-info all`
- "SHILTZx 최근 거래랑 차트 조회해줘" -> `token-info SHILTZx --history=10 --candles=24 --tick=1h`
- "RUBYx 10개 사줘" -> first `quote buy-exact RUBYx 10`, then after confirmation `buy-exact RUBYx 10`
- "RUBYx 10개 팔아줘" -> `sell RUBYx 10`
- "RUBYx 풀에 CROSS 1개 예치해줘" -> first `quote-deposit RUBYx 1`, then after confirmation `deposit RUBYx 1`
- "SHILTZx 20개를 풀에 예치해줘" -> first `quote-deposit-token SHILTZx 20`, then after confirmation `deposit-token SHILTZx 20`
- "RUBYx LP 1개 인출해줘" -> first `quote-withdraw RUBYx 1`, then after confirmation `withdraw RUBYx 1`
- "RUBYx LP 전부 인출해줘" -> `withdraw RUBYx all`
- "0.128 CROSS에 RUBYx 지정가 매수" -> unsupported; ask whether to do a swap quote instead

---

## 6. Reporting

After a quote, report:
- side, symbol, input amount, output amount
- price and `priceImpact`
- pair address if useful

After token info, report:
- token symbol, contract, game name, genre, developer, publisher, platforms, release year, website
- current price in CROSS and USD, 24h change, total supply, liquidity, 24h buy/sell volume, holders
- recent swap/liquidity/candle rows only if the user asked for them

After a trade, report:
- parsed intent
- `txHash` and explorer URL
- receipt status
- slippage bps and min/max bound used
- balance diff: CROSS, token, gas
- for liquidity actions, LP token diff and quoted token+CROSS min amounts
- wallet suffix only; never include secrets

No fill/open/partial wording. A successful swap either changes balances or reverts; there are no resting orders.

---

## 7. OpenClaw Mode

Use only if explicitly requested. OpenClaw should shell out to the same script and only run whitelisted subcommands:

```bash
cd "$HOME/.openclaw/workspaces/cross-dex"
openclaw agent --message "Run this swap and report JSON verbatim: bash -lc 'set -a; source .env; set +a; node $HOME/.claude/skills/cross-dex-trade/scripts/trade.mjs buy RUBYx 1 --slippage-bps=300'"
```

---

## 8. Reference

For chain, API, router, and ABI details, read `references/cross-chain.md` only when needed.

## 9. Maintainer Verification

After changing API paths, router addresses, quote handling, or command docs, run:

```bash
npm test
```

This smoke test signs nothing. It verifies `tokens`, `token-info`, `pairs`, `quote buy`, `quote buy-exact`, `quote sell`, `quote-deposit`, `quote-withdraw`, router calldata selectors, and removal of legacy orderbook command names from `SKILL.md`.
