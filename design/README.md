# Mockups

Static HTML, no build step, no external assets. Each file is a 1280×800 window at the real density, dark theme with a light override for `prefers-color-scheme: light`. Measurements come from [../docs/ui.md](../docs/ui.md).

| File | Screen | Shows |
|---|---|---|
| [mockup-library.html](mockup-library.html) | Library | Three panes, filter chips, row states (on, off, mixed, pinned, drift, read-only), placement matrix, frontmatter table |
| [mockup-linked.html](mockup-linked.html) | Linked sources | A composite skill: link list, refs tracked, per-link delta, conflicts, provenance, ingest actions |
| [mockup-updates.html](mockup-updates.html) | Updates | Source states, per-skill change list, hash comparison, diff, update actions |
| [mockup-curation.html](mockup-curation.html) | Curation | Dry-run banner, run history, proposed merges and archives, budget |
| [mockup-editor.html](mockup-editor.html) | Authoring | Markdown toolbar, outline, line-numbered editor, live preview, validation, char budget |
| [mockup-compose.html](mockup-compose.html) | Compose | An empty draft with the Sources tab: assigned links, bootstrap ingest, validation warning |
| [mockup-sync.html](mockup-sync.html) | Sync | Profile state, ahead/behind, per-file conflict resolution, secrets scan |
| [mockup-themes.html](mockup-themes.html) | Appearance | Twelve themes as live miniatures, selected state, signal preview |
| [mockup-onboarding.html](mockup-onboarding.html) | First run | Agent detection, shared roots, step progress |
| [mockup-settings.html](mockup-settings.html) | Settings › Providers | Credentials, catalogue, budgets, task bindings |

## What the mockups are not

They are design evidence, not the app. No interaction, no data binding, no accessibility tree. The real implementation must meet the measurements and the state inventory in `docs/ui.md`, which the mockups only sample.
