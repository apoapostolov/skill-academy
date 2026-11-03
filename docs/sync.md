# Sync

Sync is git over a repository the user owns. The app keeps a checkout under `DATA_DIR/sync`, commits
what the library holds, and pushes it. There is no account and no token stored anywhere: git's own
credential helper does the authenticating, and the app never sees the credential.

## What travels

| Path in the repository | Where it comes from |
| --- | --- |
| `library/` | `LIBRARY_DIR`, minus `.snapshots` and `.skill-academy.json` manifests |
| `drafts/` | `DATA_DIR/drafts` |
| `skill-academy.lock.json` | written fresh by every push |

The database does not travel: `index.db` is a cache of what the files say, and the lock is what
rebuilds it.

## Push

1. The lock is written first, so a push never carries packages without the document that describes
   them.
2. The tree is copied into the checkout and **scanned**. A key-shaped string — an `sk-…` key, a
   GitHub token, a Google API key, a Slack token, an AWS access key id, a private key block, or an
   `api_key = "…"` assignment — stops the push with **409 `secrets-found`**, naming each file and
   line. Nothing is committed, so nothing reaches the remote.
3. `git add -A`, commit, push. A push with no changes reports `pushed: false` rather than inventing
   a commit.

`.gitattributes` sets `* -text` and `core.autocrlf` is off, because a package hash is computed over
bytes: line-ending translation would make two identical skills disagree.

## Pull

A machine with no checkout takes the branch as it is: fetch, check out, copy the tree back over the
library and drafts, then **rebuild the index from the lock that came with it**. That is how a fresh
machine with nothing but the repository ends up with the same skills and the same switches.

A machine that already has a checkout stages its own library first, so a change made here is a
change git can see, and then compares each arriving file with what the last commit had:

- unchanged here → the shared version applies;
- changed here too → **a conflict**: the local copy is written beside the file as
  `<name>.local-<stamp>` (and reported with an absolute path) before the shared version lands.

Nothing resolves itself. The local copy is never overwritten without being saved first, and a pull
that cannot take the branch reports the error instead of forcing it.

## Status

`GET /api/sync` answers whether there is a checkout, which branch and commit it is on, how many
commits are ahead or behind, and whether the tree is clean.

## Checks

`bash scripts/sync-check.sh` runs three servers against one bare repository and **20 checks**: a
machine pushes, a second converges byte for byte, a third with an empty index pulls and finds its
skill in the index again, the same file changed on two machines surfaces as one conflict with both
sides readable, a key-shaped string refuses the push with file and line, and the refused attempt
leaves no commit behind.

## Against real GitHub

The suite runs against a bare directory because it must be offline and fast. `scripts/live-sync-check.sh`
is the other half: it drives two throwaway servers against a real private repository through git's
configured credential helper. It is deliberately not in the suite (network, credentials), and it
writes to one branch per run (`probe-<stamp>`) so it cannot disturb a real branch.

Run on 2026-11-03 against `apoapostolov/skill-academy-sync-probe`, **16 checks, all passed**:

- machine A pushes and GitHub holds the branch the app named (`420d3ef`);
- machine B, empty, pulls it back: the package lands, the bytes are identical, and the lock puts the
  skill back in B's index;
- both machines edit the same file: A's push wins the shared file, B's text is kept beside it as
  `SKILL.md.local-<stamp>`, and one conflict is reported;
- a key-shaped string is refused with `409 secrets-found`, naming `library/alpha-skill/leak.md` line 1,
  and the branch head on GitHub is byte-identical before and after the refusal.

**git never waits on a hidden prompt.** Every git call runs with `GIT_TERMINAL_PROMPT=0`, so a push
whose credential helper has nothing to offer fails and says so instead of hanging behind a prompt
nobody can see.

## Limits

- Deletions travel as files disappearing from the tree, and a pull does not remove a library package
  that the shared tree no longer has; nothing is deleted by a pull.
- A conflict is reported, not merged line by line: the two versions sit side by side and a person
  chooses. There is no three-way text merge and no per-hunk resolution yet.
- Push and pull are manual. A schedule would need the same care as a source's clock, which is not
  built here.
- The app stores no credential of its own; authentication is whatever git's configured helper has.
  A machine with no helper gets `could not read Username`, which is honest but not friendly.
