# CROSS Chain & GameToken Swap Reference

Loaded by Claude only when the skill needs underlying details, such as contract addresses, API paths, liquidity math, or ABI debugging.

## Chain

| Field | Value |
|---|---|
| Chain ID | `612055` |
| Default RPC | `https://mainnet.crosstoken.io:22001/` |
| Native token | CROSS (18 decimals) |
| Block explorer | `https://explorer.crosstoken.io/612055` |

Override RPC with `CROSS_RPC_URL`.

## GameToken Swap + Liquidity

The current `x.crosstoken.io/tokens` service is AMM swap-based. Deposit and withdraw are router liquidity operations against the same AMM pairs.

| Item | Value |
|---|---|
| API base | `https://game-swap-api.cross.nexus/v1` |
| Router proxy | `0x639Adf46ac111399361c422bC32c3892f0cbb70c` |
| Router implementation | `0xa5aa6e57b4a0402d9758e46612e382a4adfcbeab` |
| Wrapped native CROSS | `0x8739bC962460a8a25184aaa9166b74dd8448a194` |
| Zap proxy | `0x622fC43D7CEB5396509C875925bc3a1660Eff9cE` |

API paths used by the script:

| Path | Purpose |
|---|---|
| `/tokens` | Listed GameTokens, metadata, game info, stats |
| `/tokens/<address>` | Single GameToken metadata, stats, description, game pointer |
| `/tokens/<address>/candles?tick=<1m|5m|15m|1h|4h|1d>&size=<N>` | Token price candles |
| `/tokens/<address>/holders` | Token holder list when indexed |
| `/games` | Listed game metadata |
| `/games/<slug>` | Game detail, genre, developer, publisher, platforms, release year, website |
| `/pairs` | AMM pair addresses and reserves |
| `/pairs/<address>` | Pair reserves, fee config, 24h counts |
| `/pairs/<address>/swaps?limit=<N>` | Recent swap events |
| `/pairs/<address>/liquidity?limit=<N>` | Recent liquidity add/remove events |
| `/quote?pair=<pair>&token_in=<addr>&amount_in=<wei>&exact=in` | Exact-input quote |
| `/quote?pair=<pair>&token_in=<addr>&amount_out=<wei>&exact=out` | Exact-output quote |

Liquidity deposit/withdraw quotes are computed locally from `/pairs` reserves and pair LP supply:
- deposit CROSS amount -> required GameToken amount and expected LP amount
- withdraw LP amount -> expected GameToken and CROSS outputs

Router functions used:

| Operation | Function |
|---|---|
| Buy exact input | `swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)` |
| Buy exact output | `swapNativeForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)` |
| Sell exact input | `swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)` |
| Deposit liquidity | `addLiquidity(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountNativeMin, address to, uint256 deadline)` with native desired sent as `msg.value` |
| Withdraw liquidity | `removeLiquidity(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountNativeMin, address to, uint256 deadline)` |

Pair functions used:

| Purpose | Function |
|---|---|
| LP supply | `totalSupply()` |
| LP wallet balance | `balanceOf(address)` |
| Router allowance | `allowance(address owner, address spender)` |
| LP approval | `approve(address spender, uint256 amount)` |

Path conventions:
- Buy: `[wrappedNative, token]`
- Sell: `[token, wrappedNative]`

Slippage:
- `buy` and `sell` lower the quoted output by `slippageBps`.
- `buy-exact` raises the quoted CROSS input by `slippageBps`.
- `deposit` lowers the required token minimum by `slippageBps` while sending the exact CROSS amount.
- `withdraw` lowers both token and CROSS minimum outputs by `slippageBps`.

## Removed Orderbook Flow

The previous orderbook router `0x6690844Aac584AcA982E195B7BDeBd48740fbcb1`, pair-info API, limit orders, market buy matcher, open orders, and cancel flow are obsolete for this skill. Do not describe or call them unless explicitly discussing legacy behavior.
