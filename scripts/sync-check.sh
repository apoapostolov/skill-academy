#!/usr/bin/env bash
# Two machines, one private repository. The second converges on the first's packages, a conflicting
# edit surfaces without losing either side, and a key-shaped string stops the push before it exists.
set -u
cd "$(dirname "$0")/.."
PORT_A="${SYNC_PORT_A:-$((12800 + RANDOM % 150))}"
PORT_B="${SYNC_PORT_B:-$((PORT_A + 150))}"
PORT_C="${SYNC_PORT_C:-$((PORT_A + 300))}"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-sync.XXXXXX")"
REMOTE="$BASE/remote.git"
DATA_A="$BASE/machine-a"
DATA_B="$BASE/machine-b"
DATA_C="$BASE/machine-c"
LIB_A="$BASE/lib-a"
LIB_B="$BASE/lib-b"
LIB_C="$BASE/lib-c"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-sync-root.XXXXXX")"
mkdir -p "$DATA_A" "$DATA_B" "$DATA_C" "$LIB_A" "$LIB_B" "$LIB_C" "$ROOT"

# git is a native binary here: it does not translate MSYS paths, so the bare repository is created
# from a Windows path or it lands somewhere nobody looks.
win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
git init -q --bare "$(win "$REMOTE")"

# A package that already exists in machine A's library, as if it had been installed there.
mkdir -p "$LIB_A/alpha-skill"
printf -- '---\nname: alpha-skill\ndescription: A skill that has to survive a round trip.\nversion: 1.0.0\n---\n\n# Alpha\n\n## Rules\n\n- Shared rule.\n' > "$LIB_A/alpha-skill/SKILL.md"

