#!/usr/bin/env bash
TITLE="${1:-Agent Office}"
MSG="${2:-Something happened}"
if [ "$(uname -s)" = "Darwin" ]; then
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' "$TITLE" "$MSG" 2>/dev/null
elif command -v notify-send >/dev/null 2>&1; then
  notify-send -- "$TITLE" "$MSG" 2>/dev/null
fi
exit 0
