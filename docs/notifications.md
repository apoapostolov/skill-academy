# Notifications

A list, not a dialog, and not a third table: the scope sits in the sidebar beside Drafts, with a
count, and the rows are the middle column. Everything it shows is read from the two places that
already record it.

| Kind | Where it comes from | What it says |
| --- | --- | --- |
| `source` | `source_events` nobody has acknowledged | an upstream commit or release this library has not applied |
| `auto-blocked` | journal entries with `action = 'source-auto-blocked'` | an automatic update refused because the library copy had been edited |

`GET /api/notifications` answers `{ items, unread }`. A source event is a queue item and can be
acknowledged (`POST /api/sources/events/:id/ack`), which removes it from `items` and drops `unread`.
A journal entry is history, not a queue item: it is listed with `acknowledged: true` and the row has
no button, because there is nothing to clear — dismissing the record would be losing the record.

**An apply acknowledges the events it acted on.** That is deliberate: an update that has been applied
is no longer waiting for a decision. It also means a harness that wants to read the queue has to make
a fresh change first, which `scripts/sources-check.sh` now does.

## Checks

Four checks in `bash scripts/sources-check.sh` (which now runs **76**):

- an upstream change appears as one `source` notification, unacknowledged;
- `unread` equals the number of unacknowledged items;
- acknowledging it answers 200;
- the acknowledged event has left the queue afterwards.

The list itself was verified in the running app: the scope opens, renders `.notifylist`, shows
`0 unread` and "Nothing has happened upstream yet." on a library with no upstream sources, and no
skill rows leak into it.

## Limits

- Nothing polls in the background for the badge: the count updates when the scope is opened or
  refreshed. A source's own schedule is what produces events.
- A notification is not a link: there is no jump from an event to the plan that would resolve it,
  only the Sources button that opens that dialog.
