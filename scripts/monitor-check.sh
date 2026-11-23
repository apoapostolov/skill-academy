#!/usr/bin/env bash
# Versioning: the page the monitor screen reads from, proven without the network.
#
# The check seeds one installation into a scratch data directory, so the repository list, the
# state row and the drift report all have something to show. No GitHub call is made: a check is
# the one part of this feature that needs the network, and it is not what this harness is for.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE" || exit 1

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-monitor.XXXXXX")"
mkdir -p "$ROOT/data" "$ROOT/library/zz-monitored"

cat > "$ROOT/library/zz-monitored/SKILL.md" <<'MD'
---
name: zz-monitored
description: A fixture installed from a repository, so the versioning page has one row.
version: 1.2.0
metadata:
  hermes:
    tags: ["family:fixtures"]
---

# zz-monitored

## Rules

- Read the file before editing it.
MD

cat > "$ROOT/seed.ts" <<'TS'
import { monitorOverview, recordInstallation, unrecordedSkills } from '../../server/src/monitor'

const libraryPath = `${process.env.SKILL_ACADEMY_LIBRARY}/zz-monitored`
recordInstallation({
  repo: 'fixture/repo',
  remotePath: 'skills/zz-monitored',
  ref: '0123456789abcdef0123456789abcdef01234567',
  refKind: 'commit',
  libraryPath,
  channel: 'release',
  agents: [{ agent: 'fixture-agent', mode: 'link', targetPath: '/tmp/agent/zz-monitored' }]
})

const overview = monitorOverview()
const repos = overview.repos ?? []
const rows = repos.flatMap((repo) => repo.installations)
const first = rows[0] ?? {}
console.log(
  JSON.stringify({
    repos: repos.length,
    rows: rows.length,
    repo: first.repo ?? null,
    name: first.name ?? null,
    version: first.version ?? null,
    ref: first.ref ?? null,
    channel: first.policy_channel ?? null,
    state: first.last_state ?? null,
    driftKeys: first.drift ? Object.keys(first.drift).length : 0,
    unrecorded: unrecordedSkills().length
  })
)
TS

# The seed script is written into the fixture root, so its relative import is rewritten to the
# repository it is actually run from.
python3 - "$ROOT/seed.ts" "$HERE" <<'PY'
import sys, pathlib
script = pathlib.Path(sys.argv[1])
here = pathlib.Path(sys.argv[2]).as_posix()
script.write_text(
    script.read_text(encoding='utf-8').replace("'../../server/src/monitor'", f"'{here}/server/src/monitor.ts'"),
    encoding='utf-8', newline='\n')
PY

SKILL_ACADEMY_DATA="$ROOT/data" \
SKILL_ACADEMY_LIBRARY="$ROOT/library" \
npx tsx "$ROOT/seed.ts" > "$ROOT/report.json" 2> "$ROOT/report.err"
status=$?

if [ "$status" -ne 0 ] || [ ! -s "$ROOT/report.json" ]; then
  echo "the seed failed:"
  tail -20 "$ROOT/report.err"
  rm -rf "$ROOT"
  exit 1
fi

python3 - "$ROOT/report.json" <<'PY'
import json, sys

report = json.load(open(sys.argv[1]))
failures = 0

def check(name, ok, detail=''):
    global failures
    print(('PASS  ' if ok else 'FAIL  ') + name + (('  ' + detail) if not ok else ''))
    if not ok:
        failures += 1

check('an installation is recorded', report['rows'] == 1, str(report))
check('it is grouped under its repository', report['repos'] == 1 and report['repo'] == 'fixture/repo', str(report))
check('the row carries the name the list shows', report['name'] == 'zz-monitored', str(report))
check('the row carries the installed version', report['version'] == '1.2.0', str(report))
check('the row carries the installed ref', (report['ref'] or '').startswith('0123456'), str(report))
check('the row carries its channel', report['channel'] == 'release', str(report))
check('an unchecked installation says so instead of claiming a state', report['state'] == 'unknown', str(report))
check('the drift report the pane reads exists', report['driftKeys'] == 3, str(report))

sys.exit(1 if failures else 0)
PY
monitor_status=$?

rm -rf "$ROOT"

echo ""
if [ "$monitor_status" -eq 0 ]; then
  echo "monitor checks: all passed"
  exit 0
fi
echo "monitor checks: failed"
exit 1
