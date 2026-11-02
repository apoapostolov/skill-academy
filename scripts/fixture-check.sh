#!/usr/bin/env bash
# Exercise consolidation and curation against fixtures only, never the live skill roots.
#
# The run boots a second server with its own database and a root list of one: fixtures/agent-root.
# Anything the merge writes lands there, so a defect costs a fixture and not a working skill.
set -u
cd "$(dirname "$0")/.."
# A free port per run: a leftover server on a fixed port silently answers for the fixture one.
PORT="${FIXTURE_PORT:-$((10100 + RANDOM % 400))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-fixtures.XXXXXX")"
# A native Windows path: Node resolves `/c/...` to `C:\c\...`, which is not the same directory.
FIXTURE_ROOT="$(cd fixtures/agent-root && pwd -W 2>/dev/null || pwd)"
LOG="$DATA/server.log"

SKILL_ACADEMY_DATA="$DATA" \
SKILL_ACADEMY_ONLY_ROOTS="$FIXTURE_ROOT" \
SKILL_ACADEMY_WATCH=0 \
SKILL_ACADEMY_API_PORT="$PORT" \
npx tsx server/src/index.ts > "$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  pkill -f "SKILL_ACADEMY_API_PORT=$PORT" >/dev/null 2>&1 || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/api/skills?limit=1" 2>/dev/null | grep -q '"total"'; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "the fixture server did not start on $PORT; log:"; tail -20 "$LOG"; exit 1
fi

python3 - "$PORT" "$FIXTURE_ROOT" <<'PY'
import hashlib, json, pathlib, sys, urllib.request as u

port, root = sys.argv[1], pathlib.Path(sys.argv[2])
A = f'http://127.0.0.1:{port}'

def get(path):
    return json.loads(u.urlopen(A + path, timeout=120).read().decode())

def post(path, payload, timeout=240):
    request = u.Request(A + path, data=json.dumps(payload).encode(),
                        headers={'content-type': 'application/json'}, method='POST')
    try:
        return 200, json.loads(u.urlopen(request, timeout=timeout).read().decode())
    except Exception as error:
        body = error.read().decode() if hasattr(error, 'read') else '{}'
        return getattr(error, 'code', None), json.loads(body or '{}')

failures = []
def check(label, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + label + (f'  {detail}' if detail else ''))
    if not condition:
        failures.append(label)

library = get('/api/skills?limit=200')
check('fixture root is the only root', library['total'] == 5, f"total {library['total']}")

improve = post('/api/improve/dry-run', {})[1]
rules = {}
for finding in improve.get('findings', []):
    rules.setdefault(finding['rule'], []).append(finding['skill'])
check('improve finds the stub body', 'stub-body' in rules and 'stub-skill' in rules['stub-body'], str(rules.get('stub-body')))
check('improve flags the long description', 'long-description' in rules.get('description-over-budget', []))
check('improve flags the missing period', 'no-period' in rules.get('description-no-period', []))
check('improve reports no family problems on a clean fixture', not any(
    rule in rules for rule in ('category-mismatch', 'unexpected-unfiled', 'multi-family')), str(sorted(rules)))

consolidate = post('/api/consolidate/dry-run', {})[1]
group = next((g for g in consolidate['groups'] if 'merge-alpha' in g['key']), None)
check('the two copies form one group', group is not None)
if group:
    check('the group carries a plan', group['plan'] is not None, group['mergeType'])
    check('the plan points the smaller copy at the survivor',
          [p['name'] for p in group['plan']['pointerize']] == ['merge-beta'] if group['plan'] else False)

# A fold on the fixture pair, then the archive check, then a restore.
alpha = root / 'merge-alpha' / 'SKILL.md'
beta = root / 'merge-beta' / 'SKILL.md'
before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (alpha, beta)}
status, proposal = post('/api/consolidate/fold', {'key': group['key'] if group else '', 'provider': 'opencode-go',
                                                  'model': 'deepseek-v4.1-flash'})
check('fold answers', status == 200 and not proposal.get('error'), str(proposal.get('error') or proposal.get('status')))
check('fold audit keeps every line', proposal.get('status') == 'clean',
      f"{proposal.get('keptRules')}/{proposal.get('totalRules')}")

if proposal.get('status') == 'clean':
    status, applied = post('/api/consolidate/fold/apply', {'key': group['key'], 'read': True, 'confirm': True,
                                                           'provider': 'opencode-go', 'model': 'deepseek-v4.1-flash'})
    check('apply answers', status == 200 and applied.get('applied'), str(applied.get('error')))
    archive = applied.get('archive')
    if archive:
        check('the replaced body is archived exactly',
              hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest() == before[alpha])
    pointers = applied.get('pointers') or []
    check('the other copy became a pointer', bool(pointers) or bool(applied.get('removed')))
    if pointers:
        text = pathlib.Path(pointers[0]['path']).read_text(encoding='utf-8')
        check('the pointer names the survivor', 'Merged into' in text and 'merge-alpha' in text)
        status, undo = post('/api/consolidate/undo', {'archivePath': archive, 'originalPath': str(alpha)})
        restored = hashlib.sha256(alpha.read_bytes()).hexdigest()
        check('the archive restores byte for byte', undo.get('restored') and restored == before[alpha])
        post('/api/consolidate/undo', {'archivePath': pointers[0]['archive'], 'originalPath': pointers[0]['path']})
        check('the second copy restores too',
              hashlib.sha256(beta.read_bytes()).hexdigest() == before[beta])

print('')
print('fixture checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
