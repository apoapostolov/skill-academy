#!/usr/bin/env bash
# P7 against a real private repository on GitHub, not a bare directory.
#
# Deliberately NOT part of the suite: it needs the network and a credential helper that can push.
# Run it by hand when the sync path changes, or when a credential is new:
#
#   bash scripts/live-sync-check.sh
#   SKILL_ACADEMY_SYNC_REPO=https://github.com/you/your-private.git bash scripts/live-sync-check.sh
#
# It writes to one branch per run (`probe-<stamp>`) so nothing it does can disturb a real branch.
set -u
cd "$(dirname "$0")/.."
REPO="${SKILL_ACADEMY_SYNC_REPO:-https://github.com/apoapostolov/skill-academy-sync-probe}"
BRANCH="probe-$(date +%Y%m%d-%H%M%S)"
PORT_A="${LIVE_SYNC_PORT_A:-$((13000 + RANDOM % 200))}"
PORT_B="${LIVE_SYNC_PORT_B:-$((PORT_A + 200))}"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-live-sync.XXXXXX")"
DATA_A="$BASE/machine-a"
DATA_B="$BASE/machine-b"
LIB_A="$BASE/lib-a"
LIB_B="$BASE/lib-b"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-live-root.XXXXXX")"
mkdir -p "$DATA_A" "$DATA_B" "$LIB_A" "$LIB_B" "$ROOT"

win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

mkdir -p "$LIB_A/alpha-skill"
printf -- '---\nname: alpha-skill\ndescription: A skill that has to survive a real round trip.\nversion: 1.0.0\n---\n\n# Alpha\n\n## Rules\n\n- Shared rule.\n' > "$LIB_A/alpha-skill/SKILL.md"

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
  echo "a server did not start on $port; log:"; tail -25 "$log"; return 1
}
cleanup() { for pid in $PIDS; do kill "$pid" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

echo "repository: $REPO"
echo "branch:     $BRANCH"
if ! GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO" >/dev/null 2>&1; then
  echo "cannot reach $REPO with the configured credential helper; nothing was tested"
  exit 2
fi

start "$PORT_A" "$DATA_A" "$LIB_A" "$DATA_A/server.log" || exit 1
start "$PORT_B" "$DATA_B" "$LIB_B" "$DATA_B/server.log" || exit 1

python3 - "$PORT_A" "$PORT_B" "$REPO" "$BRANCH" "$(win "$LIB_A")" "$(win "$LIB_B")" <<'PY'
import json, os, pathlib, subprocess, sys, urllib.request as u

port_a, port_b, repo, branch = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lib_a, lib_b = pathlib.Path(sys.argv[5]), pathlib.Path(sys.argv[6])
failures = []


def call(port, method, path, payload=None, timeout=180):
    body = None if payload is None else json.dumps(payload).encode()
    request = u.Request(f'http://127.0.0.1:{port}' + path, data=body, method=method,
                        headers={'content-type': 'application/json'})
    try:
        with u.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except u.HTTPError as error:
        raw = error.read().decode() or '{}'
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {'raw': raw[:200]}


def check(label, condition, detail=''):
    print(('PASS  ' if condition else 'FAIL  ') + label + ('  ' + str(detail) if detail else ''))
    if not condition:
        failures.append(label)


def remote_head():
    result = subprocess.run(['git', 'ls-remote', repo, f'refs/heads/{branch}'],
                            capture_output=True, text=True, timeout=120,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    line = result.stdout.strip().split('\n')[0] if result.stdout.strip() else ''
    return line.split('\t')[0] if line else ''


check('the repository is reachable with the configured credential', True, repo)

# 1. machine A publishes its library to real GitHub.
status, saved = call(port_a, 'POST', '/api/sync/config', {'repo': repo, 'branch': branch})
check('machine A takes a GitHub repository as its sync target', status == 200, str(saved)[:120])
status, pushed = call(port_a, 'POST', '/api/sync/push', {})
check('the push reaches GitHub', status == 200 and pushed.get('pushed') is True, str(pushed)[:200])
a_head = remote_head()
check('GitHub holds the branch the app named', len(a_head) == 40, a_head)

# 2. machine B, empty, comes back whole from GitHub.
status, joined = call(port_b, 'POST', '/api/sync/config', {'repo': repo, 'branch': branch})
status, pulled = call(port_b, 'POST', '/api/sync/pull', {})
check('a second machine pulls from GitHub', status == 200 and (pulled.get('restored') or 0) >= 1, str(pulled)[:200])
check('the package lands on the second machine', (lib_b / 'alpha-skill' / 'SKILL.md').exists(), str(lib_b))
check('the bytes are identical across the two machines',
      (lib_a / 'alpha-skill' / 'SKILL.md').read_bytes() == (lib_b / 'alpha-skill' / 'SKILL.md').read_bytes())
status, listing = call(port_b, 'GET', '/api/skills?limit=20')
names = {row.get('name') for row in listing.get('rows', [])}
check('the lock puts the skill back in the second machine index', 'alpha-skill' in names, str(sorted(names))[:120])

# 3. both machines edit the same file: one conflict, both sides readable.
b_file = lib_b / 'alpha-skill' / 'SKILL.md'
b_file.write_text(b_file.read_text(encoding='utf-8') + '- A rule from machine B.\n', encoding='utf-8')
a_file = lib_a / 'alpha-skill' / 'SKILL.md'
a_file.write_text(a_file.read_text(encoding='utf-8') + '- A rule from machine A.\n', encoding='utf-8')
status, pushed_a = call(port_a, 'POST', '/api/sync/push', {})
check('machine A pushes its edit', status == 200 and pushed_a.get('pushed') is True, str(pushed_a)[:160])
status, pulled_b = call(port_b, 'POST', '/api/sync/pull', {})
conflicts = pulled_b.get('conflicts') or []
check('the conflicting edit surfaces as one conflict', len(conflicts) == 1, str(conflicts)[:200])
kept = pathlib.Path(conflicts[0]['keptLocalPath']) if conflicts else None
check('the local copy is kept beside the file', bool(kept and kept.exists()), str(kept))
check('the kept copy is machine B text', bool(kept and 'machine B' in kept.read_text(encoding='utf-8')))
check('the shared file now carries machine A text', 'machine A' in b_file.read_text(encoding='utf-8'),
      b_file.read_text(encoding='utf-8').splitlines()[-1][:40])

# 4. a key-shaped string stops the push before anything reaches GitHub.
before = remote_head()
(lib_a / 'alpha-skill' / 'leak.md').write_text('key = "sk-' + 'A' * 32 + '"\n', encoding='utf-8')
status, refused = call(port_a, 'POST', '/api/sync/push', {})
findings = refused.get('findings') or []
check('a key-shaped string is refused before GitHub sees it', status == 409 and refused.get('error') == 'secrets-found',
      str(refused)[:200])
check('the refusal names the file and the line', bool(findings) and findings[0].get('file', '').endswith('leak.md')
      and findings[0].get('line') == 1, str(findings)[:160])
check('the refusal left GitHub untouched', remote_head() == before, f"{before[:12]} -> {remote_head()[:12]}")

print('')
print('live sync checks:', 'all passed' if not failures else f"{len(failures)} failed: {failures}")
sys.exit(0 if not failures else 1)
PY
