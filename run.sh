#!/bin/bash
set -e

KANNA_DIR="/home/electerm/data/CorpHub/personal/Kanna"
PROJECT_DIR="/home/electerm/data/CorpHub/personal/ProcesetAETL"

cd "$KANNA_DIR"

exec bun run ./src/server/cli.ts \
    --no-open \
    --port 10002 \
    --remote
