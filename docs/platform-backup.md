# Backing up MikroTik Manager

**Settings → Backup & Restore** (admins only) backs up MikroTik Manager itself, so you can
restore it after a mistake or move it to a new server. This is separate from
[device backups](backups.md), which back up your routers and switches.

## What a backup holds

You choose one of two kinds each time, and for the schedule:

| Kind | Holds | Size |
|---|---|---|
| **Configuration** | Devices and their stored logins, sites, users and roles, API tokens, settings, alert rules and channels, webhooks, report schedules, maintenance windows, command and config templates, secrets, tags, firmware mirrors, dismissed findings, the [device certificate](certificates.md) CA and enrolments, and topology layout | Small |
| **Configuration + database** | Everything in the database, history included: events, clients, change history, outages, audit log and so on | Larger, depending on retention |

A configuration + database backup can still be restored as configuration only.

Neither kind includes:

- **Device config backups.** The files live on the `backups_data` volume and would make
  every platform backup as big as all of them together. A configuration + database backup
  holds the list of them, so copy that volume across too when you move servers and they
  come back as they were.
- **Metrics.** The InfluxDB time series (interface graphs, resource history) aren't
  included. They rebuild as the poller runs.
- **The TLS certificate.** It's on the `certs_data` volume; install it again on a new server.

## Encryption and the passphrase

Every backup is encrypted with a passphrase of at least 12 characters (AES-256-GCM, with
the key derived by scrypt). The backup also holds the manager's encryption key, so stored
device logins, SMTP passwords and other secrets restore on any server, not just the one
that made it.

That makes the passphrase the only thing protecting those logins. Choose a long one, and
keep it somewhere other than the server: **a backup can't be opened without it, and there
is no recovery.**

A wrong passphrase is refused straight away. A damaged or altered file fails the restore
with nothing changed.

## Backing up now

Choose the kind, give a passphrase (or use the schedule's saved one), tick any
destinations to copy it to, and click **Back up now**. The backup runs in the background
and appears in the list when it's finished. Download it from the list with the download
button.

## The schedule

Turn on **Back up automatically** and choose:

- **How often**: daily, weekly (on a chosen day) or monthly (on a day from 1 to 28).
- **Time**: in the app's time zone (Settings → General).
- **What**: configuration, or configuration + database.
- **Keep**: how many backups stay on this server. Older ones are deleted after each
  backup. This counts manual and scheduled backups together.
- **Send to**: destinations to copy each backup to.
- **Passphrase**: saved encrypted on the server so the schedule can run unattended.

If a scheduled backup fails, or a destination refuses it, the **Platform backup failed**
alert fires (on by default; see [Alerting](alerting.md)).

## Destinations

Every backup is kept on this server, in the `backups_data` volume. A backup on the same
server doesn't survive losing the server, so add at least one destination that's
somewhere else. Each one has its own **Keep** count, and **Test** writes and removes a
small file to prove the settings work.

| Type | Settings | Notes |
|---|---|---|
| **S3-compatible** | Endpoint, region, bucket, optional folder, access key, secret key | AWS S3, Backblaze B2, Wasabi, Cloudflare R2, MinIO. Turn on **path-style addressing** for MinIO and most self-hosted storage |
| **SFTP** | Host, port, username, folder, password or private key | The server's host key is saved the first time it connects, and uploads are refused if it changes. If the server really changed, edit the destination, click **Forget it** next to the saved key, and test again |
| **Email** | An email alert channel to send with, and recipients | Uses that channel's SMTP server, with TLS certificates checked. Backups over 20 MB are refused, so use email for configuration backups and S3 or SFTP for the database |

For S3, the access key needs permission to put, list and delete objects in the bucket.
Old backups are only removed from files named `mtm-backup-…`, so a shared bucket or folder
is safe.

## Restoring

Restore a backup from the list, or click **Restore from a file…** to upload one (for
example on a new server). Enter the passphrase, click **Check passphrase**, choose what to
restore, and type `RESTORE` to confirm.

| Mode | What happens |
|---|---|
| **Configuration only** | Devices, users, settings and the rest of the setup are replaced with the backup's. History is kept for devices that are in the backup. Devices that aren't in the backup are removed, with their history |
| **Everything** | The whole database is replaced with the backup, history included. Only for configuration + database backups. Use this to move MikroTik Manager to a new server |

Then:

1. The current state is backed up first, with the passphrase you entered, so you can go
   back. These show as **Pre restore** in the list; the last three are kept.
2. MikroTik Manager pauses: the API answers "restoring" and polling stops.
3. The backup is restored in one database transaction. If anything goes wrong, nothing is
   changed.
4. Stored secrets are re-encrypted with this server's key.
5. MikroTik Manager restarts and everyone signs in again.

A restore leaves these as they are on this server: the platform backup schedule,
destinations and backup list, the device config backup files and metrics.

A backup made by a newer version of MikroTik Manager can't be restored. Update first. A
backup from an older version restores fine.

### Moving to a new server

1. On the old server, make a **Configuration + database** backup and download it.
2. Install MikroTik Manager on the new server, sign in with the first-run admin account,
   and change its password when asked. The restore replaces that account anyway.
3. Go to **Settings → Backup & Restore**, click **Restore from a file…**, and restore with
   **Everything**.
4. Sign in with your usual account. Users, devices and settings are as they were.
5. Copy the `backups_data` volume across too if you want the device config backups, and
   install your TLS certificate if you used your own.

The new server can keep its own encryption key; restored secrets are re-encrypted with it.

## Backing up by hand

To back up without the UI, keep these:

| What | Where |
|---|---|
| The database | `docker compose exec postgres pg_dump -U mikrotik mikrotik_manager` |
| The encryption key | `app_data` volume (`secrets.json`), or your `ENCRYPTION_KEY` |
| Device backups | `backups_data` volume |
| TLS certificate | `certs_data` volume |

Store the key **separately** from the database dump. Together they give anyone the admin
passwords of every managed device; apart, neither does. To restore, bring back all four,
with the key in place before the manager's first start.
