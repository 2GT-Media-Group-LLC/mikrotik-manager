# Jump hosts

[← Documentation index](README.md)

Some devices can't be reached from the manager at all: they sit on a network behind a router
that can be reached over SSH. A **jump host** is that router. The manager keeps one SSH
connection to it and asks it to open each connection onward to the devices behind it, so those
devices are managed like any other, by their real addresses, with nothing to run on the Docker
host.

Everything the manager does with a device goes through its jump host: the RouterOS API and
API-SSL, backups and config export, bulk commands, packet capture, SSH keys, certificates and the
terminal.

## On the jump router

Allow the SSH server to open connections onward for logged-in users:

```
/ip ssh set forwarding-enabled=local
```

Without it the router refuses, and the manager says so, with this command.

The user the manager logs in as needs nothing beyond SSH access. Devices behind the router see
connections coming from the router's own address, so their API and SSH services (and any
`address=` limits on them) must allow it.

## Adding one

Under **Operations → Credentials → Jump hosts**:

- **Address and SSH port** of the router, as the manager reaches it.
- **Login**: a password, a private key (OpenSSH or PEM, with its passphrase if it has one), or a
  [credential preset](devices.md). A preset's SSH login is used, or its API login when it has none.
- **Host key fingerprint**, optional, as `ssh-keygen -l` prints it (`SHA256:…`) or as hex. Left
  blank, the key the router presents the first time is pinned.
- **Site**: a jump host is either fleet-wide or one site's. A site's jump host is only offered
  for that site's devices, and its admins manage it.

Passwords, keys and passphrases are encrypted with the manager's key, like device passwords. They
are never sent back to the browser, are included in [platform backups](platform-backup.md), and
are re-encrypted when the key is rotated or a backup is restored on another server.

**Test** connects straight away and shows the host key it was given.

To monitor the jump router itself, tick **Also add it as a device**. Once the jump host is saved,
Add Device opens with its name, address, site and login filled in (a private key's username
only: enter the router's password there), connected to directly. Check and change anything
before adding it.

With a site or group chosen in the site selector, the list shows its jump hosts and the
fleet-wide ones, and a new jump host starts in the chosen site.

## Using one

In **Add Device** and **Edit Device**, **Connect via** chooses how a device is reached: directly,
or through one of the jump hosts. The device is checked through that route before it is saved.
The field only appears once there is a jump host.

A site can name a default jump host (edit the site under **Sites**). New devices added to the
site use it unless they choose otherwise, including [adopted](adoption.md) ones; with no default,
an adopted device is reached the way the neighbour it was adopted through is. The default never
changes devices already in the site, so the jump router itself, and anything reachable directly,
stays as it is.

Changing a device's route counts as changing its address, because the same address behind a
different jump host can be a different router. So the same rule applies
([Devices](devices.md)): anyone but a fleet admin has to enter the device's API password, and its
saved passwords stay behind.

## When the jump host is down

**A device behind a jump host is never connected to directly.** If the jump host can't be
reached, refuses the login, or presents a different host key, its devices show as offline with
that as the reason, for example:

> Jump host "branch-gw" (203.0.113.10:22) is unreachable: it did not answer in time

After a failure the manager waits before trying the jump host again: 5 seconds, then 10, 20 and
so on up to 5 minutes. Meanwhile its devices fail straight away with the last error, rather
than each waiting out its own timeout. Editing the jump host, or **Test**, tries again at once.
A jump host that stops answering without closing the connection is noticed within about a
minute. (RouterOS doesn't answer standard SSH keepalives, so the manager checks with a request
RouterOS does answer, and only when nothing else has been heard for 15 seconds.)

If the jump host is up but a device behind it isn't, the error depends on the jump host. A
RouterOS jump router accepts the connection before it tries the device, so the device's error is
the connection closing (`Connection closed`, or a TLS connection closed before it was set up)
when the device refuses it, or the device's usual connect timeout when nothing answers. Other
SSH servers, such as OpenSSH, say what went wrong:

> Jump host "branch-gw" (203.0.113.10:22) could not connect to 10.20.0.5:8729: nothing accepted the connection

and give up after 20 seconds at most, whatever their own timeout.

## Changing one

A new address, port, login or host key closes the jump host's connection, ending the sessions
through it (an open terminal, for example); the next connection uses the new settings. A new
name, site or notes leave it open.

A jump host can move to a site only while no device in another site uses it and no other site
has it as its default; a fleet admin can always make it fleet-wide.

## Host keys

The jump host's SSH host key is pinned, like a device's. A different key stops the connection
before the login is sent, raises an alert, and shows **Key changed** on the jump host with the
new fingerprint. After checking it, for example with
`ssh-keyscan -p 22 203.0.113.10 | ssh-keygen -lf -` from a machine you trust, choose
**Trust new key**.

Changing a jump host's address pins its key afresh, unless a fingerprint is given with the
change.

Devices behind a jump host keep their own pins (API-SSL certificate, SSH host key, serial
number). Pins are kept per address **and route**, so two devices with the same private address
behind different jump hosts don't trip each other's.

## Change Guard

Change Guard's check after a risky change opens a new connection to the device, to prove the
change didn't cut the manager off. Through a jump host that is a new forwarded connection from
the jump router to the device, so the check means the same thing as for a direct device.

The path model sees the manager's connection as coming from the jump router, which is the path
that matters to the device. Changes to the jump router itself are guarded like any other
change, but Change Guard only checks the jump router's API; it does not check that devices
behind it are still reachable.

## Other connections

Switching a device's WebFig to HTTPS (its **Security** tab) checks that WebFig answers before
plain HTTP is turned off ([details](security.md#webfig-over-https)); for a device behind a jump
host, that check goes through it too.

[Platform backups](platform-backup.md) hold jump hosts and each device's route. Restoring one puts
back the routes it holds, including jump hosts deleted since it was taken.

## Limits

- One jump host per device: no chains of jump hosts.
- No SOCKS or HTTP proxies, and no agent forwarding.
- The address a device's page copies for WinBox is still the device's own, which WinBox on your
  computer usually can't reach.
- A jump host in use can't be deleted, and a credential preset a jump host logs in with can't be
  deleted. A device can't be moved to another site while it uses its current site's jump host.
