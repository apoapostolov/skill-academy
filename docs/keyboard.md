# Keyboard

The list is the spine. Moving between skills never needs the mouse and never moves the page under
it. `?` shows this map in the app rather than leaving it to be discovered.

| Key | Does |
| --- | --- |
| `j` / `k` | next / previous skill in the list, the detail follows the selection |
| `n` / `p` | next / previous skill that needs attention: issues, high risk, drift |
| `g` `g` / `G` | first / last |
| `Space` / `Shift+Space` | page the detail pane down / up, without changing the selection |
| `o` or `Enter` | open the selected skill's own folder |
| `s` | switch it on or off for the active agent scope |
| `a`, then `a` | archive, two-stage on the same four-second lapse as the button |
| `e` / `x` | enter or leave selection mode / toggle the row's box |
| `Shift+A` | archive the selection |
| `/` | focus search |
| `v` / `w` | preview or raw / wrap |
| `1` - `6` | all / needs attention / notifications / drafts / workspace / trash |
| `S` / `Y` / `P` | sources / sync / appearance |
| `t` | next theme |
| `u` | undo the last journal entry |
| `?` | this map |
| `Escape` | close a menu, close the dialog on top, clear search and return focus to the list |

## What the map guarantees

- **No key fires while focus is in a text field.** Typing a `j` into search types a `j`; the guard is
  on the focused element, so a test has to dispatch on `document.activeElement` to prove it.
- **A dialog owns the keyboard while it is open.** The handler refuses when any `.modal-backdrop` is
  in the document; `Escape` is the exception and closes whatever is on top — a menu first, then the
  dialog behind it. A dialog only some keys can close is a dialog that traps you.
- **A key that acts calls the same function its button calls**, so the journal entry, the undo and the
  snapshot are the same whichever way the action was taken. `u` is the last entry in the journal,
  whatever made it.
- **Two-stage keys obey the same four-second lapse as their buttons.** `a` arms and says so; a second
  `a` inside four seconds archives.
- **Paging does not select.** `Space` scrolls `aside.detail .detail-scroll` and leaves the selection
  where it was. A selector that names the wrong element scrolls nothing and looks exactly like a dead
  key, which is why the wiring is checked by watching the `scrollBy` call rather than by reading
  `scrollTop` on a pane that fits its content.

## Focus is trapped, not merely present

A dialog puts focus on its first control, keeps Tab and Shift+Tab inside it, and returns focus to
whatever had it when it closes (`web/src/dialogFocus.ts`). Before this, opening Appearance left focus
on `body`: Tab walked the rows behind the dialog and Enter activated something nobody could see.

The trap must mount with the dialog. A trap created in a parent component runs once, when the dialog
does not exist yet, and silently does nothing, which is why the key map is its own component.

## How it was checked

Driven in the running app in a real browser, not read off the source:

- `j` selects a row, `j` again moves on, `k` returns, `G` reaches the last, `g g` the first;
- `/` focuses search, and a `j` dispatched **on the focused input** leaves the selection where it was;
- `Escape` clears the field and returns focus to the body;
- `?` opens the map (fifteen rows) and `Escape` closes it;
- `v` flips raw ↔ preview and back; `w` writes `skill-academy.wrap=1`;
- `Space` calls `scrollBy({ top: 666 })` on the detail pane and `Shift+Space` calls `{ top: -666 }`,
  with the selection unchanged;
- `a` once arms the archive, says so, and removes no row — the second press was deliberately never
  made against the live library;
- `Escape` closes the Appearance dialog, and `t` then cycles `slate → carbon` with `--accent`
  following and the choice written to `localStorage`;
- five flows were then run with **trusted** key events only: search focus and Escape, list movement,
  scope switches on the number row (`1`, `3`, `6`), a dialog opened by key then driven by Tab and
  Enter (focusing the Carbon card and applying it), selection mode (`e`, `x`) with the count line
  reading `1/120 selected`, and the map with four Tabs that never leave it.

Enter on a focused button only fires its default action when the dispatched event carries the
carriage return; without it the key event is inert and the test proves nothing.
