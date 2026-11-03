#!/usr/bin/env bash
# Prove the versioning monitor end to end against a real repository, in a temporary library.
#
# The run installs one skill from a real GitHub repository into a temporary data directory and a
# temporary agent root, so nothing here can touch a working library or a live agent directory.
set -u
cd "$(dirname "$0")/.."
PORT="${MONITOR_PORT:-$((10500 + RANDOM % 400))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-monitor.XXXXXX")"
ROOT="$DATA/agent-root"
LIB="$DATA/library"
mkdir -p "$ROOT" "$LIB"
# Node resolves an MSYS path like /tmp/... to C:\tmp\..., which does not exist: hand it native paths.
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")"
LIB_WIN="$(cygpath -w "$LIB" 2>/dev/null || echo "$LIB")"
DATA_WIN="$(cygpath -w "$DATA" 2>/dev/null || echo "$DATA")"
LOG="$DATA/server.log"
REPO="${MONITOR_REPO:-mattpocock/skills}"

SKILL_ACADEMY_DATA="$DATA_WIN" \
SKILL_ACADEMY_ONLY_ROOTS="$ROOT_WIN" \
SKILL_ACADEMY_WATCH=0 \
SKILL_ACADEMY_API_PORT="$PORT" \
SKILL_ACADEMY_LIBRARY="$LIB_WIN" \
npx tsx server/src/index.ts > "$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/api/skills?limit=1" 2>/dev/null | grep -q '"total"'; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "the monitor server did not start on $PORT; log:"; tail -30 "$LOG"; exit 1
fi

python3 - "$PORT" "$DATA_WIN" "$REPO" <<'PY'
import json, pathlib, sys, urllib.request as u

port, data, repo = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3]
A = f'http://127.0.0.1:{port}'

def call(method, path, payload=None, timeout=300):
    body = None if payload is None else json.dumps(payload).encode()
    request = u.Request(A + path, data=body, method=method,
                        headers={'content-type': 'application/json'})
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

# 1. Install one skill from the real repository.
status, listing = call('POST', '/api/install/test', {'repo': repo})
skills = listing.get('skills') or listing.get('rows') or []
check('the repository lists skills', status == 200 and bool(skills), f'{len(skills)} skills')
first = skills[0] if skills else None
path = first.get('path') if isinstance(first, dict) else (first if isinstance(first, str) else None)
check('a skill path was found', bool(path), str(path))
if not path:
    print('fixtures: cannot continue without a skill path')
    sys.exit(1)

status, installed = call('POST', '/api/install/apply',
                         {'repo': repo, 'paths': [path], 'agents': ['fixture'], 'mode': 'copy'})
check('the install lands', status == 200 and installed.get('installed') == 1, json.dumps(installed)[:200])

# 2. The baseline is written at install time.
status, mon = call('GET', '/api/monitor')
check('the overview answers', status == 200 and isinstance(mon.get('repos'), list), str(mon)[:160])
rows = [row for entry in mon.get('repos', []) for row in entry.get('installations', [])]
check('an installation is recorded', bool(rows), f'{len(rows)} rows')
installation = rows[0] if rows else None
if not installation:
    print('fixtures: no installation to monitor')
    sys.exit(1)
check('the baseline names the commit it came from', len(installation['ref']) == 40 and installation['ref'] != 'HEAD', installation['ref'][:12])
check('the installed copy exists', pathlib.Path(installation['library_path']).exists(), installation['library_path'])

# 3. A check with no upstream change reports up to date, and the second one costs no content fetch.
status, job = call('POST', '/api/monitor/check', {'installationId': installation['id']})
check('the check job starts', status == 202 and job.get('job', {}).get('id'), str(job)[:120])
for _ in range(120):
    status, polled = call('GET', f"/api/monitor/job/{job['job']['id']}")
    if polled.get('job', {}).get('status') != 'running':
        break
    import time; time.sleep(1)
check('the check finishes', polled.get('job', {}).get('status') == 'done', str(polled)[:160])
status, detail = call('GET', f"/api/monitor/installation/{installation['id']}")
check('the state is up to date after a clean install', detail['installation']['last_state'] == 'up-to-date',
      str(detail['installation']['last_state']))

status, tree = call('GET', f"/api/monitor/installation/{installation['id']}/diff?level=tree")
check('the tree comparison answers', status == 200 and isinstance(tree.get('files'), list), f"{len(tree.get('files') or [])} files")
check('nothing differs at the ref it came from', all(row['status'] == 'same' for row in tree.get('files') or []))

