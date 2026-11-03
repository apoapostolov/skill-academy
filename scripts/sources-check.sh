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

# The registry's verdict is parsed from a captured payload, so the rule is proven without the network.
npx tsx scripts/skillssh-probe.ts
if [ $? -ne 0 ]; then echo "the skills.sh probe failed"; exit 1; fi

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

# An edit made in the library must stop an update, name the file, and yield only when forced.
(repo / 'skills' / 'from-checkout' / 'SKILL.md').write_text(
    (repo / 'skills' / 'from-checkout' / 'SKILL.md').read_text(encoding='utf-8') + '\n- A third rule, upstream.\n',
    encoding='utf-8')
git('add', '-A')
git('commit', '-qm', 'third')

library_file = library / 'from-checkout' / 'SKILL.md'
library_file.write_text(library_file.read_text(encoding='utf-8') + '\n- A local note that must not be lost.\n',
                        encoding='utf-8')

status, guarded_plan = call('POST', f'/api/sources/{sid}/plan-update', {})
status, guarded = call('POST', f'/api/sources/{sid}/apply-update',
                       {'planId': guarded_plan.get('planId'), 'confirm': True, 'replace': True})
check('an edited library copy stops the update', status == 409 and guarded.get('error') == 'local-edit', str(guarded)[:160])
edited = (guarded.get('edited') or [{}])[0]
check('the refusal names the package', edited.get('name') == 'from-checkout', str(edited)[:120])
check('the refusal names the file that changed', any(
    entry.get('file') == 'SKILL.md' and entry.get('state') == 'edited here' for entry in edited.get('changed') or []),
    str(edited.get('changed'))[:160])
check('the edited copy is still there', 'must not be lost' in library_file.read_text(encoding='utf-8'))
check('the source files were not written over it', 'A third rule, upstream' not in library_file.read_text(encoding='utf-8'))

status, forced = call('POST', f'/api/sources/{sid}/apply-update',
                      {'planId': guarded_plan.get('planId'), 'confirm': True, 'replace': True, 'force': True})
check('forcing with the same plan is accepted, so a refusal keeps the plan', status == 200 and forced.get('applied') is True,
      str(forced)[:160])
check('forcing writes the upstream text', 'A third rule, upstream' in library_file.read_text(encoding='utf-8'))
check('forcing is what discards the local note', 'must not be lost' not in library_file.read_text(encoding='utf-8'))
# The forced write became the new baseline, so the same package updates again without a refusal.
status, quiet_plan = call('POST', f'/api/sources/{sid}/plan-update', {})
status, quiet = call('POST', f'/api/sources/{sid}/apply-update',
                     {'planId': quiet_plan.get('planId'), 'confirm': True, 'replace': True})
check('the guard clears once the source rewrote the package', status == 200 and quiet.get('applied') is True,
      str(quiet)[:160])

status, refused = call('POST', '/api/sources', {'path': str(data / 'not-a-repo')})
check('a folder that is not a checkout is refused', status == 400 and refused.get('error') in ('that path does not exist', 'not-a-checkout'), str(refused)[:140])

(data / 'plain').mkdir()
status, refused2 = call('POST', '/api/sources', {'path': str(data / 'plain')})
check('a folder without .git is refused by name', status == 400 and refused2.get('error') == 'not-a-checkout', str(refused2)[:140])

status, deleted = call('DELETE', f'/api/sources/{sid}', {})
check('the source unregisters', status == 200, str(deleted)[:120])

# --- a skills.sh entry --------------------------------------------------------------------------
status, refused_entry = call('POST', '/api/sources', {'kind': 'skillssh', 'repo': 'not a repo'})
check('a skills.sh entry must look like owner/repo', status == 400, str(refused_entry)[:120])

status, entry_source = call('POST', '/api/sources', {'kind': 'skillssh', 'repo': 'vercel-labs/skills/find-skills'})
esid = entry_source.get('source', {}).get('id')
check('a skills.sh entry registers with its skill named',
      status == 200 and entry_source.get('source', {}).get('kind') == 'skillssh'
      and entry_source.get('source', {}).get('repo') == 'vercel-labs/skills/find-skills', str(entry_source)[:160])

