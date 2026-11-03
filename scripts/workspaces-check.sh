#!/usr/bin/env bash
# Prove the workspace directions end to end: a workspace is registered, its own skill becomes a
# library package, a repeat is refused as unchanged, a changed copy needs `replace`, and the undo
# puts back the exact bytes the promotion replaced.
set -u
cd "$(dirname "$0")/.."
PORT="${WORKSPACE_PORT:-$((11450 + RANDOM % 300))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-workspace.XXXXXX")"
ROOT="$DATA/agent-root"
LIB="$DATA/library"
WS="$DATA/workspace"
mkdir -p "$ROOT" "$LIB" "$WS/skills/probe-skill"
cat > "$WS/skills/probe-skill/SKILL.md" <<'SKILL'
---
name: probe-skill
description: A skill that lives in a workspace first and in the library second.
version: 1.0.0
tags: [probe, workspace]
---

# Probe skill

## Rules

- Says what it does before it says how.
SKILL
printf 'notes for the probe\n' > "$WS/skills/probe-skill/notes.md"
printf '{"source":"elsewhere","from":"workspace"}\n' > "$WS/skills/probe-skill/.skill-academy.json"

win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
LOG="$DATA/server.log"
SKILL_ACADEMY_DATA="$(win "$DATA")" \
SKILL_ACADEMY_ONLY_ROOTS="$(win "$ROOT")" \
SKILL_ACADEMY_LIBRARY="$(win "$LIB")" \
SKILL_ACADEMY_WATCH=0 \
SKILL_ACADEMY_API_PORT="$PORT" \
npx tsx server/src/index.ts > "$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 90); do
  if curl -s "http://127.0.0.1:$PORT/api/skills?limit=1" 2>/dev/null | grep -q '"total"'; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "the workspace server did not start on $PORT; log:"; tail -30 "$LOG"; exit 1
fi

python3 - "$PORT" "$(win "$WS")" "$(win "$LIB")" "$(win "$DATA")" <<'PY'
import hashlib, json, pathlib, sys, urllib.request as u

port, ws, library, data = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
A = f'http://127.0.0.1:{port}'

def call(method, path, payload=None, timeout=300):
    body = None if payload is None else json.dumps(payload).encode()
    request = u.Request(A + path, data=body, method=method, headers={'content-type': 'application/json'})
    try:
        response = u.urlopen(request, timeout=timeout)
        raw = response.read().decode()
        return response.status, (json.loads(raw) if raw.strip().startswith(('{', '[')) else raw)
    except Exception as error:
        raw = error.read().decode() if hasattr(error, 'read') else '{}'
        try:
            return getattr(error, 'code', None), json.loads(raw or '{}')
        except Exception:
            return getattr(error, 'code', None), {'raw': raw[:200]}

def sha(path):
    return hashlib.sha256(pathlib.Path(path, 'SKILL.md').read_bytes()).hexdigest()

failures = []
def check(label, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + label + (f'  {detail}' if detail else ''))
    if not condition:
        failures.append(label)

status, made = call('POST', '/api/workspaces', {'path': str(ws), 'name': 'probe-workspace'})
workspace = made.get('workspace') or {}
ws_id = workspace.get('id')
check('a workspace is registered', status == 200 and bool(ws_id), str(made)[:140])

status, listing = call('GET', '/api/workspaces')
check('the workspace list names it', any(row.get('id') == ws_id for row in listing.get('workspaces') or []))

status, compared = call('GET', f'/api/workspaces/{ws_id}/compare')
check('the comparison reads the workspace skills', status == 200 and compared.get('total') == 1, str(compared)[:140])
check('a skill the library does not have is workspace-only', compared.get('workspaceOnly') == 1)
check('the row carries the hash it compared', bool((compared.get('rows') or [{}])[0].get('hash')))