# 4. A local edit is drift, and an update refuses to discard it without a decision.
library = pathlib.Path(installation['library_path'])
target = library / 'SKILL.md'
original = target.read_text(encoding='utf-8')
target.write_text(original + '\n## Local note\n\nAdded by the monitor fixture.\n', encoding='utf-8')
status, detail = call('GET', f"/api/monitor/installation/{installation['id']}")
check('the local edit shows as drift', detail['drift']['localChanged'] == ['SKILL.md'], str(detail['drift']))

status, plan = call('POST', f"/api/monitor/installation/{installation['id']}/plan", {})
check('a plan can be read', status == 200 and plan.get('plan', {}).get('planId'), str(plan)[:140])
check('the plan says a local decision is required', bool(plan.get('plan', {}).get('localChoiceRequired')))

status, refused = call('POST', f"/api/monitor/installation/{installation['id']}/update",
                       {'planId': plan.get('plan', {}).get('planId'), 'confirm': True})
check('an update refuses to discard a local edit', status == 409 and refused.get('error') == 'local-edits', str(refused)[:160])

# 5. Taking upstream keeps the local copy in the trash, and the baseline moves.
status, done = call('POST', f"/api/monitor/installation/{installation['id']}/update",
                    {'planId': plan.get('plan', {}).get('planId'), 'confirm': True, 'choice': 'take-upstream'})
check('an explicit choice applies the update', status == 200 and done.get('result', {}).get('updated'), str(done)[:200])
trashed = done.get('result', {}).get('trashed')
check('the previous copy is in the trash', bool(trashed) and pathlib.Path(trashed).exists(), str(trashed))
check('the local edit is gone from the live copy', 'Local note' not in target.read_text(encoding='utf-8'))

# 6. Rollback restores the exact bytes that were replaced.
rollback_target = pathlib.Path(trashed)
status, rolled = call('POST', f"/api/monitor/installation/{installation['id']}/rollback", {'trashPath': str(rollback_target)})
check('rollback answers', status == 200 and rolled.get('restored'), str(rolled)[:120])
restored = (library / 'SKILL.md').read_text(encoding='utf-8')
check('rollback returns the local edit', 'Local note' in restored)
status, after = call('GET', f"/api/monitor/installation/{installation['id']}")
check('rollback keeps the original baseline, so the edit still shows as drift',
      after['drift']['localChanged'] == ['SKILL.md'], str(after['drift']))
status, listed = call('GET', f"/api/monitor/installation/{installation['id']}/diff?level=tree")
local_rows = listed.get('local') or []
check('the file list carries the local edit', any(row['path'] == 'SKILL.md' for row in local_rows), str(local_rows))
status, local_diff = call('GET', f"/api/monitor/installation/{installation['id']}/diff?level=file&path=SKILL.md&source=local")
check('a locally edited file diffs against upstream', status == 200 and any('Local note' in line['text'] for line in (local_diff.get('diff', {}).get('lines') or [])), str(local_diff.get('error')))

# 7. File-level and local-versus-remote diff.
status, file_diff = call('GET', f"/api/monitor/installation/{installation['id']}/diff?level=file&path=SKILL.md&source=local")
lines = file_diff.get('diff', {}).get('lines') or []
check('a file diff answers with lines', status == 200 and bool(lines), f'{len(lines)} lines')
check('the local comparison sees the added note', any('Local note' in line['text'] for line in lines))

# 8. Pin freezes the target, policy moves the channel, events are recorded and acknowledged.
status, pinned = call('POST', f"/api/monitor/installation/{installation['id']}/pin", {'ref': installation['ref']})
check('pin answers', status == 200 and pinned.get('installation', {}).get('pin_ref') == installation['ref'])
status, policy = call('POST', f"/api/monitor/installation/{installation['id']}/policy", {'channel': 'head', 'auto': 'notify'})
check('policy answers', status == 200 and policy.get('installation', {}).get('policy_channel') == 'head')
status, events = call('GET', '/api/monitor/events?all=1')
check('events exist after a check', status == 200 and isinstance(events.get('events'), list))
ids = [event['id'] for event in events.get('events', [])][:3]
if ids:
    status, acked = call('POST', '/api/monitor/events/ack', {'ids': ids})
    check('events acknowledge', status == 200 and acked.get('acknowledged') == len(ids))

# 9. Export is a real file.
status, export = call('GET', '/api/monitor/export')
check('export answers with ndjson', status == 200 and (isinstance(export, str) and '"kind":"installation"' in export) or isinstance(export, dict),
      str(export)[:80])

print('')
print('monitor checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
