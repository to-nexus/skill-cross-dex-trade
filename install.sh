#!/usr/bin/env bash
# cross-dex-trade installer — symlinks the skill into ~/.claude/skills/ and
# installs Node deps. Idempotent: safe to re-run.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$REPO_DIR/skills/cross-dex-trade"
SKILL_DST="$HOME/.claude/skills/cross-dex-trade"

if [ ! -d "$SKILL_SRC" ]; then
  echo "ERROR: $SKILL_SRC not found. Run install.sh from inside the cloned repo." >&2
  exit 1
fi

mkdir -p "$HOME/.claude/skills"

if [ -L "$SKILL_DST" ]; then
  current="$(readlink "$SKILL_DST")"
  if [ "$current" = "$SKILL_SRC" ]; then
    echo "✓ symlink already points at $SKILL_SRC"
  else
    echo "↻ updating symlink: $SKILL_DST → $SKILL_SRC (was $current)"
    rm "$SKILL_DST"
    ln -s "$SKILL_SRC" "$SKILL_DST"
  fi
elif [ -e "$SKILL_DST" ]; then
  echo "ERROR: $SKILL_DST already exists and is NOT a symlink." >&2
  echo "  Move/back it up, then re-run install.sh." >&2
  exit 1
else
  ln -s "$SKILL_SRC" "$SKILL_DST"
  echo "✓ symlinked $SKILL_DST → $SKILL_SRC"
fi

echo "↻ installing Node deps in $SKILL_SRC ..."
( cd "$SKILL_SRC" && npm install --silent )
echo "✓ deps installed"

if [ ! -f "$SKILL_SRC/.env" ]; then
  cat <<EOF

NEXT STEPS
  1. Create your wallet env file:
       cp $SKILL_SRC/.env.example $SKILL_SRC/.env
       chmod 600 $SKILL_SRC/.env
     Then edit it and set PRIVATE_KEY (and ideally MAX_TRADE_CROSS).

  2. (Optional, OpenClaw mode):
       mkdir -p ~/.openclaw/workspaces/cross-dex
       cp $SKILL_SRC/assets/SOUL.template.md ~/.openclaw/workspaces/cross-dex/SOUL.md
       ln -s $SKILL_SRC/.env ~/.openclaw/workspaces/cross-dex/.env

  3. Try it from Claude Code:
       "list active CROSS gametoken pairs"
       "balance"

EOF
else
  echo "✓ $SKILL_SRC/.env already present — skipping setup"
fi
