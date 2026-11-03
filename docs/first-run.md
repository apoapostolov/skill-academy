# First run

An empty library is the one screen where a bare "no skills" line leaves someone with nothing to do.
When there are no skills, no filter is set, and the scope is the whole library, the detail column
carries a panel with the three actions that actually fill it:

- **Scan the folders again** — `POST /api/scan?force=1`, then reload the state;
- **Add a source** — opens the Sources dialog (a repository, a checkout, a zip or a skills.sh entry);
- **Write a draft** — switches to the Drafts scope.

The panel says what a skill is (`a folder with a SKILL.md in it`) because that is the piece of
knowledge a new user is missing, and nothing else.

The list's own empty state changes with it: on a library with no skills it reads "No skills yet. The
panel on the right says where they come from", and only a real filter produces "Nothing matches.
Clear the filter or scan." An empty library is a state, not a failed search.

## Reduced motion

`@media (prefers-reduced-motion: reduce)` sets every animation and transition to 0.001 ms and turns
off smooth scrolling. It is a preference, not a decoration, and it is checked by looking for the
block in the shipped stylesheet rather than trusting the source.

## How it was checked

Against a throwaway server on port 10009 with an empty data directory and an empty agent root, in a
real browser: zero rows, the panel present, its title and all three actions rendered with their
labels, the note in place, the reduced-motion block present in the loaded stylesheet, and the list's
own empty state reading as a first run rather than as a filter that matched nothing. The live library
(652 skills) never shows the panel, which is the other half of the check.
