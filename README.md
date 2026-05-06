# cross-dex-trade

A Claude Code skill that executes on-chain orders on the **Gametoken orderbook** at **CROSS Chain** (chain id `612055`), optionally dispatched through an [OpenClaw](https://github.com/openclaw/openclaw) agent.

- **Stack:** EOA + viem (no ERC-4337, no paymaster)
- **DEX:** Gametoken router `0x6690844Aac584AcA982E195B7BDeBd48740fbcb1`
- **Subcommands:** `pairs`, `balance`, `buy`, `sell`, `cancel`
- **Distribution:** standalone Claude skill **and** wrapped as a Claude Code plugin

> ⚠️ **This skill signs and broadcasts real transactions with the private key you provide.** Test with small amounts. Set `MAX_TRADE_CROSS` in `.env`. Read `skills/cross-dex-trade/scripts/trade.mjs` before using.

---

## Install — Recommended (via Marketplace)

```bash
/plugin marketplace add github.com/to-nexus/cross-skills-suite
/plugin install cross-dex-trade@cross-skills-suite
```

Part of the [CROSS Skills Suite](https://github.com/to-nexus/cross-skills-suite) — installs alongside `cross-prediction` and other CROSS Chain ecosystem skills.

---

## Install — Standalone

### Option 1 — Plain skill (one user, fastest)

```bash
git clone <this-repo> /tmp/skill-cross-dex-trade
bash /tmp/skill-cross-dex-trade/install.sh        # symlinks into ~/.claude/skills/
```

Or manually:
```bash
cp -r skills/cross-dex-trade ~/.claude/skills/
cd ~/.claude/skills/cross-dex-trade && npm install
```

### Option 2 — Claude Code plugin (marketplace-installable)

If you maintain a marketplace, add an entry pointing at this repo:

```json
{
  "name": "cross-dex-trade",
  "source": { "source": "github", "repo": "to-nexus/skill-cross-dex-trade" },
  "category": "blockchain"
}
```

End users then run `/plugin marketplace add <your-marketplace>` then `/plugin install cross-dex-trade`.

### Option 3 — OpenClaw agent dispatcher (advanced)

After Option 1, copy the SOUL.md template into an OpenClaw workspace:
```bash
mkdir -p ~/.openclaw/workspaces/cross-dex
cp ~/.claude/skills/cross-dex-trade/assets/SOUL.template.md ~/.openclaw/workspaces/cross-dex/SOUL.md
ln -s ~/.claude/skills/cross-dex-trade/.env ~/.openclaw/workspaces/cross-dex/.env
```
Then drive it via Claude with phrases like *"openclaw로 RUBYx 10개 매수해줘"*.

---

## Configuration

Copy the template and fill in your wallet:
```bash
cp skills/cross-dex-trade/.env.example skills/cross-dex-trade/.env
chmod 600 skills/cross-dex-trade/.env
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PRIVATE_KEY` | yes | — | EOA signer, `0x` + 64 hex chars |
| `MAX_TRADE_CROSS` | recommended | unset | Per-trade CROSS notional cap; trade aborts above this |
| `CROSS_RPC_URL` | no | `https://mainnet.crosstoken.io:22001/` | Override only if you have a private RPC |
| `WALLET_ADDRESS` | no | derived from PK | Cross-check; mismatch aborts |

The skill resolves `.env` from (in order): cwd → `~/.claude/skills/cross-dex-trade/` → asks once.

---

## Usage

Inside Claude Code, just describe the trade in plain language. The skill activates on phrases like:
- "buy 31 RUBYx at 0.128 CROSS"
- "show CROSS balance"
- "list active gametoken pairs"
- "cancel order 12345 on RUBYx"
- "openclaw로 SHOUT 100개 0.03에 매도"

Direct CLI (skipping Claude):
```bash
cd ~/.claude/skills/cross-dex-trade
PRIVATE_KEY=0x... node scripts/trade.mjs pairs
PRIVATE_KEY=0x... node scripts/trade.mjs balance
PRIVATE_KEY=0x... node scripts/trade.mjs buy   RUBYx 0.128 31
PRIVATE_KEY=0x... node scripts/trade.mjs sell  RUBYx 0.150 10
PRIVATE_KEY=0x... node scripts/trade.mjs cancel RUBYx 1234
```

All commands emit a single JSON object on stdout (txHash, status, explorer URL).

---

## Layout

```
skill-cross-dex-trade/                  # repo root = plugin
├── .claude-plugin/
│   └── plugin.json                     # plugin manifest (Option 2)
├── install.sh                          # symlink installer (Option 1)
├── README.md
├── LICENSE
└── skills/
    └── cross-dex-trade/                # the skill itself
        ├── SKILL.md                    # what Claude reads to drive trades
        ├── package.json                # viem dependency
        ├── .env.example
        ├── scripts/
        │   └── trade.mjs               # EOA trader (pairs/balance/buy/sell/cancel)
        ├── references/
        │   └── cross-chain.md          # chain + DEX details (lazy-loaded)
        └── assets/
            └── SOUL.template.md        # OpenClaw agent definition
```

---

## Safety model

The skill enforces three independent rails:

1. **Chain-id check.** `trade.mjs` aborts unless `eth_chainId == 612055`.
2. **Notional cap.** If `MAX_TRADE_CROSS` is set, any single trade exceeding it aborts before signing.
3. **Confirmation prompt.** `SKILL.md` instructs Claude to require an explicit "yes" for trades > 1 CROSS.

The bundled OpenClaw `SOUL.md` adds a fourth rail: the agent will only run the five whitelisted subcommands, never arbitrary shell.

The private key never appears in the Claude transcript unless the user pastes it in directly (Option B in `SKILL.md`'s credential resolution). Even then, it's passed via `process.env` to the spawned `node`, not echoed back.

---

## Limitations

- **Gametoken orderbook only.** Forge (`x.crosstoken.io/forge`) and CrossDefi (`crossdefi.io/swap-bridge`) are web-UI flows; this skill does not drive them.
- **EOA only.** ERC-4337 / smart-wallet trading isn't supported here — the source project [`ara_4337`](https://github.com/) covers that path.
- **No slippage controls beyond limit price.** Limit orders are inherently slippage-bounded; market orders are not implemented.

---

## License

[MIT](LICENSE) — but read the disclaimer at the bottom of the LICENSE file before using.
