# CROSS Chain & Gametoken DEX — Reference

Loaded by Claude only when the SKILL needs the underlying details (e.g. user asks about contract addresses, the script throws an unfamiliar revert, or someone is forking the skill).

## Chain

| Field | Value |
|---|---|
| Chain ID | `612055` |
| Default RPC | `https://mainnet.crosstoken.io:22001/` |
| Native token | CROSS (18 decimals) |
| Block explorer | `https://explorer.crosstoken.io/612055` (tx URL: `.../tx/<hash>`) |

Override RPC with `CROSS_RPC_URL`.

## Gametoken Orderbook DEX

- **Router (proxy):** `0x6690844Aac584AcA982E195B7BDeBd48740fbcb1`
- **Pair-info API:** `https://dex-api.crosstoken.io/dex/pair-info` → returns pair list with `pair_address`, `base_symbol`, `base_address`, `quote_symbol`, `quote_address`, `tick_size`, `lot_size`, `min_amount`, `billboard.price`, `active`.
- **Open orders API:** `https://dex-api.crosstoken.io/dex/open-order?owner=<addr>&pair=<pairAddress>`

### Function selectors & calldata

All on-chain calls go to the router with raw calldata.

| Op | Selector | Layout (after selector, each slot = 32 bytes) |
|---|---|---|
| Buy limit  | `0xeafff4e0` | `pair, price, amount, orderType=0, hint1=0, hint2=0, maxMatch=50` |
| Sell limit | `0x349ed71f` | `pair, price, amount, orderType=0, hint1=0, hint2=0, maxMatch=50` |
| Cancel     | `0x1ec482d7` | `pair, dynOffset=0x40, orderIdsLen=1, orderId` |

- `price` = quote-per-base in 18 decimals (e.g. `parseEther("0.128")`)
- `amount` = base token amount in 18 decimals
- Buy limit: caller MUST send `value = (price * amount) / 1e18` CROSS
- Sell limit: caller MUST first `approve(DEX_CONTRACT, amount)` on the base ERC20

### Smart-wallet limitation

The DEX rejects calls from contract callers with `error 0xa7392345`. ERC-4337 smart wallets must therefore relay through their owner EOA (transfer base token / CROSS to owner first, then have owner call DEX directly). The bundled `trade.mjs` is EOA-only and avoids this whole class of failures.

## Other CROSS DEXes — not in this skill

- **Forge** (meme swap): `https://x.crosstoken.io/forge` — web UI, no documented public API. Needs browser automation.
- **CrossDefi** (cross-chain swap/bridge): `https://www.crossdefi.io/swap-bridge` — same.

If asked, tell the user this skill only covers Gametoken; the others require browser tooling.

## Reference: ara_4337 source

- `scripts/gametoken-trade.ts` — the EOA + 4337 reference implementation this skill's trade.mjs is derived from.
- `src/lib/bundler/submit-orderbook.ts` — orderbook submit helper used by the chat UI.
- `docs/DEPLOYED_CONTRACTS_REPORT.md` — chain + contract addresses.
