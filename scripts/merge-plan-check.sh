#!/usr/bin/env bash
# Prove the merge planning dialog: promote with drift, consolidate into X, improve as a job.
#
# Everything runs in a temporary data directory and a temporary agent root. These placeholder skills
# exist only here, so a working library is never touched.
set -u
cd "$(dirname "$0")/.."
PORT="${MERGE_PORT:-$((11350 + RANDOM % 400))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-merge.XXXXXX")"
ROOT="$DATA/agent-root"
LIB="$DATA/library"
mkdir -p "$LIB"
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")"
LIB_WIN="$(cygpath -w "$LIB" 2>/dev/null || echo "$LIB")"
DATA_WIN="$(cygpath -w "$DATA" 2>/dev/null || echo "$DATA")"
LOG="$DATA/server.log"

# --- promote pair: the older copy holds one rule the newer one dropped -------------------------
mkdir -p "$ROOT/zz-newer" "$ROOT/zz-older"
cat > "$ROOT/zz-newer/SKILL.md" <<'MD'
---
name: zz-promote
description: A placeholder skill used by the merge planning test to prove drift is carried forward.
version: 2.0.0
tags: [fixture, merge]
---

# zz-promote

## Rules

- Read the whole file before editing any part of it, because a partial read hides the conflict.
- Prefer one clear change per commit, so a revert is a single operation.
MD
cat > "$ROOT/zz-older/SKILL.md" <<'MD'
---
name: zz-promote
description: A placeholder skill used by the merge planning test to prove drift is carried forward.
version: 1.2.0
tags: [fixture, organic]
---

# zz-promote

## Rules

- Read the whole file before editing any part of it, because a partial read hides the conflict.
- Name the failing command in the report, because a symptom without its command cannot be reproduced.
MD
printf '%s\n' '#!/usr/bin/env bash' 'echo old-helper' > "$ROOT/zz-older/scripts-helper.sh"

# --- revert pair: the promoted copy reports a lower version -----------------------------------
mkdir -p "$ROOT/zz-revert-new" "$ROOT/zz-revert-old"
cat > "$ROOT/zz-revert-new/SKILL.md" <<'MD'
---
name: zz-revert
description: A placeholder skill used to prove that a downward version move needs an acknowledgement.
version: 1.9.0
---

# zz-revert

- Keep the changelog entry with the change that caused it.
MD
cat > "$ROOT/zz-revert-old/SKILL.md" <<'MD'
---
name: zz-revert
description: A placeholder skill used to prove that a downward version move needs an acknowledgement.
version: 2.1.0
---

# zz-revert

- Keep the changelog entry with the change that caused it.
- Tag every release before publishing it, because a moving tag cannot be audited.
MD

# --- group for consolidation: two copies with support files ----------------------------------
mkdir -p "$ROOT/zz-group-a/references" "$ROOT/zz-group-a/assets" "$ROOT/zz-group-a/scripts"
mkdir -p "$ROOT/zz-group-b/references"
cat > "$ROOT/zz-group-a/SKILL.md" <<'MD'
---
name: zz-group
description: A placeholder skill pair used to prove that several sources can fold into one new skill.
version: 1.0.0
tags: [fixture]
---

# zz-group

## Rules

- State the constraint before the design, because a design that ignores a fixed cost is a rewrite.
- Keep the rollback command next to the deploy command.
MD
printf '%s\n' 'Support note that belongs to the first copy and must survive the fold.' > "$ROOT/zz-group-a/references/notes.md"
printf '\x89PNG\r\n\x1a\n' > "$ROOT/zz-group-a/assets/logo.png"
printf '%s\n' '#!/usr/bin/env bash' 'echo helper' > "$ROOT/zz-group-a/scripts/helper.sh"
cat > "$ROOT/zz-group-b/SKILL.md" <<'MD'
---
name: zz-group
description: A placeholder skill pair used to prove that several sources can fold into one new skill.
version: 1.4.0
tags: [fixture, second]
---

# zz-group

## Rules

- State the constraint before the design, because a design that ignores a fixed cost is a rewrite.
- Name the owner of every follow-up, because an unowned action is a wish.
MD
printf '%s\n' 'Support note that belongs to the second copy and is carried under references/from-<folder>.' > "$ROOT/zz-group-b/references/extra.md"

