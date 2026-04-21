#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_LINK="$HOME/.bun/install/global/node_modules/kanna-code"
PM2_NAME="${KANNA_PM2_PROCESS_NAME:-kanna}"
PM2_TEMPLATE="$REPO_DIR/scripts/pm2.config.cjs.tmpl"
PM2_CONFIG="$REPO_DIR/scripts/pm2.config.cjs"
PM2_ENV_FILE="$REPO_DIR/scripts/pm2.env"

cd "$REPO_DIR"

# Load local secrets (cloudflared token, password) from untracked file if present.
if [[ -f "$PM2_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$PM2_ENV_FILE"; set +a
fi

# Compose args passed to ./bin/kanna. Tokens/password sourced from env.
KANNA_ARGS="--no-open"
if [[ -n "${KANNA_CLOUDFLARED_TOKEN:-}" ]]; then
  KANNA_ARGS="$KANNA_ARGS --cloudflared $KANNA_CLOUDFLARED_TOKEN"
fi
if [[ -n "${KANNA_PASSWORD:-}" ]]; then
  KANNA_ARGS="$KANNA_ARGS --password $KANNA_PASSWORD"
fi
export KANNA_ARGS

if [[ ! -L "$GLOBAL_LINK" ]]; then
  echo "→ Linking $GLOBAL_LINK → $REPO_DIR"
  rm -rf "$GLOBAL_LINK"
  mkdir -p "$(dirname "$GLOBAL_LINK")"
  ln -s "$REPO_DIR" "$GLOBAL_LINK"
fi

if [[ ! -d node_modules ]] || [[ package.json -nt node_modules ]] || [[ bun.lock -nt node_modules ]]; then
  echo "→ bun install"
  bun install
fi

echo "→ bun run build"
bun run build

if ! command -v pm2 >/dev/null 2>&1; then
  echo "→ bun install -g pm2"
  bun install -g pm2
fi

if ! command -v envsubst >/dev/null 2>&1; then
  echo "✗ envsubst not found (install gettext: brew install gettext)" >&2
  exit 1
fi

echo "→ render $PM2_CONFIG"
REPO_DIR="$REPO_DIR" PM2_NAME="$PM2_NAME" KANNA_ARGS="$KANNA_ARGS" \
  envsubst '${REPO_DIR} ${PM2_NAME} ${KANNA_ARGS}' < "$PM2_TEMPLATE" > "$PM2_CONFIG"

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  echo "→ pm2 reload $PM2_NAME"
  pm2 reload "$PM2_CONFIG" --update-env
else
  echo "→ pm2 start $PM2_NAME"
  pm2 start "$PM2_CONFIG"
fi

pm2 save
echo "✓ kanna running under pm2"
