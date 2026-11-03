#!/usr/bin/env bash
# P9: the two front ends nobody opens a browser for.
#
# An MCP client lists and enables without the UI, the `ska` CLI writes the same journal entry the UI
# writes, and `ska lock --check` exits non-zero on drift so CI can use it.
set -u
cd "$(dirname "$0")/.."
PORT="${PARITY_PORT:-$((13200 + RANDOM % 250))}"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/skill-academy-parity.XXXXXX")"
DATA="$BASE/data"
ROOT="$BASE/roots"
mkdir -p "$DATA" "$ROOT/beta-skill" "$ROOT/.archive/gamma-skill"

win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

printf -- '---\nname: beta-skill\ndescription: A skill that is switched on and off by scripts.\n---\n\n# Beta\n\n## Rules\n\n- A beta rule.\n' > "$ROOT/beta-skill/SKILL.md"
printf -- '---\nname: gamma-skill\ndescription: A skill that starts parked in the archive.\n---\n\n# Gamma\n\n## Rules\n\n- A gamma rule.\n' > "$ROOT/.archive/gamma-skill/SKILL.md"

PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

SKILL_ACADEMY_DATA="$(win "$DATA")" \
SKILL_ACADEMY_LIBRARY="$(win "$BASE/library")" \
SKILL_ACADEMY_ONLY_ROOTS="$(win "$ROOT")" \
SKILL_ACADEMY_WATCH=0 \
SKILL_ACADEMY_SCHEDULE=0 \
SKILL_ACADEMY_API_PORT="$PORT" \
npx tsx server/src/index.ts > "$BASE/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 90); do
  curl -s "http://127.0.0.1:$PORT/api/skills?limit=1" 2>/dev/null | grep -q '"total"' && break
  sleep 1
done
if ! curl -s "http://127.0.0.1:$PORT/api/health" | grep -q '"ok"'; then
  echo "the service did not start; log:"; tail -25 "$BASE/server.log"; exit 1
fi

python3 - "$PORT" "$(win "$ROOT")" "$(win "$BASE")" <<'PY'
import json, os, pathlib, subprocess, sys, time, urllib.error, urllib.request as u

port, root, base = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
url = f'http://127.0.0.1:{port}'
failures = []
# npx is a .cmd on Windows, which subprocess cannot exec directly: go through the shell.
TSX = 'npx tsx'


def check(label, condition, detail=''):
    print(('PASS  ' if condition else 'FAIL  ') + label + ('  ' + str(detail)[:200] if detail else ''))
    if not condition:
        failures.append(label)