# --- rollback pair: a consolidation that fails on its second move -----------------------------
mkdir -p "$ROOT/zz-rb-a" "$ROOT/zz-rb-b"
cat > "$ROOT/zz-rb-a/SKILL.md" <<'MD'
---
name: zz-rollback
description: A placeholder pair used to prove that a failed consolidation puts every source back.
version: 1.0.0
---

# zz-rollback

## Rules

- Read the whole file before editing any part of it, because a partial read hides the conflict.
- Name the failing command in the report, because a symptom without its command cannot be reproduced.
- Keep the rollback command next to the deploy command, so a bad deploy is one line from undone.
- State the constraint before the design, because a design that ignores a fixed cost is a rewrite.
- Rule from the first copy, because the rollback proof needs two copies.
MD
cat > "$ROOT/zz-rb-b/SKILL.md" <<'MD'
---
name: zz-rollback
description: A placeholder pair used to prove that a failed consolidation puts every source back.
version: 1.0.0
---

# zz-rollback

## Rules

- Read the whole file before editing any part of it, because a partial read hides the conflict.
- Name the failing command in the report, because a symptom without its command cannot be reproduced.
- Keep the rollback command next to the deploy command, so a bad deploy is one line from undone.
- State the constraint before the design, because a design that ignores a fixed cost is a rewrite.
- Rule from the second copy, because the rollback proof needs two copies.
MD

# --- improve target ---------------------------------------------------------------------------
mkdir -p "$ROOT/zz-improve"
cat > "$ROOT/zz-improve/SKILL.md" <<'MD'
---
name: zz-improve
description: A placeholder skill used to prove that an improve job proposes per-file edits first.
version: 1.0.0
---

# zz-improve

## Rules

- Read the file before editing it.
MD

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
for _ in $(seq 1 90); do
  if curl -s "http://127.0.0.1:$PORT/api/skills?limit=1" 2>/dev/null | grep -q '"total"'; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "the merge server did not start on $PORT; log:"; tail -30 "$LOG"; exit 1
fi

python3 - "$PORT" "$ROOT_WIN" <<'PY'
import hashlib, json, os, pathlib, sys, time, urllib.request as u

port, root = sys.argv[1], pathlib.Path(sys.argv[2])
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

def package_hash(folder):
    digest = hashlib.sha256()
    for base, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if d not in ('.git', 'node_modules'))
        for name in sorted(files):
            full = pathlib.Path(base) / name
            digest.update(str(full.relative_to(folder)).replace(os.sep, '/').encode())
            digest.update(b'\0')
            digest.update(full.read_bytes())
            digest.update(b'\0')
    return digest.hexdigest()[:16]

failures = []
def check(label, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + label + (f'  {detail}' if detail else ''))
    if not condition:
        failures.append(label)

def group_for(fragment):
    status, run = call('POST', '/api/consolidate/dry-run')
    for group in run.get('groups') or []:
        if fragment in json.dumps(group.get('members', [])):
            return group
    return None

status, scan = call('POST', '/api/scan?force=1')
check('the placeholder root is indexed', status == 200 and scan.get('skills', 0) >= 8, str(scan)[:120])

# ---------------------------------------------------------------- 1. promote with drift
status, planned = call('POST', '/api/promote/plan', {
    'winnerPath': str(root / 'zz-newer'),
    'loserPath': str(root / 'zz-older')
})
plan = planned.get('plan') or {}
check('a promote plan is produced', status == 200 and plan.get('planId'), str(planned)[:160])
drift = [line['text'] for line in (plan.get('drift', {}).get('lines') or [])]
check('the drift names the rule only the older copy has',
      any('Name the failing command' in line for line in drift), str(drift)[:160])
check('the winner is the newer copy', (plan.get('winner') or {}).get('version') == '2.0.0', str((plan.get('winner') or {}).get('version')))
check('the plan carries a diff of the finished skill', any(f.get('stats', {}).get('added', 0) > 0 for f in (plan.get('diff') or {}).get('files', [])), '')
check('a file only the older copy has is listed as drift', any(f['path'] == 'scripts-helper.sh' for f in (plan.get('drift', {}).get('files') or [])), str(plan.get('drift', {}).get('files'))[:120])
check('missing support files need an acknowledgement', any('file(s) exist only in the older copy' in reason for reason in (plan.get('requiresAck') or [])), str(plan.get('requiresAck'))[:160])

