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

## Passwords and keys

By default RouterOS v7 also leaves out Wi-Fi keys, VPN and PPP secrets, WireGuard private
keys and SNMP communities, so a restore brings back the configuration without them.

**Settings → General → Include passwords and keys in backups** (admins only, off by default)
adds them, using `/export compact show-sensitive`. A backup that holds them:

- is **encrypted on disk** with `ENCRYPTION_KEY`, the same key that protects device logins
- is marked **secrets** in the Backups list
- can be **previewed, compared and downloaded only by admins**; the download is the readable
  `.rsc`, decrypted
- can still be **restored by operators**, since restoring sends the secrets back to the device
  without showing them to anyone

Config History snapshots never include secrets, because their text is kept in the database
and shown in diffs.

RouterOS v6 is the other way round: its `/export` includes secrets unless told
`hide-sensitive`. v6 devices now follow the same setting as v7: with it off, backups and
snapshots use `/export compact hide-sensitive`; with it on, backups carry the secrets and are
encrypted and admin-only. Until 0.24.35, v6 snapshots kept secrets in Config History. Those
older snapshots are now admin-only.

A device whose RouterOS version hasn't been read yet (before its first poll) is treated as
possibly v6: its backups are marked as holding secrets, and no snapshot is taken until the
version is known.

!!! warning "Keep ENCRYPTION_KEY safe"
    An encrypted backup can only be read with the key it was written under (or an older key
    still configured for rotation). Lose the key and those backups can't be read.

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

Restore (and Config History's rollback) uploads the `.rsc` and runs it with `/import`.
This is a real configuration change with all the risk that implies, so it runs under
[Change Guard](change-guard.md): if the device stops responding during the import, it
puts its previous configuration back by itself. It signs in with the device's SSH key
when one is deployed.

**Know what `/import` does before relying on it.** It replays the backup's commands onto
the *running* configuration, one line at a time, and stops at the first one that fails.
A full backup starts by creating things (`/interface bridge add name=bridge`), and on a
device that still has them the very first `add` fails. So on a working device, a restore
usually changes nothing. It is most useful on a device that has been reset, or for a
backup trimmed down to the part you want back.

The result tells you exactly what happened:

| Result | Meaning |
|---|---|
| **Restored** | RouterOS ran every line, and the device was confirmed reachable afterwards |
| **Nothing was changed** | It stopped before running any command, and the message gives the line and reason |
| **Partly restored** | It ran some commands, then stopped at the line given. The device now has a mix of the backup and its previous configuration |
| **Restoring itself** | The device stopped responding, so Change Guard is putting the previous configuration back |

`/import` exits successfully even when it fails, so before 0.24.36 every restore reported
success. Each restore also uploads under a name of its own and deletes the file afterwards,
since a backup can hold secrets.

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
