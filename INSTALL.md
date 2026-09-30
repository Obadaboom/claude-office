# INSTALL (for Claude Code)

You are setting up the Claude Office for the user. Run these steps in order. Do not guess or improvise. If a step fails, stop and tell the user what failed, in plain words.

## 1. Check the needs

Run:

```bash
uname -s; node -v; npm -v; python3 --version; git --version
```

- `uname -s` must print `Darwin` (a Mac) or `Linux` (WSL counts as Linux).
- On native Windows (not WSL), stop. Tell the user: open Claude Code inside WSL and ask again there.
- `node -v` must start with v20, v22, v23, v24 or v25. The database part (better-sqlite3) supports only these. Node 21 and Node 26 or newer will not work.
- npm, python3 and git must each print a version.

If any is missing, or Node is outside that list, install it for this system. Ask the user first, and say what you will install and how. Wait for a yes.

- Mac: use Homebrew if `brew` is there (`brew install node@22`, `brew install git python3`). Without Homebrew: the official Node installer from nodejs.org, and `xcode-select --install` for git and python3.
- Linux: `apt` or `dnf` (`sudo apt install nodejs npm git python3`, or `sudo dnf install ...`). If that Node is outside the list, use the official Node 22 install from nodejs.org instead.

Then run the check again. If something is still missing, stop and tell the user which one.

## 2. Get the code

If `~/claude-office` does not exist:

```bash
git clone https://github.com/Obadaboom/claude-office ~/claude-office
```

If it exists, update it instead: `git -C ~/claude-office pull`.

Run every step below from `~/claude-office`.

## 3. Install

```bash
cd ~/claude-office && npm ci
```

## 4. Add the hook (ask first)

The office learns what Claude Code is doing through one hook script, `hooks/agent-tracker.sh`.

1. Show the user `hooks/hooks.json`. Say: it adds this hook to 9 Claude Code events in `~/.claude/settings.json`. `<office>` becomes `~/claude-office`. Their other settings and hooks stay as they are. A backup is made first. Running it again changes nothing.
2. Show the user whether `~/.claude/settings.json` exists, and only its current `hooks` section. Never print or read out the rest of the file: it can hold API keys. Run:

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
if not os.path.exists(p):
    print('No settings.json yet. It will be created.')
else:
    print('settings.json exists. Its hooks section now:')
    print(json.dumps(json.load(open(p)).get('hooks', {}), indent=2))
PY
```

3. Ask: "OK to add the office hook to your Claude Code settings?" Wait for a yes.
4. On yes:

```bash
cd ~/claude-office && npm run install-hooks
```

On no: skip this step. Tell the user the demo still works, but the real office will stay empty.

## 5. Start the demo

Run in the background (it keeps running):

```bash
cd ~/claude-office && npm run demo
```

Wait until http://localhost:3335 answers, then open it (on Linux use `xdg-open`; if neither works, give the user the link):

```bash
open "http://localhost:3335/?theme=office"
```

Tell the user: "This is the demo, with made-up work. Type a task in the chat, like 'Add a dark mode toggle', and watch it get built."

## 6. Start the real office

Run in the background (it keeps running):

```bash
cd ~/claude-office && npm run dev:all
```

Wait until http://localhost:3333 answers, then open it (on Linux use `xdg-open`; if neither works, give the user the link):

```bash
open "http://localhost:3333/?theme=office"
```

Tell the user:

- "This is your real office. Start a new Claude Code session and a person at a desk starts working."
- "Click the board on the wall, the TV or the boss's desk to see sample boards. They live in ~/.agent-office/boards. Ask me to change them any time."
- "To start it again later: `cd ~/claude-office && npm run dev:all`."
