#!/usr/bin/env bash
# npm run demo (2v): a second office fed only fake work — UI 3335, server 3336, a fresh temp HOME.
# The live office (3333/3334, the real HOME) is never touched; restart = a fresh story.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/node_modules/.bin:$PATH"
export HOME="$(mktemp -d "${TMPDIR:-/tmp}/office-demo.XXXXXX")"
export AGENT_OFFICE_DEMO=1
export AGENT_OFFICE_UI_PORT="${AGENT_OFFICE_UI_PORT:-3335}" AGENT_OFFICE_PORT="${AGENT_OFFICE_PORT:-3336}"
export AGENT_OFFICE_UI_ORIGIN="http://localhost:$AGENT_OFFICE_UI_PORT"
unset AGENT_OFFICE_BOARDS_DIR
echo "Demo office: http://localhost:$AGENT_OFFICE_UI_PORT/?theme=office (HOME=$HOME)"
exec concurrently "node server/index.js" "vite"
