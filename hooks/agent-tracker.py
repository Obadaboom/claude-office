import json, sys, os, re

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)

hook_event = d.get('hook_event_name', '')
tool_name  = d.get('tool_name', '')

# Role mapping: normalise subagent / agent types to office role keys
ROLE_MAP = {
    'debugger':             'debugger',
    'code-reviewer':        'code-reviewer',
    'code_reviewer':        'code-reviewer',
    'frontend-developer':   'frontend-developer',
    'frontend_developer':   'frontend-developer',
    'fullstack-developer':  'fullstack-developer',
    'fullstack_developer':  'fullstack-developer',
    'test-engineer':        'test-engineer',
    'test_engineer':        'test-engineer',
    'security-auditor':     'security-auditor',
    'security_auditor':     'security-auditor',
    'architect-reviewer':   'architect-reviewer',
    'architect_reviewer':   'architect-reviewer',
    'performance-engineer': 'performance-engineer',
    'performance_engineer': 'performance-engineer',
    'devops-engineer':      'devops-engineer',
    'devops_engineer':      'devops-engineer',
    'database-architect':   'database-architect',
    'database_architect':   'database-architect',
    'typescript-pro':       'typescript-pro',
    'typescript_pro':       'typescript-pro',
    'ai-engineer':          'ai-engineer',
    'ai_engineer':          'ai-engineer',
    'prompt-engineer':      'prompt-engineer',
    'prompt_engineer':      'prompt-engineer',
    'general-purpose':      'general-purpose',
    'general_purpose':      'general-purpose',
    'Explore':              'Explore',
}

# Display name per role
NAME_MAP = {
    'debugger':             'Debugger',
    'code-reviewer':        'Reviewer',
    'frontend-developer':   'Frontend',
    'fullstack-developer':  'Fullstack',
    'test-engineer':        'Tester',
    'security-auditor':     'Security',
    'architect-reviewer':   'Architect',
    'performance-engineer': 'PerfEng',
    'devops-engineer':      'DevOps',
    'database-architect':   'DBA',
    'typescript-pro':       'TS Pro',
    'ai-engineer':          'AI Eng',
    'prompt-engineer':      'Prompts',
    'general-purpose':      'Agent',
    'Explore':              'Explorer',
}

def role_of(agent_type):
    return ROLE_MAP.get(agent_type or '', 'general-purpose')

def emit(ev):
    # Paths and ids only: never prompt, command or message text.
    # sessionId on every event (a subagent's = its parent session: 2c folds agents into it)
    if d.get('session_id'):
        ev.setdefault('sessionId', d['session_id'])
    if hook_event == 'SubagentStart':
        ev['transcriptPath'] = d.get('transcript_path', '')
    elif hook_event == 'SubagentStop':
        ev['agentTranscriptPath'] = d.get('agent_transcript_path', '')
    elif not agent_id and d.get('transcript_path'):
        ev.setdefault('transcriptPath', d['transcript_path'])
    print(json.dumps(ev))
    sys.exit(0)

# Subagent id (present on SubagentStart/Stop and on tool calls made inside a subagent)
agent_id = d.get('agent_id', '')
office_id = f'agent-{agent_id}' if agent_id else 'assistant-claude'
role = role_of(d.get('agent_type', ''))

# ── Main session lifecycle (working / waiting on you / back) ──────────────
# (Stop is 2a2's turn end below; emit() adds the transcript path)
if hook_event in ('Notification', 'UserPromptSubmit', 'SessionEnd'):
    # The ~60 s idle reminder is not a real ask: forwarding it undoes "Send back"
    if hook_event == 'Notification' and (d.get('notification_type') == 'idle_prompt' or (
            not d.get('notification_type') and 'waiting for your input' in str(d.get('message', '')).lower())):
        sys.exit(0)
    print(json.dumps({'type': 'session_event', 'event': hook_event,
                      'sessionId': d.get('session_id', ''), 'transcriptPath': d.get('transcript_path', '')}))
    sys.exit(0)

# ── Subagent lifecycle ───────────────────────────────────────────────────────
if hook_event == 'SubagentStart' and agent_id:
    emit({'type': 'agent_spawned',
          'agent': {'id': office_id, 'name': NAME_MAP.get(role, 'Agent'), 'role': role, 'task': ''}})

def first_line(text):
    return next((l for l in str(text).splitlines() if l.strip()), '')

