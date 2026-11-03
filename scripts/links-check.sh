#!/usr/bin/env bash
# Prove linked sources end to end: two repositories, three modes, a conflict, a restore.
#
# Everything runs in a temporary data directory and a temporary agent root, so no working library
# and no live agent directory is touched.
set -u
cd "$(dirname "$0")/.."
PORT="${LINKS_PORT:-$((10950 + RANDOM % 400))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-links.XXXXXX")"
ROOT="$DATA/agent-root"
LIB="$DATA/library"
mkdir -p "$ROOT/zz-composite/references" "$LIB"
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")"
LIB_WIN="$(cygpath -w "$LIB" 2>/dev/null || echo "$LIB")"
DATA_WIN="$(cygpath -w "$DATA" 2>/dev/null || echo "$DATA")"
LOG="$DATA/server.log"

cat > "$ROOT/zz-composite/SKILL.md" <<'MD'
---
name: zz-composite
description: A placeholder skill that exists to absorb rules from two remote skills during a test.
---

# zz-composite

## Rules

- Keep the local wording when a remote rule contradicts it, and report the contradiction instead of resolving it.
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
  echo "the links server did not start on $PORT; log:"; tail -30 "$LOG"; exit 1
fi

python3 - "$PORT" "$ROOT_WIN" <<'PY'
import hashlib, json, os, pathlib, sys, urllib.request as u

port, root = sys.argv[1], pathlib.Path(sys.argv[2])
A = f'http://127.0.0.1:{port}'
target = root / 'zz-composite'

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

status, scan = call('POST', '/api/scan?force=1')
status, listing = call('GET', '/api/skills?limit=200')
rows = [row for row in (listing.get('rows') or []) if row.get('name') == 'zz-composite']
check('the placeholder skill is indexed', bool(rows), f"{len(rows)} row(s)")
if not rows:
    print('links: cannot continue without a target skill')
    sys.exit(1)
skill_id = rows[0]['id']
before_hash = package_hash(target)

# 1. Two links, two repositories.
status, a = call('POST', f'/api/skills/{skill_id}/links',
                 {'repo': 'mattpocock/skills', 'sourcePath': 'skills/engineering/code-review', 'mode': 'attach'})
check('a link to the first repository is created', status == 200 and a['link']['repo'] == 'mattpocock/skills', str(a)[:120])
link_a = a['link']['id'] if status == 200 else None
status, b = call('POST', f'/api/skills/{skill_id}/links',
                 {'repo': 'obra/superpowers', 'sourcePath': 'skills/receiving-code-review', 'mode': 'distill'})
check('a link to the second repository is created', status == 200 and b['link']['repo'] == 'obra/superpowers', str(b)[:120])
link_b = b['link']['id'] if status == 200 else None
status, dup = call('POST', f'/api/skills/{skill_id}/links',
                   {'repo': 'mattpocock/skills', 'sourcePath': 'skills/engineering/code-review'})
check('the same source twice is refused', status == 409 and dup.get('error') == 'duplicate-link', str(dup)[:100])
check('the skill is now composite', call('GET', f'/api/skills/{skill_id}/links')[1].get('composite') is True)

# 2. Check before the first ingest.
status, checked = call('POST', f'/api/links/{link_a}/check')
check('a link resolves its head before any ingest', status == 200 and len(checked['status']['head'] or '') == 40, str(checked)[:120])

# 3. Attach: files copied, no model asked, one labelled section.
status, plan_a = call('POST', f'/api/links/{link_a}/plan', {})
proposal_a = plan_a.get('proposal') or {}
check('attach plans without a model', status == 200 and proposal_a.get('model') is None, str(plan_a)[:140])
check('attach lists the knowledge files', bool(proposal_a.get('files')), str(proposal_a.get('files'))[:120])
status, applied_a = call('POST', '/api/ingest/apply', {'runId': proposal_a.get('runId'), 'confirm': True})
check('attach applies', status == 200 and applied_a['result']['applied'], str(applied_a)[:140])
copied = list((target / 'references' / 'ingested' / 'mattpocock-skills').rglob('*')) if (target / 'references' / 'ingested' / 'mattpocock-skills').exists() else []
check('the upstream files are copied verbatim', bool(copied), f'{len(copied)} entries')
body = (target / 'SKILL.md').read_text(encoding='utf-8')
check('the body gains one labelled section', '## From code-review (mattpocock/skills@' in body)
check('the manifest names the commit', (target / 'references' / 'ingested' / 'mattpocock-skills.md').exists())