status, refused = call('POST', '/api/promote/apply', {'planId': plan.get('planId')})
check('applying without the acknowledgement is refused', status == 428 and refused.get('error') == 'ack-required', str(refused)[:140])
check('the refusal wrote nothing', (root / 'zz-older' / 'SKILL.md').exists())

status, applied = call('POST', '/api/promote/apply', {'planId': plan.get('planId'), 'ack': True})
result = applied.get('result') or {}
check('the promote applies', status == 200 and result.get('applied'), str(applied)[:160])
body = (root / 'zz-newer' / 'SKILL.md').read_text(encoding='utf-8')
check('the carried rule is in the promoted copy', 'Name the failing command' in body)
check('the carried section is labelled', '## Carried from' in body, body[body.find('## Carried'):][:60])
check('the support file came across', (root / 'zz-newer' / 'scripts-helper.sh').exists())
check('the loser is in the trash', result.get('loserTrashId') is not None, str(result.get('loserTrashId')))
status, trash = call('GET', '/api/trash')
entries = trash.get('entries') or []
check('the trash lists the loser', any('zz-older' in str(entry.get('skill_path', '')) for entry in entries), str([entry.get('name') for entry in entries])[:120])
check('the loser left its folder', not (root / 'zz-older').exists())

# ---------------------------------------------------------------- 2. a revert needs an acknowledgement
status, revert_plan = call('POST', '/api/promote/plan', {
    'winnerPath': str(root / 'zz-revert-new'),
    'loserPath': str(root / 'zz-revert-old')
})
plan2 = revert_plan.get('plan') or {}
check('a revert is detected', plan2.get('reverted') is True, str(plan2.get('reverted')))
check('the revert is stated in versions', any('1.9.0' in reason and '2.1.0' in reason for reason in (plan2.get('requiresAck') or [])), str(plan2.get('requiresAck'))[:160])
status, down = call('POST', '/api/promote/apply', {'planId': plan2.get('planId'), 'ack': True})
check('an acknowledged revert still applies', status == 200 and (down.get('result') or {}).get('applied'), str(down)[:140])

# ---------------------------------------------------------------- 3. consolidate into X
group = group_for('zz-group')
check('the placeholder pair forms a group', group is not None, '')
supplied = '## Rules\n\n- State the constraint before the design, because a design that ignores a fixed cost is a rewrite.\n- Keep the rollback command next to the deploy command.\n- Name the owner of every follow-up, because an unowned action is a wish.\n'
status, x_plan = call('POST', '/api/merge-into-x/plan', {
    'groupKey': (group or {}).get('key'),
    'name': 'zz-merged-x',
    'suppliedBody': supplied
})
xplan = x_plan.get('plan') or {}
check('a consolidation plan is produced', status == 200 and xplan.get('planId'), str(x_plan)[:180])
manifest = (xplan.get('diff') or {}).get('manifest') or []
kinds = {entry['kind'] for entry in manifest}
check('the plan shows the finished package as files', bool(manifest), f'{len(manifest)} entries')
check('assets and scripts are named in the manifest', {'asset', 'script'} <= kinds, str(sorted(kinds)))
check('the diff carries the new SKILL.md', any(entry['path'] == 'SKILL.md' for entry in manifest))

group_a_hash = package_hash(root / 'zz-group-a')
group_b_hash = package_hash(root / 'zz-group-b')
status, x_applied = call('POST', '/api/merge-into-x/apply', {'planId': xplan.get('planId')})
xresult = x_applied.get('result') or {}
check('the consolidation applies', status == 200 and xresult.get('applied'), str(x_applied)[:200])
check('X exists on disk', (root / 'zz-merged-x' / 'SKILL.md').exists())
merged_text = (root / 'zz-merged-x' / 'SKILL.md').read_text(encoding='utf-8')
check('X carries the merged rules', 'Name the owner of every follow-up' in merged_text)
merged_files = sorted(str(p.relative_to(root / 'zz-merged-x')).replace(os.sep, '/') for p in (root / 'zz-merged-x').rglob('*') if p.is_file())
check('X keeps the support files of both copies',
      any(name.endswith('notes.md') for name in merged_files) and any(name.endswith('extra.md') for name in merged_files),
      str(merged_files))