source_hash = sha(ws / 'skills' / 'probe-skill')
status, promoted = call('POST', f'/api/workspaces/{ws_id}/promote', {'name': 'probe-skill'})
target = library / 'probe-skill'
check('the workspace skill becomes a library package', status == 200 and promoted.get('ok') is True, str(promoted)[:160])
check('the package lands in the library', target.exists() and (target / 'SKILL.md').exists(), str(target))
check('the promotion keeps the bytes', sha(target) == source_hash)
check('the support file comes with it', (target / 'notes.md').exists())
check('the workspace manifest is not copied into the library', not (target / '.skill-academy.json').exists())
check('the promotion is journalled', isinstance(promoted.get('ok'), bool) and bool(promoted.get('hash')))
creating = [row for row in (call('GET', '/api/journal?limit=5')[1].get('entries') or [])
            if row.get('action') == 'workspace-promote']
created_id = creating[0].get('id') if creating else None

status, after = call('GET', f'/api/workspaces/{ws_id}/compare')
check('the comparison now calls it the same skill', after.get('same') == 1 and after.get('workspaceOnly') == 0,
      str(after)[:140])
check('the promoted package is indexed straight away', promoted.get('indexed') is True, str(promoted)[:120])
check('the library skill answers a search', any(
    row.get('name') == 'probe-skill' for row in (call('GET', '/api/skills?q=probe-skill&limit=50')[1].get('rows') or [])))

status, repeat = call('POST', f'/api/workspaces/{ws_id}/promote', {'name': 'probe-skill'})
check('promoting an unchanged copy is refused', status == 409 and repeat.get('error') == 'unchanged', str(repeat)[:140])

# A workspace edit that the library does not have yet.
text = (ws / 'skills' / 'probe-skill' / 'SKILL.md').read_text(encoding='utf-8')
(ws / 'skills' / 'probe-skill' / 'SKILL.md').write_text(text.replace('- Says what it does before it says how.',
    '- Says what it does before it says how.\n- Names the version it describes.'), encoding='utf-8')
library_before = sha(target)

status, differs = call('GET', f'/api/workspaces/{ws_id}/compare')
check('an edited workspace skill reads as different', differs.get('different') == 1, str(differs)[:140])

status, clash = call('POST', f'/api/workspaces/{ws_id}/promote', {'name': 'probe-skill'})
check('a changed copy does not overwrite without replace', status == 409 and clash.get('error') == 'exists', str(clash)[:140])
check('the library package is untouched by the refusal', sha(target) == library_before)

status, replaced = call('POST', f'/api/workspaces/{ws_id}/promote', {'name': 'probe-skill', 'replace': True})
check('replace takes the workspace copy', status == 200 and replaced.get('replaced') is True, str(replaced)[:160])
check('the package is the workspace bytes now', sha(target) == sha(ws / 'skills' / 'probe-skill'))
snapshot = replaced.get('snapshot')
check('the replaced package is kept aside', bool(snapshot) and pathlib.Path(snapshot).exists(), str(snapshot))

journals = (call('GET', '/api/journal?limit=20')[1].get('entries') or [])
promotion = next((row for row in journals if row.get('action') == 'workspace-promote'), None)
check('the journal carries the promotion', promotion is not None, str([r.get('action') for r in journals])[:140])

status, undone = call('POST', f"/api/journal/{promotion.get('id')}/undo", {})
check('the promotion undoes', status == 200 and undone.get('state') == 'undone', str(undone)[:140])
check('the undo restores the bytes it replaced', sha(target) == library_before)
check('the snapshot is cleaned up after the undo', not pathlib.Path(snapshot).exists())

(ws / 'skills' / 'probe-skill' / 'SKILL.md').write_text(text, encoding='utf-8')
if created_id:
    status, undone_new = call('POST', f"/api/journal/{created_id}/undo", {})
    check('a promotion that created a package undoes by removing it', not target.exists(), str(undone_new)[:140])
else:
    check('a promotion that created a package undoes by removing it', False, 'the creating promotion is missing')

status, unknown = call('POST', f'/api/workspaces/{ws_id}/promote', {'name': 'no-such-skill'})
check('an unknown workspace skill answers 404', status == 404 and unknown.get('error') == 'not-in-workspace', str(unknown)[:140])

status, deleted = call('DELETE', f'/api/workspaces/{ws_id}', {})
check('the workspace unregisters', status == 200, str(deleted)[:140])

print('')
print('workspace checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
