# cross-dex-trade

A Claude Code skill that quotes and executes **swap-based GameToken trades and AMM liquidity actions** on **CROSS Chain** (chain id `612055`).

The old orderbook flow has been removed. This skill now follows the current `x.crosstoken.io/tokens` service: token/game metadata, market stats, chart candles, recent swaps, token discovery, AMM pair discovery, quotes, CROSS -> GameToken swaps, exact-output buys, GameToken -> CROSS swaps, liquidity deposit/withdraw, LP balance checks, and wallet balance checks.

- **Stack:** EOA + viem
- **API:** `https://game-swap-api.cross.nexus/v1`
- **Router:** `0x639Adf46ac111399361c422bC32c3892f0cbb70c`
- **Wrapped CROSS:** `0x8739bC962460a8a25184aaa9166b74dd8448a194`
- **Subcommands:** `tokens`, `token-info`, `pairs`, `quote`, `balance`, `buy`, `buy-exact`, `sell`, `quote-deposit`, `deposit`, `quote-deposit-token`, `deposit-token`, `quote-withdraw`, `withdraw`

> This skill signs and broadcasts real swap and liquidity transactions with the private key you provide. Test with small amounts and set `MAX_TRADE_CROSS` in `.env`.

## Install

```bash
/plugin marketplace add github.com/to-nexus/cross-skills-suite
/plugin install cross-dex-trade@cross-skills-suite
```

Standalone:

```bash
git clone <this-repo> /tmp/skill-cross-dex-trade
bash /tmp/skill-cross-dex-trade/install.sh
```

## Configuration

```bash
cp skills/cross-dex-trade/.env.example skills/cross-dex-trade/.env
chmod 600 skills/cross-dex-trade/.env
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PRIVATE_KEY` | write commands | - | EOA signer, `0x` + 64 hex chars |
| `MAX_TRADE_CROSS` | recommended | unset | Per-transaction CROSS notional cap |
| `CROSS_RPC_URL` | no | `https://mainnet.crosstoken.io:22001/` | RPC override |
| `WALLET_ADDRESS` | no | derived from PK | Mismatch aborts |
| `GAME_SWAP_API_URL` | no | `https://game-swap-api.cross.nexus/v1` | API override |

## Usage

Inside Claude Code, describe the swap in plain language:
- "RUBYx 1 CROSS어치 견적 내줘"
- "SHILTZx 게임 정보랑 최근 거래 보여줘"
- "RUBYx 1 CROSS어치 사줘"
- "RUBYx 10개 정확히 사줘"
- "RUBYx 10개 팔아줘"
- "RUBYx pool에 1 CROSS 예치해줘"
- "SHILTZx 20개를 pool에 예치해줘"
- "RUBYx LP 0.5개 출금해줘"
- "내 GameToken 잔고 보여줘"

Direct CLI:

```bash
cd ~/.claude/skills/cross-dex-trade
node scripts/trade.mjs tokens --query=RUBY
node scripts/trade.mjs token-info SHILTZx --history=5 --candles=12 --tick=1h
node scripts/trade.mjs token-info all --limit=20
node scripts/trade.mjs pairs
node scripts/trade.mjs quote buy RUBYx 1
node scripts/trade.mjs quote buy-exact RUBYx 10
node scripts/trade.mjs quote sell RUBYx 10
node scripts/trade.mjs quote-deposit RUBYx 1
node scripts/trade.mjs quote-deposit-token SHILTZx 20
node scripts/trade.mjs quote-withdraw RUBYx 0.5
PRIVATE_KEY=0x... node scripts/trade.mjs balance
PRIVATE_KEY=0x... node scripts/trade.mjs buy RUBYx 1 --slippage-bps=300
PRIVATE_KEY=0x... node scripts/trade.mjs buy-exact RUBYx 10 --slippage-bps=300
PRIVATE_KEY=0x... node scripts/trade.mjs sell RUBYx 10 --slippage-bps=300
PRIVATE_KEY=0x... node scripts/trade.mjs deposit RUBYx 1 --slippage-bps=300
PRIVATE_KEY=0x... node scripts/trade.mjs deposit-token SHILTZx 20 --slippage-bps=300
PRIVATE_KEY=0x... node scripts/trade.mjs withdraw RUBYx 0.5 --slippage-bps=300
PRIVATE_KEY=0x... node scripts/trade.mjs withdraw RUBYx all --slippage-bps=300
```

All commands emit one JSON object on stdout.

## Safety Model

1. Chain id must be `612055`.
2. `MAX_TRADE_CROSS` caps buy spend, buy-exact max input, sell quoted output, deposit CROSS input, and withdraw quoted CROSS output.
3. Default slippage is `300` bps. Values above `5000` bps are refused.
4. `sell`, `deposit`, and `withdraw` auto-approve the router only when allowance is insufficient.

## Verification

Run the network-backed smoke test after any swap API or router change:

```bash
cd skills/cross-dex-trade
npm test
```

The test validates token discovery, token-info discovery, pair discovery, `buy` / `buy-exact` / `sell` quote schema, deposit/withdraw quote math, router calldata selectors, and removal of legacy orderbook commands from `SKILL.md`. It does not sign or broadcast transactions.

## Removed Legacy Behavior

Orderbook commands are intentionally gone: no limit orders, no market matcher, no open orders, no cancels, no bid/ask depth, and no fill/open/partial state. Use `quote` plus swap slippage bounds instead.

## Layout

```text
skill-cross-dex-trade/
├── .claude-plugin/plugin.json
├── install.sh
├── README.md
└── skills/cross-dex-trade/
    ├── SKILL.md
    ├── package.json
    ├── .env.example
    ├── scripts/trade.mjs
    ├── references/cross-chain.md
    └── assets/SOUL.template.md
```

## License

[MIT](LICENSE)