status, not_entry = call('GET', f'/api/sources/{esid}/audit')
check('the audit endpoint asks only for a registry entry', status in (200, 502), str(not_entry)[:120])
call('DELETE', f'/api/sources/{esid}', {})

# --- a zip behind a URL -------------------------------------------------------------------------
# The archive is wrapped in one folder, the way a GitHub archive is, so the unwrap is exercised too.
import functools, http.server, socketserver, threading, zipfile

pack = data / 'pack'
(pack / 'pack-main' / 'skills' / 'zip-skill').mkdir(parents=True)
(pack / 'pack-main' / 'skills' / 'zip-skill' / 'SKILL.md').write_text(
    '---\nname: zip-skill\ndescription: A skill that arrives inside a zip.\nversion: 2.0.0\n---\n\n'
    '# From a zip\n\n## Rules\n\n- One rule from the archive.\n', encoding='utf-8')
(pack / 'pack-main' / 'skills' / 'zip-skill' / 'extra.md').write_text('extra\n', encoding='utf-8')
archive = data / 'pack.zip'
with zipfile.ZipFile(archive, 'w') as z:
    for file in sorted(pack.rglob('*')):
        if file.is_file():
            z.write(file, file.relative_to(pack))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

handler = functools.partial(Quiet, directory=str(data))
httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
zip_port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
zip_url = f'http://127.0.0.1:{zip_port}/pack.zip'

status, added = call('POST', '/api/sources', {'kind': 'zip', 'url': zip_url})
zsid = added.get('source', {}).get('id')
check('a zip URL registers without downloading', status == 200 and added.get('source', {}).get('kind') == 'zip', str(added)[:150])

status, bad = call('POST', '/api/sources', {'kind': 'zip', 'url': 'not a url'})
check('a zip source needs an http URL', status == 400, str(bad)[:120])

status, seen = call('POST', f'/api/sources/{zsid}/check', {})
check('checking a zip names its bytes as the commit', status == 200 and len(str(seen.get('commit'))) == 12, str(seen)[:150])
check('the first zip check reports no change', seen.get('changed') is False, str(seen.get('changed')))

status, mapped = call('POST', f'/api/sources/{zsid}/skills', {'skills': ['skills/zip-skill']})
check('a skill inside the archive is mappable', status == 200 and mapped.get('skills') == ['skills/zip-skill'], str(mapped)[:140])

status, zip_plan = call('POST', f'/api/sources/{zsid}/plan-update', {})
check('the plan reads the unpacked tree', status == 200 and zip_plan.get('files', [{}])[0].get('bytes') == 2,
      str(zip_plan.get('files'))[:160])

status, applied = call('POST', f'/api/sources/{zsid}/apply-update',
                       {'planId': zip_plan.get('planId'), 'confirm': True, 'replace': True})
check('a zip replaces into the library', status == 200 and len(applied.get('replaced', [])) == 1, str(applied)[:180])
installed = library / 'zip-skill'
check('the archived package lands with its support file',
      (installed / 'SKILL.md').exists() and (installed / 'extra.md').exists(), str(installed))
check('the archive text is what landed', 'One rule from the archive.' in (installed / 'SKILL.md').read_text(encoding='utf-8'),
      (installed / 'SKILL.md').read_text(encoding='utf-8')[:60])
status, indexed = call('GET', '/api/skills?q=zip-skill')
check('a zip skill is indexed', any(row.get('name') == 'zip-skill' for row in indexed.get('rows', [])), str(indexed)[:140])

# The same URL serving different bytes is a new commit, and nothing is replaced without asking.
with zipfile.ZipFile(archive, 'w') as z:
    for file in sorted(pack.rglob('*')):
        if file.is_file():
            z.write(file, file.relative_to(pack))
(new := pack / 'pack-main' / 'skills' / 'zip-skill' / 'SKILL.md').write_text(
    '---\nname: zip-skill\ndescription: A skill that arrives inside a zip.\nversion: 2.1.0\n---\n\n'
    '# From a zip\n\n## Rules\n\n- The rule the second archive carries.\n', encoding='utf-8')
with zipfile.ZipFile(archive, 'w') as z:
    for file in sorted(pack.rglob('*')):
        if file.is_file():
            z.write(file, file.relative_to(pack))
