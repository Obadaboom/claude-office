#!/usr/bin/env bash
# =============================================================================
# agent-tracker.sh — Claude Code Hook → Agent Office bridge
#
# Claude Code passes hook event JSON on stdin.
# This script inspects the event and forwards relevant activity to the
# Agent Office server at $AGENT_OFFICE_URL/event (default http://127.0.0.1:3334).
#
# Hook events handled:
#   SubagentStart/SubagentStop — a subagent arrives / leaves
#   PreToolUse  — Agent task text, a step starts (tool or MCP call)
#   PostToolUse(Failure) — a step ends
#   Stop — the main session's turn ended: Jim's steps of that session end
# Always exits 0 and prints nothing (never a Stop decision).
#
# Usage (configured in ~/.claude/settings.json hooks section):
#   { "type": "command", "command": "/path/to/agent-tracker.sh" }
# =============================================================================

SERVER_URL="${AGENT_OFFICE_URL:-http://127.0.0.1:3334}/event"

# Read the hook payload from stdin


# Auth token (optional — read from file if present)
AUTH_HEADER=""
TOKEN_FILE="$HOME/.agent-office/auth-token"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
    if [ -n "$TOKEN" ]; then
        AUTH_HEADER="Authorization: Bearer $TOKEN"
    fi
fi

# Extract common fields and build event JSON in a single Python invocation.
# All variable data is passed via stdin; no shell variables are interpolated
# into Python source code.
EVENT_JSON=$(python3 "$(dirname "$0")/agent-tracker.py" 2>/dev/null)

# If Python produced no output, nothing to send
if [ -z "$EVENT_JSON" ]; then
    exit 0
fi

# Send the event, including the auth header if we have a token
if [ -n "$AUTH_HEADER" ]; then
    curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -H "$AUTH_HEADER" \
        -d "$EVENT_JSON" \
        --max-time 1 \
        > /dev/null 2>&1 &
else
    curl -sf -X POST "$SERVER_URL" \
        -H "Content-Type: application/json" \
        -d "$EVENT_JSON" \
        --max-time 1 \
        > /dev/null 2>&1 &
fi

exit 0
