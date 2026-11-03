#!/usr/bin/env bash
# Exercise consolidation and curation against fixtures only, never the live skill roots.
#
# The run builds its own skill tree in a temporary directory, boots a second server on a free port
# with its own database, and points the index at that one root. Anything a merge writes lands there,
# so a defect costs a fixture and never a working skill.
set -u
cd "$(dirname "$0")/.."
# A free port per run: a leftover server on a fixed port answers readiness and every assertion then
# runs against the wrong library.
PORT="${FIXTURE_PORT:-$((10100 + RANDOM % 400))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-fixtures.XXXXXX")"
ROOT="$DATA/root"
LOG="$DATA/server.log"

python3 - "$ROOT" <<'PY'
import pathlib, sys

root = pathlib.Path(sys.argv[1])

def skill(name, version, description, rules, extra=''):
    body = ['---', f'name: {name}', f'description: {description}',
            'metadata:', '  hermes:', '    tags: ["family:fixtures"]', f'  version: {version}',
            '---', '', f'# {name}', '', '## Setup', '',
            'Read the machine state before the first write and never assume the last run left it clean.',
            '', '## Rules', '']
    body += [f'- {rule}' for rule in rules]
    text = '\n'.join(body) + '\n'
    if extra:
        text += '\n' + extra
    package = root / name
    package.mkdir(parents=True, exist_ok=True)
    (package / 'SKILL.md').write_text(text, encoding='utf-8')

pointer_rules = [
    'Send deleted files to the Recycle Bin, never unlink.',
    'Keep the pointer block at the top of any router.',
    'Report the absolute path in every failure message.'
]
skill('zz-pair-one', '1.0.0', 'First copy of one body for a pointer test.', pointer_rules)
skill('zz-pair-two', '1.0.0', 'Second copy of one body for a pointer test.', pointer_rules)

router_rules = [
    'Parse the schema before writing any row, and fail on an unknown column.',
    'Quote every identifier that carries a hyphen or a reserved word.',
    'Write the migration in one transaction so a partial apply cannot survive.'
]
# Heading overlap has to clear the classifier's floor, so both bodies carry the same two extra
# sections and only the smaller one owns lanes the larger lacks.
wide_extra = (
    '## Limits\n\n'
    'The pass holds one writer lock for its whole duration, so a second migration waits rather than '
    'interleaving its statements with the first one.\n\n'
    '## Deploy\n\n'
    'Run it against the staging copy first, compare the row counts, then run it against the live file '
    'with the dry pass enabled, and only then write: the order is the procedure here.\n'
)
skill('zz-wide', '2.0.0', 'Larger body of the router pair.', router_rules, extra=wide_extra)
skill('zz-narrow', '2.3.1', 'Smaller body of the router pair, with its own lanes.', router_rules,
      extra='## Edge cases\n\nA locked row retries four times.\n\n'
            '## References\n\n| File | Purpose |\n| --- | --- |\n'
            '| `references/retries.md` | Retry table. |\n')
(root / 'zz-narrow' / 'references').mkdir(parents=True, exist_ok=True)
(root / 'zz-narrow' / 'references' / 'retries.md').write_text('# Retry table\n\nfour attempts, then 409.\n', encoding='utf-8')

skill('zz-stub', '1.0.0', 'Fixture with a body too short to carry a procedure.', ['Run it once.'])
skill('zz-long-description', '1.0.0',
      'Fixture whose description runs well past the sixty character budget the index keeps for new skills.',
      pointer_rules)
skill('zz-no-period', '1.0.0', 'Fixture description without a closing period', pointer_rules)
print('fixtures:', sorted(p.name for p in root.iterdir() if p.is_dir()))
PY

SKILL_ACADEMY_DATA="$DATA" \
SKILL_ACADEMY_ONLY_ROOTS="$ROOT" \
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
for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/api/skills?limit=1" 2>/dev/null | grep -q '"total"'; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "the fixture server did not start on $PORT; log:"; tail -20 "$LOG"; exit 1
fi

python3 - "$PORT" "$ROOT" <<'PY'
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

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

library = get('/api/skills?limit=200')
check('the fixture root is the only root', library['total'] == 7, f"total {library['total']}")

improve = post('/api/improve/dry-run', {})[1]
rules = {}
for finding in improve.get('findings', []):
    rules.setdefault(finding['rule'], []).append(finding['skill'])
check('improve finds the stub body', 'zz-stub' in rules.get('stub-body', []), str(rules.get('stub-body')))
check('improve flags the long description', 'zz-long-description' in rules.get('description-over-budget', []))
check('improve flags the missing period', 'zz-no-period' in rules.get('description-no-period', []))
check('improve reports no family problems on clean fixtures', not any(
    rule in rules for rule in ('category-mismatch', 'unexpected-unfiled', 'multi-family')), str(sorted(rules)))

