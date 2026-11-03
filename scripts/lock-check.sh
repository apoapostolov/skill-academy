#!/usr/bin/env bash
# A library is reproducible from its lock alone: a second, empty index rebuilds the same package
# hashes and the same placements, and disagrees loudly when the bytes have moved.
set -u
cd "$(dirname "$0")/.."
PORT_A="${LOCK_PORT_A:-$((12200 + RANDOM % 200))}"
PORT_B="${LOCK_PORT_B:-$((PORT_A + 200))}"
DATA_A="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-lock-a.XXXXXX")"
DATA_B="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-lock-b.XXXXXX")"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-lock-root.XXXXXX")"
EMPTY="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-lock-empty.XXXXXX")"
LIB="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-lock-lib.XXXXXX")"
LOCK="$DATA_A/second-machine.lock.json"

for name in alpha beta; do
  mkdir -p "$ROOT/$name"
  printf -- '---\nname: %s\ndescription: A skill the lock has to remember.\nversion: 1.0.0\n---\n\n# %s\n\n## Rules\n\n- One rule.\n' "$name" "$name" > "$ROOT/$name/SKILL.md"
done

win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

start() {
  local port="$1" data="$2" roots="$3" log="$4"
  SKILL_ACADEMY_DATA="$(win "$data")" \
  SKILL_ACADEMY_ONLY_ROOTS="$(win "$roots")" \
  SKILL_ACADEMY_LIBRARY="$(win "$LIB")" \
  SKILL_ACADEMY_WATCH=0 \
  SKILL_ACADEMY_SCHEDULE=0 \
  SKILL_ACADEMY_API_PORT="$port" \
  npx tsx server/src/index.ts > "$log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 90); do
    if curl -s "http://127.0.0.1:$port/api/skills?limit=1" 2>/dev/null | grep -q '"total"'; then return 0; fi
    sleep 1
  done
  echo "the lock server did not start on $port; log:"; tail -20 "$log"; return 1
}

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

start "$PORT_A" "$DATA_A" "$ROOT" "$DATA_A/server.log" || exit 1
python3 - "$PORT_A" "$(win "$LOCK")" "$(win "$ROOT")" <<'PY'
import json, sys, urllib.request as u

port, lock, root = sys.argv[1], sys.argv[2], sys.argv[3]
A = f'http://127.0.0.1:{port}'
failures = []

def call(method, path, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = u.Request(A + path, data=body, method=method, headers={'content-type': 'application/json'})
    try:
        with u.urlopen(request, timeout=60) as response:
            return response.status, json.load(response)
    except u.HTTPError as error:
        return error.code, json.loads(error.read().decode() or '{}')

def check(label, condition, detail=''):
    print(('PASS  ' if condition else 'FAIL  ') + label + (f'  {detail}' if detail else ''))
    if not condition:
        failures.append(label)

status, written = call('POST', '/api/lock/write', {'path': lock})
check('the lock is written', status == 200 and written.get('skills') == 2, str(written)[:120])
document = json.load(open(lock, encoding='utf-8'))
check('the lock records package hashes', all(row.get('hash') for row in document['skills']),
      str([row.get('hash') for row in document['skills']])[:80])
check('the lock records placements',
      any(row.get('placements') for row in document['skills']),
      str(document['skills'][0].get('placements'))[:120])
status, checked = call('POST', '/api/lock/check', {'path': lock})
check('a fresh lock agrees with the library', checked.get('ok') is True, str(checked)[:120])
sys.exit(1 if failures else 0)
PY
A_RESULT=$?
kill "$SERVER_PID" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
if [ "$A_RESULT" -ne 0 ]; then echo "the first machine failed the lock checks"; exit 1; fi

# The second machine: an empty index, a root with nothing in it, and only the lock to go on.
start "$PORT_B" "$DATA_B" "$EMPTY" "$DATA_B/server.log" || exit 1
python3 - "$PORT_B" "$(win "$LOCK")" "$(win "$ROOT")" "$(win "$DATA_B")" <<'PY'
import json, os, sqlite3, sys, urllib.request as u

port, lock, root, data = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
A = f'http://127.0.0.1:{port}'
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

document = json.load(open(lock, encoding='utf-8'))
expected = {row['name']: row['hash'] for row in document['skills']}

status, empty = call('GET', '/api/skills?limit=10')
check('the second machine starts empty', empty.get('total') == 0, str(empty.get('total')))

status, restored = call('POST', '/api/lock/restore', {'path': lock, 'apply': True})
check('the lock rebuilds the library', status == 200 and len(restored.get('matched', [])) == 2, str(restored)[:200])
check('every locked package is verified against its hash',
      restored.get('diverged') == [] and restored.get('missing') == [], str(restored)[:200])
check('the placements come back with it', restored.get('placementsWritten') == 2, str(restored.get('placementsWritten')))

status, listing = call('GET', '/api/skills?limit=10')
rows = {row['name']: row for row in listing.get('rows', [])}
check('the second machine serves both skills', set(rows) == set(expected), str(sorted(rows)))
check('the hashes are the ones the lock names',
      all(rows[name]['package_hash'] == expected[name] for name in expected if name in rows),
      str({name: rows.get(name, {}).get('package_hash') for name in expected})[:160])

# The placements table is the record; the placements route reports against the roots this machine
# knows about, and this machine deliberately knows none.
db = sqlite3.connect(os.path.join(data, 'index.db'))
written = db.execute('SELECT s.name, p.root_path, p.mode FROM placements p JOIN skills s ON s.id = p.skill_id').fetchall()
db.close()
check('both skills are placed where the lock said',
      len(written) == 2 and all(row[1].lower() == root.lower() for row in written), str(written)[:180])
check('the placement mode survives the rebuild', all(row[2] == 'native' for row in written), str(written)[:120])

# A package whose bytes moved is reported, not silently accepted.
victim = os.path.join(root, 'alpha', 'SKILL.md')
with open(victim, 'a', encoding='utf-8') as handle:
    handle.write('\n- A line added after the lock was written.\n')
status, diverged = call('POST', '/api/lock/restore', {'path': lock, 'apply': True})
check('changed bytes are reported as divergence',
      status == 409 and any(row['name'] == 'alpha' for row in diverged.get('diverged', [])), str(diverged)[:200])

# A package that is not there is reported as missing, not assumed to be installed.
os.remove(os.path.join(root, 'beta', 'SKILL.md'))
status, missing = call('POST', '/api/lock/restore', {'path': lock, 'apply': True})
check('a package that is not there is reported missing',
      status == 409 and any('beta' in entry for entry in missing.get('missing', [])), str(missing.get('missing'))[:120])

print('')
print('lock checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
