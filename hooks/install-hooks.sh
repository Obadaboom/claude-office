#!/usr/bin/env bash
# install-hooks.sh — merge hooks/hooks.json into $HOME/.claude/settings.json.
# Backs the file up first, keeps every existing setting and hook, adds only what is missing.
# Writes atomically: a temp file in the same folder, then a rename (never a half-written file).
# Safe to run again: a second run changes nothing.
# Remove: delete the entries whose command ends in agent-tracker.sh (or restore the backup).
set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"
chmod +x "$HOOKS_DIR/agent-tracker.sh"
mkdir -p "$(dirname "$SETTINGS")"

python3 - "$SETTINGS" "$HOOKS_DIR" <<'PY'
import json, os, shutil, sys, tempfile, time
path, hooks_dir = sys.argv[1], sys.argv[2]
office = os.path.dirname(hooks_dir)
ours = json.loads(open(os.path.join(hooks_dir, 'hooks.json')).read().replace('<office>', office))['hooks']
settings = json.load(open(path)) if os.path.exists(path) else {}
hooks = settings.setdefault('hooks', {})
added = []
for event, groups in ours.items():
    have = {h.get('command') for g in hooks.get(event, []) for h in g.get('hooks', [])}
    for g in groups:
        if not {h['command'] for h in g['hooks']} <= have:
            hooks.setdefault(event, []).append(g)
            added.append(event)
if not added:
    print(f'Already installed in {path}. Nothing changed.')
    sys.exit(0)
if os.path.exists(path):
    backup = f'{path}.backup.{time.strftime("%Y%m%d_%H%M%S")}'
    shutil.copy2(path, backup)
    print(f'Backup: {backup}')
real = os.path.realpath(path)  # a symlinked settings.json stays a symlink
fd, tmp = tempfile.mkstemp(prefix='.settings.json.', suffix='.tmp', dir=os.path.dirname(real))
try:
    with os.fdopen(fd, 'w') as f:
        json.dump(settings, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(real):
        shutil.copymode(real, tmp)
    os.replace(tmp, real)
except BaseException:
    os.unlink(tmp)
    raise
print(f'Added the office hook to {len(added)} events in {path}: {", ".join(added)}')
PY