check('the sources are in the trash', len(xresult.get('trashed') or []) == 2, str(xresult.get('trashed'))[:160])
check('the source folders are gone', not (root / 'zz-group-a').exists() and not (root / 'zz-group-b').exists())

status, trash = call('GET', '/api/trash')
entries = trash.get('entries') or []
target = next((entry for entry in entries if 'zz-group-a' in str(entry.get('skill_path', ''))), None)
check('the trash lists a source', target is not None, str([entry.get('skill_path') for entry in entries])[-120:])
if target:
    status, restored = call('POST', f"/api/trash/{target['id']}/restore")
    check('a source can be restored from the trash', status == 200 and restored.get('state') == 'restored', str(restored)[:160])
    check('the restored copy is byte-identical', package_hash(root / 'zz-group-a') == group_a_hash,
          f"{package_hash(root / 'zz-group-a')} vs {group_a_hash}")

# ---------------------------------------------------------------- 4. rollback of a failed consolidation
rb_group = group_for('zz-rb-')
check('the rollback pair forms a group', rb_group is not None, '')
status, rb_plan = call('POST', '/api/merge-into-x/plan', {
    'groupKey': (rb_group or {}).get('key'),
    'name': 'zz-rollback-x',
    'suppliedBody': '- Rule from both copies, because the rollback proof needs a body.\n'
})
rbplan = rb_plan.get('plan') or {}
check('a rollback plan is produced', bool(rbplan.get('planId')), str(rb_plan)[:200])
rb_hash_a = package_hash(root / 'zz-rb-a')
status, failed = call('POST', '/api/merge-into-x/apply', {'planId': rbplan.get('planId'), 'failAfter': 1})
check('a failing consolidation reports the failure', failed.get('error') in ('apply-failed', 'plan-blocked'), str(failed)[:160])
check('the moved package came back', (root / 'zz-rb-a' / 'SKILL.md').exists())
check('the untouched package is still there', (root / 'zz-rb-b' / 'SKILL.md').exists())
check('no half-written X is left behind', not (root / 'zz-rollback-x').exists())
check('the restored package is byte-identical', package_hash(root / 'zz-rb-a') == rb_hash_a)

# ---------------------------------------------------------------- 5. improve as a job
status, started = call('POST', '/api/improve/job', {
    'path': str(root / 'zz-improve'),
    'instruction': 'Make the rule list concrete enough to act on, and keep it short.'
}, timeout=600)
job = started.get('job') or {}
check('an improve job starts', status == 200 and job.get('jobId'), str(started)[:180])
hash_before = package_hash(root / 'zz-improve')
current = job
for _ in range(150):
    status, polled = call('GET', f"/api/improve/job/{job.get('jobId')}")
    current = polled.get('job') or current
    if current.get('status') != 'running':
        break
    time.sleep(2)
check('the job finishes', current.get('status') in ('ready', 'failed'), f"{current.get('status')} {str(current.get('error'))[:120]}")
steps = [step['name'] for step in current.get('steps') or []]
check('the job walks several steps', len(steps) >= 4, str(steps))
check('the job produced a per-file proposal', bool(current.get('files')), f"{len(current.get('files') or [])} file(s)")
check('the proposal carries a diff', bool((current.get('diff') or {}).get('files')))
check('nothing was written before approve', package_hash(root / 'zz-improve') == hash_before)

if current.get('status') == 'ready':
    status, applied_job = call('POST', '/api/improve/apply', {'jobId': job.get('jobId'), 'confirm': True})
    applied_result = applied_job.get('result') or {}
    check('the improve applies', status == 200 and applied_result.get('applied'), str(applied_job)[:180])
    check('the package hash moved', applied_result.get('hashAfter') != applied_result.get('hashBefore'))
    status, undone = call('POST', '/api/improve/undo', {'jobId': job.get('jobId')})
    undo_result = undone.get('result') or {}
    check('undo reports the hash the job started from', undo_result.get('hash') == applied_result.get('hashBefore'))
    check('the package on disk is back to its original bytes', package_hash(root / 'zz-improve') == hash_before,
          f"{package_hash(root / 'zz-improve')} vs {hash_before}")

print('')
print('merge plan checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
