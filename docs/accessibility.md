# Accessibility

## What was audited

Every interactive control on the four surfaces that matter — the main screen, **Appearance**,
**Sync**, **Sources**, and the keyboard map — was walked in the running app and asked for an
accessible name: `aria-label`, `aria-labelledby`, `title`, its own text, an associated `<label>`, or
a wrapping label.

| Surface | Visible controls | Without a name |
| --- | --- | --- |
| Main screen | 222 | 0 |
| Appearance | 235 | 0 |
| Sync | 228 | 0 |
| Sources | 229 | 0 |
| Keyboard map | 223 | 0 |

**A placeholder is not a name.** Two fields relied on one — the search box and the workspace folder
input — and both now carry an explicit `aria-label` (`Search skills`, `Workspace folder`), because a
screen reader may skip a placeholder entirely and announce an unnamed edit field instead.

## How it was checked

The audit walks `button, input, select, textarea, a[href], [role="switch"], [tabindex]`, skips what
is not rendered, and reports the HTML of anything with no name. It runs against the live app, not
against the source: a control that is created by a dialog is only audited when that dialog is open,
which is why each one was opened first.

## Not done

- No automated a11y check runs in the suite yet: it needs a browser, which the shell harnesses do not
  have. The audit is a recorded run, not a gate, and that is a weaker guarantee than the contrast
  gate, which is arithmetic.
- Focus trapping is implemented for Appearance, Sync and the key map (`web/src/dialogFocus.ts`) and
  checked by driving Tab in the running app. The remaining dialogs (Sources, Versioning, the review
  and install dialogs) still let Tab escape into the page behind them.
- Alt text on generated artwork and reduced-motion support are unchecked.