status, second = call('POST', f'/api/sources/{zsid}/check', {})
check('new archive bytes read as a change', second.get('changed') is True, str(second)[:150])
check('a zip check reaches the new commit', (installed / 'SKILL.md').exists(), str(second.get('commit')))
# --- scheduling, an automatic update, and taking it back -----------------------------------------
def repack(text):
    (pack / 'pack-main' / 'skills' / 'zip-skill' / 'SKILL.md').write_text(
        '---\nname: zip-skill\ndescription: A skill that arrives inside a zip.\nversion: 2.1.0\n---\n\n'
        '# From a zip\n\n## Rules\n\n- ' + text + '\n', encoding='utf-8')
    with zipfile.ZipFile(archive, 'w') as z:
        for file in sorted(pack.rglob('*')):
            if file.is_file():
                z.write(file, file.relative_to(pack))

install_text_a = (installed / 'SKILL.md').read_text(encoding='utf-8')

status, scheduled = call('POST', f'/api/sources/{zsid}/schedule', {'minutes': 1, 'mode': 'notify'})
check('a source takes an interval and a mode', status == 200 and scheduled.get('source', {}).get('check_every_minutes') == 1
      and scheduled.get('source', {}).get('mode') == 'notify', str(scheduled)[:160])

repack('The rule the third archive carries.')
status, notify_tick = call('POST', '/api/sources/tick', {'force': True})
check('a tick checks the source that has an interval', notify_tick.get('checked') == 1, str(notify_tick)[:160])
check('notify mode records the change and applies nothing',
      notify_tick.get('changed') == 1 and notify_tick.get('applied') == 0, str(notify_tick)[:160])
check('notify mode leaves the library alone', (installed / 'SKILL.md').read_text(encoding='utf-8') == install_text_a)

status, auto = call('POST', f'/api/sources/{zsid}/schedule', {'minutes': 1, 'mode': 'auto'})
check('the mode can become automatic', auto.get('source', {}).get('mode') == 'auto', str(auto)[:140])

repack('The rule the fourth archive carries.')
status, auto_tick = call('POST', '/api/sources/tick', {'force': True})
check('an automatic tick applies the update', auto_tick.get('applied') == 1, str(auto_tick)[:200])
auto_text = (installed / 'SKILL.md').read_text(encoding='utf-8')
check('the library carries the archive it was never asked about', 'fourth archive' in auto_text, auto_text[:80])

status, quiet_tick = call('POST', '/api/sources/tick', {'force': True})
check('the next tick finds nothing new', quiet_tick.get('changed') == 0, str(quiet_tick)[:160])

entries = call('GET', '/api/journal?limit=20')[1].get('entries') or []
auto_entry = next((row for row in entries if row.get('action') == 'source-auto'), None)
check('the automatic run is journalled', auto_entry is not None, str(entries[:3])[:160])
replace_entry = next((row for row in entries if row.get('action') == 'source-replace'), None)
check('the replace kept a snapshot of what it overwrote',
      bool((replace_entry or {}).get('payload', {}).get('snapshots')), str((replace_entry or {}).get('payload'))[:200])

status, undone = call('POST', f"/api/journal/{replace_entry.get('id')}/undo", {})
check('an automatic update can be taken back', status == 200 and undone.get('state') == 'undone', str(undone)[:160])
restored_text = (installed / 'SKILL.md').read_text(encoding='utf-8')
check('the previous bytes are back', 'fourth archive' not in restored_text and 'third archive' in restored_text,
      restored_text[:80])

call('POST', f'/api/sources/{zsid}/schedule', {'minutes': 0, 'mode': 'notify'})
status, off_tick = call('POST', '/api/sources/tick', {'force': True})
check('a source switched off is not ticked', off_tick.get('checked') == 0, str(off_tick)[:140])

httpd.shutdown()

status, deleted = call('DELETE', f'/api/sources/{zsid}', {})
check('the zip source unregisters', status == 200, str(deleted)[:120])

print('')
print('sources checks:', 'all passed' if not failures else f'{len(failures)} failed: {failures}')
sys.exit(1 if failures else 0)
PY
