#!/usr/bin/env bash
# One real repository, read the way a user would: check it, plan an update, check it again.
# This is the live-network probe behind the claim that commit and release are separate signals; it
# is not part of the suite because it needs GitHub and can be rate limited.
set -u
cd "$(dirname "$0")/.."
PORT="${LIVE_PORT:-$((12500 + RANDOM % 200))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-live.XXXXXX")"
ROOT="$DATA/root"
mkdir -p "$ROOT"
win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

SKILL_ACADEMY_DATA="$(win "$DATA")" \
SKILL_ACADEMY_ONLY_ROOTS="$(win "$ROOT")" \
SKILL_ACADEMY_WATCH=0 \
SKILL_ACADEMY_SCHEDULE=0 \
SKILL_ACADEMY_API_PORT="$PORT" \
npx tsx server/src/index.ts > "$DATA/server.log" 2>&1 &
PID=$!
trap 'kill $PID >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 90); do
  curl -s "http://127.0.0.1:$PORT/api/skills?limit=1" 2>/dev/null | grep -q '"total"' && break
  sleep 1
done

python3 - "$PORT" <<'PY'
import json, sys, urllib.request as u

A = f'http://127.0.0.1:{sys.argv[1]}'
failures = []

def call(method, path, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = u.Request(A + path, data=body, method=method, headers={'content-type': 'application/json'})
    try:
        with u.urlopen(request, timeout=120) as response:
            return response.status, json.load(response)
    except u.HTTPError as error:
        return error.code, json.loads(error.read().decode() or '{}')

def check(label, condition, detail=''):
    print(('PASS  ' if condition else 'FAIL  ') + label + (f'  {detail}' if detail else ''))
    if not condition:
        failures.append(label)

status, added = call('POST', '/api/sources', {'kind': 'github', 'repo': 'mattpocock/skills'})
sid = added.get('source', {}).get('id')
check('the real repository registers', status == 200 and sid is not None, str(added)[:140])

status, first = call('POST', f'/api/sources/{sid}/check', {})
check('the first check records a commit', status == 200 and len(str(first.get('commit'))) == 12, str(first)[:160])
check('and the release it found, separately', 'release' in first, f"release={first.get('release')}")

status, second = call('POST', f'/api/sources/{sid}/check', {})
check('a second check sees no change', second.get('changed') is False, str(second)[:140])

status, plan = call('POST', f'/api/sources/{sid}/plan-update', {})
check('a plan names what it is comparing', status == 200 and 'from' in plan and 'to' in plan, str(plan.get('to'))[:120])
check('the plan reports no change right after a check', plan.get('changes') == [], str(plan.get('changes'))[:120])

print('')
print('live checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