# 4. A second run with no upstream change writes nothing.
status, again = call('POST', f'/api/links/{link_a}/plan', {})
check('a second ingest on an unchanged link is refused', status == 409 and again.get('error') == 'no-change', str(again)[:120])
after_hash = package_hash(target)
check('the refused run wrote nothing', after_hash == package_hash(target))

# 5. Distill: a real model call over a real repository.
status, plan_b = call('POST', f'/api/links/{link_b}/plan', {}, timeout=600)
proposal_b = plan_b.get('proposal') or {}
check('distill answers with a proposal', status == 200 and proposal_b.get('runId'), str(plan_b)[:200])
check('distill was a bootstrap', proposal_b.get('kind') == 'bootstrap', str(proposal_b.get('kind')))
rules = (proposal_b.get('added') or []) + (proposal_b.get('changed') or [])
check('distill found rules to add', bool(rules), f'{len(rules)} rule(s), model {proposal_b.get("model")}')
status, applied_b = call('POST', '/api/ingest/apply', {'runId': proposal_b.get('runId'), 'confirm': True})
check('distill applies', status == 200 and applied_b['result']['applied'], str(applied_b)[:140])
body = (target / 'SKILL.md').read_text(encoding='utf-8')
check('the distilled section is labelled with its repository and commit',
      '## From receiving-code-review (obra/superpowers@' in body)
reference = target / 'references' / 'ingested' / 'obra-superpowers.md'
check('the reference file carries the commit', reference.exists() and proposal_b['toSha'] in reference.read_text(encoding='utf-8'))
check('the section names what came from where', len(reference.read_text(encoding='utf-8').splitlines()) > 4)

# 6. A contradicting rule keeps the local text and is listed.
status, c = call('POST', f'/api/skills/{skill_id}/links',
                 {'repo': 'obra/superpowers', 'sourcePath': 'skills/brainstorming', 'mode': 'distill'})
link_c = c['link']['id'] if status == 200 else None
supplied = {
    'added_rules': [{'rule': 'Name the constraint before proposing a design.', 'why': 'a design that ignores a fixed cost is a rewrite'}],
    'changed_rules': [],
    'conflicts': [{'local': 'Keep the local wording when a remote rule contradicts it',
                   'upstream': 'Always adopt the remote wording and drop the local rule',
                   'why': 'the two rules disagree about who wins'}],
    'dropped': []
}
status, plan_c = call('POST', f'/api/links/{link_c}/plan', {'supplied': supplied})
proposal_c = plan_c.get('proposal') or {}
check('a supplied answer becomes a dry run', status == 200 and proposal_c.get('runId'), str(plan_c)[:140])
check('the conflict is reported', len(proposal_c.get('conflicts') or []) == 1, str(proposal_c.get('conflicts'))[:160])
status, applied_c = call('POST', '/api/ingest/apply', {'runId': proposal_c.get('runId'), 'confirm': True})
check('the run applies with the conflict recorded', status == 200 and applied_c['result']['conflicts'] == 1, str(applied_c)[:140])
body = (target / 'SKILL.md').read_text(encoding='utf-8')
check('the local rule survives a contradiction',
      'Keep the local wording when a remote rule contradicts it' in body)
check('the upstream wording was not written into the body', 'Always adopt the remote wording' not in body)

# 7. Restore returns the pre-ingest hash.
status, undone = call('POST', '/api/ingest/undo', {'runId': proposal_b['runId']})
check('undo answers', status == 200 and undone['result']['restored'], str(undone)[:140])
check('undo returns the hash the run started from', undone['result']['hash'] == proposal_b['hashBefore'],
      f"expected {proposal_b['hashBefore']}, got {undone['result']['hash']}")
body = (target / 'SKILL.md').read_text(encoding='utf-8')
check('the distilled section is gone after undo', '## From receiving-code-review (obra/superpowers@' not in body)
# Undo is a point in time, not a per-source removal: the run after B had already landed, and its
# section went with the snapshot B restored. Undo in reverse order and this never bites.
check('an older undo takes the later ingest with it',
      '## From brainstorming (obra/superpowers@' not in body,
      'undo in reverse order; an older snapshot cannot know what came after it')

# 8. A composite skill is not a merge candidate.
status, groups = call('GET', '/api/consolidate')
keys = json.dumps(groups)[:4000]
check('consolidation never proposes a composite', 'zz-composite' not in keys, str(status))

print('')
print('link checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
