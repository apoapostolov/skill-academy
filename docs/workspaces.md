# Workspaces

A workspace is a folder that keeps skills of its own: a project, a fork, a branch of ideas that has
not earned a place in the library yet. The library is the canonical store; a workspace is a second
copy the author controls.

## The screen

The sidebar carries a **Workspaces** section under Deleted and Drafts. A field at the bottom of the
section takes any absolute path; **Add** registers it and opens it. The `×` on a row unregisters the
workspace — it forgets the path and leaves the folder alone.

Opening a workspace replaces the middle column with its skills, each carrying one state:

| State | Meaning |
| --- | --- |
| `same` | the library holds this package, byte for byte |
| `differs` | both have the skill, and the `SKILL.md` hashes differ |
| `library lacks it` | only the workspace has it |

The comparison reads `skills/`, `.claude/skills/` and `.agents/skills/` inside the workspace, in that
order, and hashes each `SKILL.md`. The library side is read from `LIBRARY_DIR/<name>` on disk, falling
back to the index row, so a package that was just promoted is compared as a file rather than as a
stale search result.

The header count is the comparison's total, not the library's. The library's `Installed`/`Archived`
filters are not drawn here: they describe a different list.

## Promoting into the library

Selecting a row opens the detail pane with both hashes, the library path, and one action:

- `same` — the button reads **Already in the library** and is disabled;
- `differs` — **Promote to library** asks first, then **Replace**; the current package is copied to
  `DATA_DIR/library/.snapshots/<name>-<stamp>` before anything is overwritten;
- `library lacks it` — **Promote to library** creates the package.

The promotion is a copy, never a move: the workspace keeps working. The `.skill-academy.json`
manifest an import writes is removed from the library package, because it describes a copy inside a
workspace.

The package is indexed in the same request (`parseSkill` + `saveOne`), so it answers a search
immediately; the library is not a scanned root, so there is no library scan to wait for.

`Bash scripts/workspaces-check.sh` proves the path: register, compare, promote, refuse an unchanged
copy, refuse an overwrite without `replace`, replace with a snapshot, index, and undo — 28 checks.

## Undo

`workspace-promote` is journalled with the snapshot path. `POST /api/journal/:id/undo` removes the
created package, or puts the snapshot back and deletes it, then rescans once. Undo is a point in
time, as everywhere else in this app.

## Importing the other way

`POST /api/workspaces/:id/import` copies a library skill into the workspace with a manifest naming
where it came from. That direction predates this screen and has no button yet; the row context menu
on a library skill is where it belongs.

## Known limits

- A workspace root is not scanned as a library root, so its skills do not appear under **All skills**
  until they are promoted. That is deliberate: the workspace is a shelf, not the library.
- Adding a path that does not exist answers 400; nothing is created for you.
- Deleting a workspace from the screen unregisters it. The files are yours to remove.