def final_result(path):
    """Only the LAST assistant entry of a transcript JSONL (its tail): its text, else a
    StructuredOutput's summary/result or its scalars and array lengths, else '' (no narration)."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 65536))
            lines = f.read().decode('utf-8', 'ignore').splitlines()
    except Exception:
        return ''
    for line in reversed(lines):
        try:
            msg = json.loads(line)['message']
            if msg['role'] != 'assistant':
                continue
        except Exception:
            continue
        content = msg.get('content')
        blocks = [{'type': 'text', 'text': content}] if isinstance(content, str) else \
            [c for c in content or [] if isinstance(c, dict)]
        text = '\n'.join(str(c.get('text') or '') for c in blocks if c.get('type') == 'text')
        if text.strip():
            return first_line(text)
        out = next((c.get('input') for c in blocks
                    if c.get('type') == 'tool_use' and c.get('name') == 'StructuredOutput'), None)
        if not isinstance(out, dict):
            return ''  # any other tool call: the line reads "finished"
        say = next((out[k] for k in ('summary', 'result') if isinstance(out.get(k), str) and out[k].strip()), '')
        if say:
            return first_line(say)
        return ', '.join(f"{k}: {len(v) if isinstance(v, list) else v if isinstance(v, str) else json.dumps(v)}"
                         for k, v in out.items() if not isinstance(v, dict))
    return ''

if hook_event == 'SubagentStop' and agent_id:
    last = d.get('last_assistant_message')
    first = first_line(last) if isinstance(last, str) and last.strip() else \
        final_result(d.get('agent_transcript_path') or '')
    emit({'type': 'agent_completed', 'agentId': office_id, 'result': ' '.join(first.split())[:100]})

# ── Main session turn end: Jim's open steps of this session end ─────────────
if hook_event == 'Stop' and not agent_id:
    emit({'type': 'agent_working', 'agentId': office_id, 'status': '', 'turnEnd': True,
          'sessionId': d.get('session_id', '')})

if not tool_name:
    sys.exit(0)

# ── Agent tool calls  (tool_name == "Agent" or "Task") ─────────────────────
# The subagent itself arrives via SubagentStart/Stop. PreToolUse only carries
# the task text; PostToolUse returns at once for background agents, so it is ignored.
if tool_name in ('Agent', 'Task'):
    if hook_event == 'PreToolUse':
        inp = d.get('tool_input', {}) or {}
        emit({'type': 'agent_pending',
              'role': role_of(inp.get('subagent_type', '') or inp.get('agent_type', '')),
              'task': str(inp.get('description') or '')[:80]})  # the job = the description only
    sys.exit(0)

# ── Steps: PreToolUse opens one (by tool_use_id), PostToolUse(Failure) closes it ──
# Bash shows its description, never the command; MCP shows the tool name, never the server id.
status_map = {
    'Read':  lambda i: f"reading {i.get('file_path', '').split('/')[-1]}",
    'Write': lambda i: f"writing {i.get('file_path', '').split('/')[-1]}",
    'Edit':  lambda i: f"editing {i.get('file_path', '').split('/')[-1]}",
    'Bash':  lambda i: (i.get('description') or 'running a command')[:60],
    'Grep':  lambda i: f"searching for '{i.get('pattern', '')[:30]}'",
    'Glob':  lambda i: f"finding files: {i.get('pattern', '')[:40]}",
    'Skill': lambda i: f"using /{i.get('skill', 'skill')}",
}
is_mcp = tool_name.startswith('mcp__')
if is_mcp or tool_name in status_map:
    status = None
    if hook_event == 'PreToolUse':
        inp = d.get('tool_input', {}) or {}
        status = tool_name.split('__', 2)[-1].replace('_', ' ')[:60] if is_mcp else status_map[tool_name](inp)
    elif hook_event in ('PostToolUse', 'PostToolUseFailure'):
        status = ''
    if status is not None:
        ev = {'type': 'agent_working', 'agentId': office_id, 'status': status,
              'stepId': d.get('tool_use_id', ''), 'sessionId': d.get('session_id', '')}
        if agent_id:
            ev['role'] = role
            ev['name'] = NAME_MAP.get(role, 'Agent')
        emit(ev)

# Any other tool event inside a subagent (WebFetch, PostToolUse, ...) is a heartbeat:
# the server keeps the agent off its stale sweep, or brings it back in
if agent_id:
    emit({'type': 'agent_seen', 'agentId': office_id, 'role': role, 'name': NAME_MAP.get(role, 'Agent')})

sys.exit(0)
