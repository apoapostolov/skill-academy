#!/usr/bin/env bash
# Prove authoring end to end: a draft from a sentence, a composite assembled from two sources, a
# save through the placement engine with a byte-identical second save, and an undo.
#
# Everything runs in a temporary data directory and a temporary agent root, so no working library
# and no live agent directory is touched. The model is supplied, so the run costs nothing.
set -u
cd "$(dirname "$0")/.."
PORT="${AUTHORING_PORT:-$((11350 + RANDOM % 400))}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-authoring.XXXXXX")"
ROOT="$DATA/agent-root"
LIB="$DATA/library"
mkdir -p "$ROOT" "$LIB"
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")"
LIB_WIN="$(cygpath -w "$LIB" 2>/dev/null || echo "$LIB")"
DATA_WIN="$(cygpath -w "$DATA" 2>/dev/null || echo "$DATA")"
LOG="$DATA/server.log"

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
  echo "the authoring server did not start on $PORT; log:"; tail -30 "$LOG"; exit 1
fi

python3 - "$PORT" "$ROOT_WIN" "$DATA_WIN" "$LIB_WIN" <<'PY'
import hashlib, json, os, pathlib, sys, urllib.request as u

port, root, data, library = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
A = f'http://127.0.0.1:{port}'
drafts = data / 'drafts'

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
    folder = pathlib.Path(folder)
    for base, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if d not in ('.git', 'node_modules', '.archive'))
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

# 1. one sentence in, a draft out that validates clean.
generated_text = '''---
name: release-notes
description: Writes release notes that state what changed for the reader, not what the repository did.
version: 1.0.0
tags: [writing, release]
---

# Release notes

## What it does

- States the reader-facing change first, then the detail that supports it.
- Names the version the notes describe before describing it.
'''
status, made = call('POST', '/api/drafts', {
    'intent': 'write release notes that lead with what changed for the reader',
    'supplied': generated_text
})
draft = made.get('draft') or {}
meta = draft.get('meta') or {}
check('a sentence becomes a draft', status == 200 and bool(meta.get('id')), str(made)[:140])
check('the draft validates clean', (draft.get('validation') or {}).get('ok') is True,
      str((draft.get('validation') or {}).get('issues'))[:160])
check('the draft carries the name from its own frontmatter', (draft.get('validation') or {}).get('name') == 'release-notes')

draft_id = meta.get('id')
draft_dir = drafts / draft_id
check('the draft lives in the app data directory', draft_dir.exists() and (draft_dir / 'SKILL.md').exists(), str(draft_dir))
check('the draft is not in an agent root', not any(root.glob(f'**/{draft_id}')) and not (root / 'release-notes').exists())

# 2. an empty skill with two assigned sources becomes a composite draft with provenance.
status, empty = call('POST', '/api/drafts', {'name': 'zz-authored-composite'})
empty_id = ((empty.get('draft') or {}).get('meta') or {}).get('id')
check('an empty draft can be started', status == 200 and bool(empty_id))

for repo, path in [('mattpocock/skills', 'skills/engineering/ask-matt'), ('obra/superpowers', 'skills/brainstorming')]:
    status, linked = call('POST', f'/api/drafts/{empty_id}/links', {'repo': repo, 'sourcePath': path, 'mode': 'attach'})
    check(f'a source is assigned to the draft ({repo})', status == 200 and bool((linked.get('link') or {}).get('id')), str(linked)[:140])

status, links = call('GET', f'/api/drafts/{empty_id}/links')
check('the draft knows it has two sources', len(links.get('links') or []) == 2, str(links)[:140])

ingested = 0
for link in links.get('links') or []:
    status, plan = call('POST', f"/api/links/{link['id']}/plan", {})
    proposal = plan.get('proposal') or {}
    if not proposal.get('runId'):
        check(f"the source plans an ingest ({link['source_name']})", False, str(plan)[:160])
        continue
    status, applied = call('POST', '/api/ingest/apply', {'runId': proposal['runId'], 'confirm': True})
    if (applied.get('result') or {}).get('applied'):
        ingested += 1

check('both sources ingest into the draft', ingested == 2, f'{ingested} applied')
status, composite = call('GET', f'/api/drafts/{empty_id}')
text = (composite.get('draft') or {}).get('text') or ''
sections = [line for line in text.splitlines() if line.startswith('## From ')]
check('the draft carries one provenance section per source', len(sections) == 2, str(sections)[:180])
check('each provenance section names its commit', all('@' in section for section in sections), str(sections)[:180])
check('the composite draft is still a draft', (drafts / empty_id / 'SKILL.md').exists())

# 3. saving through the placement engine, twice, with the same package hash.
status, saved = call('POST', f'/api/drafts/{draft_id}/save', {'rootPath': str(root), 'replace': True})
result = saved.get('result') or {}
check('a draft saves into the library and the agent root', status == 200 and result.get('placement', {}).get('ok') is True, str(saved)[:180])
placed = root / 'release-notes'
check('the agent root points at the saved package', placed.exists(), str(placed))
first_hash = package_hash(result.get('directory') or '')

