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

## Fleet-wide deployment

`POST /api/devices/ssh-keys/deploy-all` keys every device that has a password but no
verified key. It runs sequentially rather than in parallel — each deployment opens two SSH
sessions and ends by proving the key.

It **refuses without explicit confirmation**, because it disables password SSH on every
device it touches.

## What uses a key

Backups and config export prefer a verified key where one exists and fall back to a
password otherwise. [Bulk commands](commands.md) use the same resolution.

Only a *verified* key is used. One that was generated or pushed but never authenticated is
not evidence the device will accept it.