PIDS=""
start() {
  local port="$1" data="$2" lib="$3" log="$4"
  SKILL_ACADEMY_DATA="$(win "$data")" \
  SKILL_ACADEMY_ONLY_ROOTS="$(win "$ROOT")" \
  SKILL_ACADEMY_LIBRARY="$(win "$lib")" \
  SKILL_ACADEMY_WATCH=0 \
  SKILL_ACADEMY_SCHEDULE=0 \
  SKILL_ACADEMY_API_PORT="$port" \
  npx tsx server/src/index.ts > "$log" 2>&1 &
  PIDS="$PIDS $!"
  for _ in $(seq 1 90); do
    curl -s "http://127.0.0.1:$port/api/skills?limit=1" 2>/dev/null | grep -q '"total"' && return 0
    sleep 1
  done
  echo "a sync server did not start on $port; log:"; tail -20 "$log"; return 1
}
cleanup() { for pid in $PIDS; do kill "$pid" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

start "$PORT_A" "$DATA_A" "$LIB_A" "$DATA_A/server.log" || exit 1
start "$PORT_B" "$DATA_B" "$LIB_B" "$DATA_B/server.log" || exit 1
start "$PORT_C" "$DATA_C" "$LIB_C" "$DATA_C/server.log" || exit 1

python3 - "$PORT_A" "$PORT_B" "$(win "$REMOTE")" "$(win "$LIB_A")" "$(win "$LIB_B")" "$PORT_C" "$(win "$LIB_C")" <<'PY'
import hashlib, json, os, pathlib, sys, urllib.request as u

port_a, port_b, remote = sys.argv[1], sys.argv[2], sys.argv[3]
lib_a, lib_b, lib_c = pathlib.Path(sys.argv[4]), pathlib.Path(sys.argv[5]), pathlib.Path(sys.argv[7])
port_c = sys.argv[6]
failures = []

def call(port, method, path, payload=None, timeout=180):
    body = None if payload is None else json.dumps(payload).encode()
    request = u.Request(f'http://127.0.0.1:{port}' + path, data=body, method=method,
                        headers={'content-type': 'application/json'})
    try:
        with u.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except u.HTTPError as error:
        return error.code, json.loads(error.read().decode() or '{}')

def check(label, condition, detail=''):
    print(('PASS  ' if condition else 'FAIL  ') + label + (f'  {detail}' if detail else ''))
    if not condition:
        failures.append(label)

def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()[:16]

# 1. a machine pushes what it owns.
status, configured = call(port_a, 'POST', '/api/sync/config', {'repo': remote, 'branch': 'main'})
check('a machine takes a repository', status == 200 and configured.get('config', {}).get('repo') == remote, str(configured)[:120])

status, pushed = call(port_a, 'POST', '/api/sync/push', {})
check('the first push lands', status == 200 and pushed.get('pushed') is True, str(pushed)[:160])
check('the push says how much it carried', (pushed.get('files') or 0) >= 1, str(pushed.get('files')))

status, again = call(port_a, 'POST', '/api/sync/push', {})
check('a second push with nothing new pushes nothing', again.get('pushed') is False, str(again)[:140])

# 2. the other machine converges on it.
status, joined = call(port_b, 'POST', '/api/sync/config', {'repo': remote, 'branch': 'main'})
status, pulled = call(port_b, 'POST', '/api/sync/pull', {})
check('the second machine pulls', status == 200 and (pulled.get('restored') or 0) >= 1, str(pulled)[:160])
arrived = lib_b / 'alpha-skill' / 'SKILL.md'
check('the package arrives', arrived.exists(), str(arrived))
check('and it arrives byte for byte',
      arrived.exists() and digest(arrived) == digest(lib_a / 'alpha-skill' / 'SKILL.md'),
      f"{digest(arrived) if arrived.exists() else 'missing'} vs {digest(lib_a / 'alpha-skill' / 'SKILL.md')}")

status, quiet = call(port_b, 'POST', '/api/sync/pull', {})
check('a second pull finds nothing to do', quiet.get('restored') == 0, str(quiet)[:140])

# 3. the same file changed on both sides: one conflict, nothing lost.
blocked = lib_a / 'alpha-skill' / 'SKILL.md'
blocked.write_text(blocked.read_text(encoding='utf-8') + '\n- A rule added on machine A.\n', encoding='utf-8')
status, pushed_a = call(port_a, 'POST', '/api/sync/push', {})
check('machine A publishes its edit', pushed_a.get('pushed') is True, str(pushed_a)[:140])

local_b = lib_b / 'alpha-skill' / 'SKILL.md'
local_b.write_text(local_b.read_text(encoding='utf-8') + '\n- A rule added on machine B.\n', encoding='utf-8')
status, conflicted = call(port_b, 'POST', '/api/sync/pull', {})
conflicts = conflicted.get('conflicts') or []
check('the clash is reported as one conflict', len(conflicts) == 1, str(conflicts)[:160])
kept = conflicts[0].get('keptLocalPath') if conflicts else ''
check('the local copy is kept beside it', bool(kept) and (pathlib.Path(kept).exists()), str(kept))
check('the shared version is what the file holds now', 'machine A' in local_b.read_text(encoding='utf-8'))
check('and the local rule is still readable', bool(kept) and 'machine B' in pathlib.Path(kept).read_text(encoding='utf-8'))

# 4. a key-shaped string stops the push before the commit exists.
leak = lib_a / 'alpha-skill' / 'notes.md'
leak.write_text('token: ' + 'sk-' + 'a' * 32 + '\n', encoding='utf-8')
status, refused = call(port_a, 'POST', '/api/sync/push', {})
findings = refused.get('findings') or []
check('a key-shaped string refuses the push', status == 409 and refused.get('error') == 'secrets-found', str(refused)[:160])
check('the finding names the file and the line',
      bool(findings) and findings[0].get('file', '').endswith('notes.md') and findings[0].get('line') == 1,
      str(findings)[:160])
status, after = call(port_a, 'POST', '/api/sync/push', {})
check('and nothing was committed by the refused attempt', after.get('error') == 'secrets-found', str(after)[:120])

leak.unlink()

# 5. a machine with nothing, not even an index, comes back whole from the shared repository.
status, joined_c = call(port_c, 'POST', '/api/sync/config', {'repo': remote, 'branch': 'main'})
status, pulled_c = call(port_c, 'POST', '/api/sync/pull', {})
check('a fresh machine pulls the shared tree', status == 200 and (pulled_c.get('restored') or 0) >= 1, str(pulled_c)[:160])
check('the package lands in its library', (lib_c / 'alpha-skill' / 'SKILL.md').exists(), str(lib_c))
status, listing_c = call(port_c, 'GET', '/api/skills?limit=20')
names_c = {row.get('name') for row in listing_c.get('rows', [])}
check('and the lock puts the skill back in its index', 'alpha-skill' in names_c, str(sorted(names_c))[:140])

# 6. status answers where this machine stands.
status, state = call(port_a, 'GET', '/api/sync')
check('status names the branch and the commit', status == 200 and state.get('initialized') is True and bool(state.get('commit')), str(state)[:160])

print('')
print('sync checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