consolidate = post('/api/consolidate/dry-run', {})[1]
groups = consolidate['groups']

pair = next((g for g in groups if 'zz-pair' in g['key']), None)
check('the identical copies form one group', pair is not None)
pointer_archive = None
if pair:
    plan = pair['plan'] or {}
    check('an identical copy is pointerized', len(plan.get('pointerize', [])) == 1 and not plan.get('routerize'),
          str({k: plan.get(k) for k in ('pointerize', 'routerize')}))
    one = root / 'zz-pair-one' / 'SKILL.md'
    two = root / 'zz-pair-two' / 'SKILL.md'
    before = {one: digest(one), two: digest(two)}
    status, applied = post('/api/consolidate/apply', {'key': pair['key'], 'read': True, 'confirm': True})
    check('the pointer applies', status == 200 and not applied.get('error'), str(applied.get('error')))
    check('every touched skill still loads afterwards',
          bool((applied.get('closeOut') or {}).get('ok')),
          str((applied.get('closeOut') or {}).get('problems')))
    archives = applied.get('archived') or []
    pointer_archive = archives[0] if archives else None
    check('the replaced body is archived exactly',
          bool(pointer_archive) and digest(pathlib.Path(pointer_archive)) in before.values())
    pointer_file = next((p for p in (one, two) if 'Merged into' in p.read_text(encoding='utf-8')), None)
    check('the loser became a pointer', pointer_file is not None)
    if pointer_file and pointer_archive:
        post('/api/consolidate/undo', {'archivePath': pointer_archive, 'originalPath': str(pointer_file)})
        check('the pointer restores byte for byte', digest(pointer_file) == before[pointer_file])

wide = root / 'zz-wide' / 'SKILL.md'
narrow = root / 'zz-narrow' / 'SKILL.md'
router_group = next((g for g in groups if 'zz-narrow' in g['key'] and 'zz-wide' in g['key']), None)
check('the router pair forms one group', router_group is not None)
if router_group:
    plan = router_group['plan'] or {}
    check('the subtraction chooses a router, not a pointer',
          [r['name'] for r in plan.get('routerize', [])] == ['zz-narrow'] and not plan.get('pointerize'),
          str({k: plan.get(k) for k in ('pointerize', 'routerize')}))
    before_narrow, before_wide = narrow.read_text(encoding='utf-8'), digest(wide)
    status, applied = post('/api/consolidate/apply', {'key': router_group['key'], 'read': True, 'confirm': True})
    after = narrow.read_text(encoding='utf-8')
    check('the router applies', status == 200 and not applied.get('error'), str(applied.get('error')))
    check('the router still loads afterwards', bool((applied.get('closeOut') or {}).get('ok')),
          str((applied.get('closeOut') or {}).get('problems')))
    check('the router points at the canonical first', 'Load `zz-wide` first' in after)
    check('the router keeps its unique lane', 'A locked row retries four times' in after)
    check('the router keeps its own support-file table', 'references/retries.md' in after)
    check('the router invents no placeholder table', 'table above' not in after and after.count('## References') == 1)
    check('the router bumps its version', 'version: 2.3.2' in after,
          [line.strip() for line in after.splitlines() if 'version:' in line])
    check('the canonical body is untouched', digest(wide) == before_wide)
    archives = applied.get('archived') or []
    if archives:
        post('/api/consolidate/undo', {'archivePath': archives[0], 'originalPath': str(narrow)})
        check('the router restores byte for byte', narrow.read_text(encoding='utf-8') == before_narrow)

if pair:
    status, proposal = post('/api/consolidate/fold', {'key': pair['key']})
    check('fold answers', status in (200, 409) and not proposal.get('error'), str(proposal.get('error')))
    if proposal.get('status') == 'clean':
        check('the fold audit counts every line', proposal['keptRules'] == proposal['totalRules'],
              f"{proposal['keptRules']}/{proposal['totalRules']}")
        status, applied = post('/api/consolidate/fold/apply', {'key': pair['key'], 'read': True, 'confirm': True})
        check('a clean fold applies', status == 200 and bool(applied.get('applied')), str(applied.get('error')))
    else:
        check('a lossy fold is refused with its counts', True,
              f"status {proposal.get('status')} · kept {proposal.get('keptRules')}/{proposal.get('totalRules')}")

if pointer_archive:
    status, refused = post('/api/consolidate/undo', {'archivePath': pointer_archive, 'originalPath': str(narrow)})
    held = (refused.get('error') or '') if isinstance(refused, dict) else ''
    check('a restore refuses another skill\'s archive', 'archive holds' in held, held or f'status {status}')
    check('the refusal leaves the file alone', narrow.exists())

print('')
print('fixture checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
