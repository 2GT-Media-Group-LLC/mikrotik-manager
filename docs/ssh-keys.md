# SSH keys

[← Documentation index](README.md)

Each device can be given its own SSH keypair, used for backups, config export and bulk
commands instead of a stored password.

## Read this before installing one

**Installing a key disables password SSH for that user.** RouterOS binds the key to the
account and then refuses password authentication entirely — this is RouterOS behaviour,
not a policy choice here, and it is confirmed on hardware: removing the key restores
password login immediately.

Consequences worth stating plainly:

- Colleagues, scripts and other tools that SSH in with a password **will stop working**.
- The **binary API and WinBox are unaffected** and remain a way in.
- **If this server loses its database or `ENCRYPTION_KEY`, the private key goes with it.**
  SSH would then need recovering through the API or WinBox, because the password will
  already have been refused.
- Revoking the key restores password SSH.

On a shared fleet this is a change to announce, not to discover.

## How deployment works

1. A unique **ed25519** keypair is generated on the manager — one per device, never a
   fleet key. A shared key would make any single compromise fleet-wide and would make
   rotating one device impossible without touching all of them.
2. The public half is uploaded over the existing password session and imported.
3. A **completely fresh connection** authenticates with the new key.
4. Only then is anything stored.

Step 4 is the important one. Nothing trusts a key until it has been proved, and a
deployment that fails verification **removes the key it just installed** rather than
leaving a device demanding a credential nobody holds.

## Rotation

Rotation authenticates with the *existing* key, because the password is no longer an
option once a key is installed. The replacement is deployed and proved before the old key
is removed — removing first would leave a window in which neither works.

Each key carries a unique comment, so retiring one cannot remove another.

## Recovery

**The binary API is the recovery path**, not the password. It is unaffected by SSH key
state and can remove a key at any time.

Revoking clears *every* key this manager has installed for a device, not only the one on
record. Orphans left by a half-failed rotation would otherwise keep password SSH disabled
with no way back through the product.

If deployment fails with an authentication error and orphaned keys are present, the error
says so.

## Which login installs the key

The first key is installed by logging in over SSH with a password:

- If the device has an SSH username and password stored, those are used.
- If it has **no SSH login stored**, the API username and password are used, as a pair.
  This is the same fallback backups and bulk commands already use.
- If the SSH username is the API user and no SSH password is stored, the API password is
  used, since it is the same account.
- Anything else, such as a different SSH username with no password, is skipped with a
  reason. The manager never pairs one account's name with another account's password.

Whichever login is used, the key is bound to that user, and that user loses password SSH.

## Fleet-wide deployment

**Settings → SSH Keys** (admins only) installs keys across the site you're viewing,
optionally limited to tags. It shows a preview first:

- how many devices will get a key, how many already have one, and which are skipped and why
- the accounts that will lose password SSH, and on how many devices each

After you tick the confirmation, it runs as a background job, one device at a time, and you
can leave the page. It stops by itself after 5 failures in a row, since that usually means
something fleet-wide is wrong. A device that fails is left as it was. Each device's result is
written to the audit log.

API, all admin-only:

| Method | Path | |
|---|---|---|
| `GET` | `/api/ssh-keys/fleet/preview?tag_ids=1,2` | What a run would do |
| `POST` | `/api/ssh-keys/fleet/jobs` | `{"device_ids": [...], "confirm": true}` |
| `GET` | `/api/ssh-keys/fleet/jobs/:id` | Progress and per-device results |
| `POST` | `/api/ssh-keys/fleet/jobs/:id/cancel` | Stops before the next device |

The older `POST /api/devices/ssh-keys/deploy-all` still works, with the same rules, but it
runs inside one request and times out on large fleets.

## What uses a key

Backups and config export prefer a verified key where one exists and fall back to a
password otherwise. [Bulk commands](commands.md) use the same resolution.

Only a *verified* key is used. One that was generated or pushed but never authenticated is
not evidence the device will accept it.