status, again = call('GET', f'/api/drafts/{draft_id}')
status, resaved = call('POST', f'/api/drafts/{draft_id}/save', {'rootPath': str(root), 'replace': True})
second_hash = package_hash((resaved.get('result') or {}).get('directory') or '')
check('a second save of unchanged text returns the same bytes', first_hash == second_hash, f'{first_hash} vs {second_hash}')

# 4. the undo puts the save back.
status, undone = call('POST', f'/api/drafts/{draft_id}/undo', {'journalId': (resaved.get('result') or {}).get('journalId')})
check('the save undoes', status == 200 and (undone.get('result') or {}).get('restored') is True, str(undone)[:160])

# 5. validation refuses a draft that is not a skill yet, and save refuses with it.
status, broken = call('PUT', f'/api/drafts/{empty_id}', {'text': '---\nname: zz-authored-composite\ndescription: \n---\n\n'})
check('validation catches a draft with no description', (broken.get('validation') or {}).get('ok') is False,
      str((broken.get('validation') or {}).get('issues'))[:160])
status, refused = call('POST', f'/api/drafts/{empty_id}/save', {'rootPath': str(root), 'replace': True})
check('an invalid draft cannot be saved', refused.get('error') == 'invalid-draft', str(refused)[:140])

# 6. an improvement is a proposal first: the draft text changes only when it is taken.
status, proposal = call('POST', f'/api/drafts/{draft_id}/improve', {
    'instruction': 'tighten it',
    'supplied': generated_text.replace('States the reader-facing change first', 'States what changed for the reader first')
})
check('an improvement comes back as a proposal', status == 200 and bool(proposal.get('text')), str(proposal)[:140])
check('the proposal carries a diff against the draft', bool((proposal.get('diff') or {}).get('files')), str((proposal.get('diff') or {}))[:120])
status, untouched = call('GET', f'/api/drafts/{draft_id}')
check('nothing was written before it was taken', 'States the reader-facing change first' in ((untouched.get('draft') or {}).get('text') or ''))

# 7. drafts never show up as library skills.
status, scan = call('POST', '/api/scan?force=1')
status, listing = call('GET', '/api/skills?limit=500')
names = {row.get('name') for row in (listing.get('rows') or [])}
check('the drafts are not skills in the library', 'release-notes' not in names, str(sorted(names))[:160])

# 8. tags live in the draft's frontmatter, and the rest of the block survives the edit.
status, tagged = call('PATCH', f'/api/drafts/{draft_id}/tags', {'tags': ['writing', 'release-notes', 'Writing']})
tagged_text = (tagged.get('draft') or {}).get('text') or ''
check('tags are written into the frontmatter', 'tags: [writing, release-notes]' in tagged_text, tagged_text.split('---')[1][:120] if tagged_text.count('---') >= 2 else tagged_text[:120])
check('the tag list is deduplicated', 'Writing' not in tagged_text.split('---')[1] if tagged_text.count('---') >= 2 else False)
check('the name and description survive the edit',
      'name:' in tagged_text.split('---')[1] and 'description:' in tagged_text.split('---')[1],
      tagged_text.split('---')[1][:120] if tagged_text.count('---') >= 2 else '')
check('tags sit under the description', tagged_text.split('---')[1].strip().splitlines()[-1].startswith('tags:'),
      str(tagged_text.split('---')[1].strip().splitlines())[:140])

status, cleared = call('PATCH', f'/api/drafts/{draft_id}/tags', {'tags': []})
check('an empty list leaves an empty tags line', 'tags: []' in ((cleared.get('draft') or {}).get('text') or ''),
      str((cleared.get('draft') or {}).get('text'))[:80].replace(chr(10), ' '))

status, bad_tags = call('PATCH', f'/api/drafts/{draft_id}/tags', {'tags': 'writing'})
check('a tag list that is not a list is refused', status == 400, str(bad_tags)[:100])

status, no_draft = call('PATCH', '/api/drafts/no-such-draft/tags', {'tags': ['x']})
check('tags on a draft that is not there answer 404', status == 404, str(no_draft)[:100])

# 9. deleting a draft moves its folder to the trash instead of unlinking it.
status, deleted = call('DELETE', f'/api/drafts/{empty_id}', {})
check('a draft can be deleted', status == 200 and deleted.get('deleted') == empty_id, str(deleted)[:140])
moved = deleted.get('movedTo') or ''
check('the folder is moved, not unlinked', bool(moved) and pathlib.Path(moved).exists(), moved)
status, listing_after = call('GET', '/api/drafts')
check('the deleted draft is gone from the list',
      empty_id not in {row.get('id') for row in (listing_after.get('drafts') or [])},
      str(sorted(row.get('id') for row in (listing_after.get('drafts') or [])))[:160])
status, twice = call('DELETE', f'/api/drafts/{empty_id}', {})
check('deleting it twice answers 404', status == 404, str(twice)[:100])

print('')
print('authoring checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