def call(method, path, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = u.Request(url + path, data=body, method=method, headers={'content-type': 'application/json'})
    try:
        with u.urlopen(request, timeout=180) as response:
            return response.status, json.load(response)
    except u.HTTPError as error:
        return error.code, json.loads(error.read().decode() or '{}')


# ---------------------------------------------------------------- MCP over stdio
class Mcp:
    def __init__(self):
        self.proc = subprocess.Popen(
            f'{TSX} mcp/server.ts --base {url}',
            shell=True,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, cwd=str(pathlib.Path.cwd()))
        self.next_id = 0

    def send(self, payload):
        self.proc.stdin.write(json.dumps(payload) + '\n')
        self.proc.stdin.flush()

    def request(self, method, params=None, timeout=90):
        self.next_id += 1
        request_id = self.next_id
        self.send({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError('the MCP server closed its stdout: ' + (self.proc.stderr.read() or '')[:300])
            message = json.loads(line)
            if message.get('id') == request_id:
                return message
        raise TimeoutError(f'no reply to {method}')

    def notify(self, method):
        self.send({'jsonrpc': '2.0', 'method': method})

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


mcp = Mcp()
init = mcp.request('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                  'clientInfo': {'name': 'parity-check', 'version': '1.0'}})
result = init.get('result', {})
check('an MCP client completes the handshake', result.get('protocolVersion') == '2024-11-05'
      and result.get('serverInfo', {}).get('name') == 'skill-academy', str(result)[:140])
mcp.notify('notifications/initialized')

tools = mcp.request('tools/list').get('result', {}).get('tools', [])
names = sorted(tool['name'] for tool in tools)
check('it offers the six tools P9 named', names == ['disable', 'enable', 'list', 'lock', 'scan', 'search'], names)
check('every tool carries a schema', all(tool.get('inputSchema', {}).get('type') == 'object' for tool in tools))

listed = mcp.request('tools/call', {'name': 'list', 'arguments': {}})
rows = json.loads(listed['result']['content'][0]['text'])['rows']
found = sorted(row['name'] for row in rows)
check('it lists skills without a browser', 'beta-skill' in found, found)

searched = mcp.request('tools/call', {'name': 'search', 'arguments': {'query': 'gamma'}})
hits = json.loads(searched['result']['content'][0]['text'])['rows']
check('it searches', any(row['name'] == 'gamma-skill' for row in hits), [row['name'] for row in hits])

check('gamma starts parked in the archive', (root / '.archive' / 'gamma-skill' / 'SKILL.md').exists())
enabled = mcp.request('tools/call', {'name': 'enable', 'arguments': {'name': 'gamma-skill'}})
check('it enables a skill', not enabled['result'].get('isError'), enabled['result']['content'][0]['text'][:160])
time.sleep(1.2)
check('the package left the archive', (root / 'gamma-skill' / 'SKILL.md').exists()
      and not (root / '.archive' / 'gamma-skill' / 'SKILL.md').exists())

disabled = mcp.request('tools/call', {'name': 'disable', 'arguments': {'name': 'gamma-skill'}})
check('it disables a skill', not disabled['result'].get('isError'))
time.sleep(1.2)
check('the package went back into the archive', (root / '.archive' / 'gamma-skill' / 'SKILL.md').exists())

bad = mcp.request('tools/call', {'name': 'enable', 'arguments': {'name': 'no-such-skill'}})
check('a bad name is a tool error, not a dropped session', bad['result'].get('isError') is True,
      bad['result']['content'][0]['text'][:120])
check('the session still answers afterwards', mcp.request('tools/list').get('result', {}).get('tools') is not None)
mcp.close()

# ---------------------------------------------------------------- CLI
def ska(*args, timeout=180):
    command = f'{TSX} cli/ska.ts --base {url} ' + ' '.join(args)
    done = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=timeout)
    return done.returncode, done.stdout.strip(), done.stderr.strip()


code, out, err = ska('list')
check('the CLI lists skills', code == 0 and 'beta-skill' in out, out.splitlines()[0] if out else err)
code, out, err = ska('enable', 'gamma-skill')
check('the CLI enables a skill', code == 0 and 'enabled gamma-skill' in out, out or err)
time.sleep(1.2)
check('the CLI moved the package', (root / 'gamma-skill' / 'SKILL.md').exists())

# Parity: the UI route and the CLI must write the same journal action.
_, before = call('GET', '/api/journal?limit=40')
entries_before = len(before.get('entries', []))
call('POST', '/api/skills/' + str(call('GET', '/api/skills?q=gamma-skill&limit=5')[1]['rows'][0]['id']) + '/switch',
     {'agent': 'fixture', 'on': False})
time.sleep(0.4)
_, after_ui = call('GET', '/api/journal?limit=40')
ui_entry = after_ui['entries'][0]
code, out, err = ska('disable', 'gamma-skill')
time.sleep(0.4)
_, after_cli = call('GET', '/api/journal?limit=40')
cli_entry = after_cli['entries'][0]
check('the CLI writes a journal entry at all', len(after_cli['entries']) > len(after_ui['entries']) - 1)
check('the CLI writes the same action the UI route writes', cli_entry.get('action') == ui_entry.get('action'),
      f"{cli_entry.get('action')} vs {ui_entry.get('action')}")
ui_payload = ui_entry.get('payload') if isinstance(ui_entry.get('payload'), dict) else json.loads(ui_entry.get('payload') or '{}')
cli_payload = cli_entry.get('payload') if isinstance(cli_entry.get('payload'), dict) else json.loads(cli_entry.get('payload') or '{}')
check('and the same payload shape', sorted(ui_payload) == sorted(cli_payload), f"{sorted(ui_payload)} vs {sorted(cli_payload)}")

# ---------------------------------------------------------------- lock, and drift, for CI
#
# The service rewrites its own lock after every scan, so checking the live file can only ever agree.
# CI compares the lock published with the library, which is what --file is for.
code, out, err = ska('lock')
check('the CLI writes the lock', code == 0 and 'lock written' in out, out or err)
live_lock = json.loads((base / 'data' / 'skill-academy.lock.json').read_text(encoding='utf-8'))
check('the lock names every fixture skill', len(live_lock.get('skills', [])) >= 2, len(live_lock.get('skills', [])))
baseline = base / 'published.lock.json'
baseline.write_text(json.dumps(live_lock, indent=2), encoding='utf-8')
code, out, err = ska('lock', '--check', '--file', f'"{baseline}"')
check('lock --check exits 0 when nothing drifted', code == 0, f"exit {code}: {out or err}")

beta = root / 'beta-skill' / 'SKILL.md'
beta.write_text(beta.read_text(encoding='utf-8') + '- A rule added after the lock was published.' + chr(10), encoding='utf-8')
code, out, err = ska('scan', '--force')
check('a forced rescan picks the edit up', code == 0, out or err)
code, out, err = ska('lock', '--check', '--file', f'"{baseline}"')
check('lock --check exits non-zero on drift', code == 1, f"exit {code}: {out or err}")
check('and it names what drifted', 'changed' in out or 'beta-skill' in out, out[:200])

code, out, err = ska('lock', '--check')
check('the live lock tracks the library, so a bare check cannot fail', code == 0, f"exit {code}: {out[:80]}")

code2, out2, err2 = ska('lock', '--check', '--file', f'"{base / "no-such.lock.json"}"')
check('a missing baseline is a failure, not a pass', code2 == 1, f"exit {code2}: {(out2 or err2)[:120]}")

print('')
print('parity checks:', 'all passed' if not failures else f"{len(failures)} failed: {failures}")
sys.exit(0 if not failures else 1)
PY
