---
name: cross-dex-trade
description: This skill should be used when the user asks to trade, swap, buy, or sell tokens on CROSS Chain (chain id 612055), or to drive an OpenClaw agent to execute on-chain DEX orders against the Gametoken orderbook. Handles credential collection (PRIVATE_KEY via .env or one-shot prompt), safety caps, calldata building, and transaction submission. Triggers on phrases like "CROSS chain trade", "Gametoken buy/sell", "openclaw dex", "trade RUBYx/MGT/GHUBx/SHOUT", "오픈클로 거래".
version: 0.1.0
license: MIT
---

# CROSS Chain DEX Trading via OpenClaw

A distributable skill that lets Claude (optionally driving an OpenClaw agent) place on-chain orders on the **Gametoken orderbook** at CROSS Chain (chain id `612055`). Execution path is **EOA + viem** — no ERC-4337 / paymaster required.

> **Scope today (v0.1):** Gametoken orderbook only (limit buy/sell, cancel, balance, pair listing). Forge and CrossDefi are HTTP/web-UI based and need browser automation — out of scope for this skill.

---

## 1. Activation

Activate when the user wants to:
- Buy/sell a token by symbol on CROSS Chain (e.g. "buy 10 RUBYx at 0.128 CROSS")
- List active CROSS Gametoken pairs / check on-chain balance
- Cancel a pending Gametoken order
- Have OpenClaw run any of the above autonomously

If the user asks about Forge/CrossDefi specifically, tell them this skill doesn't cover those yet (they're web-UI flows) and stop.

---

## 2. Prerequisites — verify before doing anything else

Run these checks in order. Stop and report to the user at the first failure.

```bash
node --version          # require >= 20
which openclaw          # optional — only needed if user asked to dispatch through openclaw
```

Then ensure the script's deps are installed (one-time):

```bash
SKILL_DIR="$HOME/.claude/skills/cross-dex-trade"
[ -d "$SKILL_DIR/node_modules" ] || (cd "$SKILL_DIR" && npm install --silent)
```

---

## 3. Credential resolution — strict priority

Resolve the trading EOA in this order. **Never echo the private key back to the user, never write it into the conversation transcript, never log it.**

1. **`./.env` in the user's current working directory** — read `PRIVATE_KEY` and (optionally) `WALLET_ADDRESS`, `CROSS_RPC_URL`, `MAX_TRADE_CROSS`.
2. **`$HOME/.claude/skills/cross-dex-trade/.env`** — same vars, used as the personal default.
3. **Ask the user** — only if both files lack `PRIVATE_KEY`. Use this exact prompt:

   > "I need a CROSS Chain EOA private key (0x-prefixed, 64 hex chars) to sign the trade.
   > **Option A (recommended):** stop here, paste this into `~/.claude/skills/cross-dex-trade/.env`:
   > ```
   > PRIVATE_KEY=0x...
   > MAX_TRADE_CROSS=10
   > ```
   > then re-ask. I won't see it.
   >
   > **Option B (one-shot):** paste it now. It will be passed to the script via process env only and will NOT be saved to disk by me. It will appear once in this transcript."

   If the user picks B, accept the PK as a string, **do not echo it**, pass it to the script as `PRIVATE_KEY=...` on the same Bash command line, and after the trade tell the user to consider rotating the key if the transcript is shared.

Validation: the value must match `^0x[0-9a-fA-F]{64}$`. Reject otherwise without retrying silently.

---

## 4. Safety rails — apply every time

Before submitting any tx:

1. **Chain id check** — the trade script verifies `eth_chainId == 612055` and aborts otherwise. Do not bypass.
2. **MAX_TRADE_CROSS cap** — if env sets it, the script aborts when a single trade's CROSS notional exceeds it. Recommend `MAX_TRADE_CROSS=10` to new users.
3. **Confirm with the user** before any trade where notional > 1 CROSS. Show the parsed intent (symbol, side, price, amount, total CROSS, MAX cap if any) and ask for an explicit "yes / 진행" before running. For balance/list commands, no confirmation needed.
4. **Refuse** to run trades on behalf of an address the user can't read back. If `WALLET_ADDRESS` is set in env, derive from PK and warn on mismatch.
5. Never stash the PK anywhere outside the env file the user explicitly chose.

---

## 5. Execution

Two dispatch modes — pick based on the user's phrasing:

### Mode A — Direct (no openclaw)
Default. Run the bundled script directly via Bash:

```bash
cd "$HOME/.claude/skills/cross-dex-trade"
# env vars come from the .env you resolved in step 3 — load them yourself if needed
node scripts/trade.mjs <subcommand> [args]
```

Subcommands (output is JSON for easy parsing):
- `pairs` — list active pairs (symbol, price, pair address, token address)
- `balance` — show CROSS + nonzero token balances for the EOA
- `buy <SYMBOL> <PRICE> <AMOUNT>` — limit buy; sends `PRICE * AMOUNT` CROSS as value
- `sell <SYMBOL> <PRICE> <AMOUNT>` — limit sell; auto-approves token to DEX (max uint) if allowance is short
- `cancel <SYMBOL> <ORDER_ID>` — cancel one open order on a pair

Example:
```bash
PRIVATE_KEY=0x... node scripts/trade.mjs buy RUBYx 0.128 31
```

### Mode B — Dispatch via OpenClaw
Use only if the user explicitly says "openclaw로 / via openclaw / let openclaw do it". OpenClaw doesn't natively know CROSS DEX semantics, so we have it shell out to the same script.

1. Stage a workspace dir: `mkdir -p "$HOME/.openclaw/workspaces/cross-dex" && cp "$HOME/.claude/skills/cross-dex-trade/assets/SOUL.template.md" "$HOME/.openclaw/workspaces/cross-dex/SOUL.md"`
2. Write the resolved env to `"$HOME/.openclaw/workspaces/cross-dex/.env"` (chmod 600). If you got the PK from an existing `.env`, prefer symlinking instead of copying.
3. Invoke openclaw with the user's intent rendered into a concrete shell command:
   ```bash
   cd "$HOME/.openclaw/workspaces/cross-dex"
   openclaw agent --message "Run this trade and report the JSON output verbatim: bash -lc 'set -a; source .env; set +a; node $HOME/.claude/skills/cross-dex-trade/scripts/trade.mjs buy RUBYx 0.128 31'"
   ```
4. Capture stdout, parse the JSON envelope (`txHash`, `status`, `explorer`), report to the user.

---

## 6. Reporting back

After every trade, surface to the user:
- The parsed intent (so they can audit it)
- `txHash` and the explorer link `https://explorer.crosstoken.io/612055/tx/<hash>`
- Receipt status (`success` / `reverted`)
- A reminder of the wallet address used (last 6 chars)

Never include the PK or full env contents in the report.

---

## 7. Distribution

This skill folder is the unit of distribution. Recipients:
1. Copy the whole `cross-dex-trade/` folder into `~/.claude/skills/`
2. Run `cd ~/.claude/skills/cross-dex-trade && npm install` once (or let the skill do it on first use)
3. Either create `~/.claude/skills/cross-dex-trade/.env` from `.env.example`, or let the skill prompt them on first run
4. Optionally `cp assets/SOUL.template.md ~/.openclaw/workspaces/cross-dex/SOUL.md` to enable Mode B

For deeper details (chain config, DEX addresses, function selectors, calldata layout) read `references/cross-chain.md` only when needed — it stays out of context otherwise.
