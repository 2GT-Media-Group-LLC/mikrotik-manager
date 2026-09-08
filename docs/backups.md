# Backups

[← Documentation index](README.md)

Configuration backups for every device, on demand or on a schedule, with the tools to
find, read and compare them.

## What a backup actually is

`/export compact` run over SSH, stored as a `.rsc` file — **plain RouterOS script, not
the binary `.backup` blob**.

That distinction shapes everything else on this page. A `.rsc` can be read, diffed,
edited and applied selectively; a `.backup` can only be restored wholesale onto the
same device. It also means a backup is human-readable text, which is why previewing
and comparing them is possible at all.

It also means a backup does **not** capture things `/export` omits: user passwords,
certificates and files on disk. A `.rsc` restores a configuration, not a device.

## Finding one

The table filters by **device**, **type**, a **date range** and free text across
device name, filename and notes. Date ranges include both ends — "to: 3 September"
covers everything that happened on the 3rd.

Types:

| Type | Created by |
|---|---|
| `manual` | The Create Backup button |
| `scheduled` | The daily/weekly/monthly schedule |
| `pre-upgrade` | A firmware rollout, before it touches the device |
| `config-snapshot` | Config History, when it captures a change |

## Reading and comparing

Click any row to read the backup in place. Select exactly two and choose **Compare**
for a line diff — the same diff Config History uses for snapshots.

The comparison is always ordered oldest to newest regardless of the order you clicked,
so additions read as additions.

The **filename** is not a column in the table; it appears in the preview and diff
headers instead. It is a device name and a timestamp — useful when you are looking at
a specific file or quoting it to someone, less useful as a column competing for width
with the device and date you actually filter on.

## Deleting, and the one thing to know first

A backup and its Config History snapshot are **one artifact**. They are joined in the
database with `ON DELETE CASCADE` precisely so they cannot drift apart — a snapshot
whose restorable `.rsc` had been deleted would offer a rollback it could not perform.

So deleting a `config-snapshot` backup also removes that snapshot from the device's
Config History, and the ability to roll back to it.

Single deletes of a snapshot-linked backup ask for confirmation and say this plainly.
**Bulk delete** does the same, but with the numbers: it reports how many backups per
device will go, and how many Config History snapshots will go with them, before you
confirm. There is no undo.

Bulk delete is capped at 200 per action and is scoped to the [current site](sites.md),
so it cannot reach into another site's history.

## Restoring

Restore uploads the `.rsc` and applies it. This is a real configuration change with
all the risk that implies — read the backup first if you are not certain what is in
it, which is what the preview is for.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/backups` | List, with `deviceId`, `type`, `from`, `to`, `search` |
| `GET` | `/api/backups/types` | Types present, with counts |
| `POST` | `/api/backups` | Create one for a device |
| `GET` | `/api/backups/:id/content` | Read the text (capped at 2 MB) |
| `GET` | `/api/backups/:from/diff/:to` | Both texts, for a client-side diff |
| `GET` | `/api/backups/:id/download` | Download the `.rsc` |
| `POST` | `/api/backups/:id/restore` | Apply it to the device |
| `DELETE` | `/api/backups/:id` | Delete one |
| `GET` | `/api/backups/bulk-delete/preview` | What a bulk delete would remove |
| `POST` | `/api/backups/bulk-delete` | Delete many |
