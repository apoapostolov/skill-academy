#!/usr/bin/env bash
# Prove a local checkout works as a source: the commit and tag come from git, the plan hashes files
# from disk, applying stages them, and a replace puts the package in the library and indexes it.
set -u
cd "$(dirname "$0")/.."
PORT="${SOURCES_PORT:-$((11800 + RANDOM % 400))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-sources.XXXXXX")"
ROOT="$DATA/agent-root"
LIB="$DATA/library"
REPO="$DATA/upstream"
mkdir -p "$ROOT" "$LIB" "$REPO/skills/from-checkout"
GIT="git -c user.email=check@example.com -c user.name=Check"
( cd "$REPO" && git init -q . && mkdir -p skills/from-checkout && \
  printf -- '---\nname: from-checkout\ndescription: A skill that arrives from a local checkout.\nversion: 1.0.0\n---\n\n# From checkout\n\n## Rules\n\n- One rule.\n' > skills/from-checkout/SKILL.md && \
  printf 'support\n' > skills/from-checkout/notes.md && \
  $GIT add -A && $GIT commit -qm "first" && $GIT tag v1.0.0 )

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
  echo "the sources server did not start on $PORT; log:"; tail -30 "$LOG"; exit 1
fi

python3 - "$PORT" "$(win "$REPO")" "$(win "$LIB")" "$(win "$DATA")" <<'PY'
import json, pathlib, subprocess, sys, urllib.request as u

port, repo, library, data = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
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

failures = []
def check(label, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + label + (f'  {detail}' if detail else ''))
    if not condition:
        failures.append(label)

def git(*args):
    return subprocess.run(['git', '-C', str(repo), '-c', 'user.email=c@e.com', '-c', 'user.name=C', *args],
                          capture_output=True, text=True).stdout.strip()

head = git('rev-parse', 'HEAD')[:12]

status, made = call('POST', '/api/sources', {'path': str(repo)})
source = made.get('source') or {}
sid = source.get('id')
check('a checkout registers as a local source', status == 200 and source.get('kind') == 'local', str(made)[:150])
check('the source remembers its path', str(source.get('repo', '')).replace('\\\\', '\\') == str(repo))
check('the branch is reported', made.get('branch') in ('master', 'main'), str(made.get('branch')))

status, listing = call('GET', '/api/sources')
check('the source list carries the kind', any(row.get('kind') == 'local' for row in listing.get('sources') or []))

status, found = call('POST', f'/api/sources/{sid}/check', {})
check('checking reads the commit from git', status == 200 and found.get('commit') == head, str(found)[:150])
check('checking reads the tag as the release', found.get('release') == 'v1.0.0', str(found.get('release')))
check('the first check reports no change', found.get('changed') is False)

status, mapped = call('POST', f'/api/sources/{sid}/skills', {'skills': ['skills/from-checkout']})
check('skills can be mapped onto the source', status == 200 and mapped.get('skills') == ['skills/from-checkout'])

status, plan = call('POST', f'/api/sources/{sid}/plan-update', {})
files = plan.get('files') or []
check('the plan reads the mapped folder from disk', status == 200 and files and files[0].get('status') == 200, str(plan)[:180])
check('the plan counts the files inside the folder', (files[0].get('bytes') or 0) == 2, str(files[:1])[:120])
check('the plan writes nothing yet', not (library / 'from-checkout').exists())

status, applied = call('POST', f'/api/sources/{sid}/apply-update', {'planId': plan.get('planId'), 'confirm': True})
check('applying stages the files', status == 200 and len(applied.get('staged') or []) == 2, str(applied)[:160])
check('staging alone does not touch the library', not (library / 'from-checkout').exists())

status, plan2 = call('POST', f'/api/sources/{sid}/plan-update', {})
status, replaced = call('POST', f'/api/sources/{sid}/apply-update',
                        {'planId': plan2.get('planId'), 'confirm': True, 'replace': True})
check('replace writes the package into the library', status == 200 and (library / 'from-checkout' / 'SKILL.md').exists(),
      str(replaced)[:160])
check('the support file comes with it', (library / 'from-checkout' / 'notes.md').exists())
check('the replaced package is indexed', any(
    row.get('name') == 'from-checkout' for row in (call('GET', '/api/skills?q=from-checkout&limit=20')[1].get('rows') or [])))
check('the replacement is journalled', any(
    row.get('action') == 'source-replace' for row in (call('GET', '/api/journal?limit=20')[1].get('entries') or [])))

# A new commit upstream is what the source exists to notice.
text = (repo / 'skills' / 'from-checkout' / 'SKILL.md').read_text(encoding='utf-8')
(repo / 'skills' / 'from-checkout' / 'SKILL.md').write_text(
    text.replace('- One rule.', '- One rule.\n- A second rule, after a commit.'), encoding='utf-8')
git('add', '-A')
git('commit', '-qm', 'second')
new_head = git('rev-parse', 'HEAD')[:12]

# The plan checks the source itself and records that check, so it must be the first thing asked
# after the commit; asking `check` first would consume the delta the plan reports.
status, plan3 = call('POST', f'/api/sources/{sid}/plan-update', {})
check('the plan names the commit change', any(change.get('kind') == 'commit' for change in plan3.get('changes') or []),
      str(plan3.get('changes'))[:140])
check('the plan names the commit it came from', plan3.get('to', {}).get('commit') == new_head, str(plan3.get('to')))
check('the plan names the commit it replaced', plan3.get('from', {}).get('commit') == head, str(plan3.get('from')))

status, events = call('GET', '/api/sources/events')
check('the change becomes an event', any(event.get('kind') == 'commit' for event in events.get('events') or []),
      str(events)[:140])

status, after = call('POST', f'/api/sources/{sid}/check', {})
check('a check after the plan reports no further change', after.get('changed') is False and after.get('commit') == new_head,
      str(after)[:150])

status, refused = call('POST', '/api/sources', {'path': str(data / 'not-a-repo')})
check('a folder that is not a checkout is refused', status == 400 and refused.get('error') in ('that path does not exist', 'not-a-checkout'), str(refused)[:140])

(data / 'plain').mkdir()
status, refused2 = call('POST', '/api/sources', {'path': str(data / 'plain')})
check('a folder without .git is refused by name', status == 400 and refused2.get('error') == 'not-a-checkout', str(refused2)[:140])

status, deleted = call('DELETE', f'/api/sources/{sid}', {})
check('the source unregisters', status == 200, str(deleted)[:120])

print('')
print('sources checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
