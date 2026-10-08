# User Manager

[← Documentation index](README.md)

User Manager is RouterOS's RADIUS server. Many networks run it on a CHR or router so
that switches, firewalls and access points (MikroTik or not) authenticate logins against
one place. The **User Manager** page, under Services, shows it for the whole network
(#251).

## Which devices are shown

Every device is checked once a day for User Manager: the `user-manager` package
installed and switched on. Devices without it cost one call a day. A device found running
it gets a **User Manager** badge on its page, linking here. If you've just switched it on,
**Look again now** (shown while no device runs it) checks every device on the next poll,
within five minutes.

With more than one server (two for redundancy, or one per site), a picker at the top
switches between them. The list follows the site selected at the top of the sidebar.

## What it shows

Read live from the server when the page opens, and every minute while it's open. Nothing
it holds is copied into the manager's database.

- **Logged in now:** active sessions: user, the device they logged in through (linked
  when it's a device the manager manages), where from, when, and traffic.
- **Users:** name, group, how many sessions each may have at once, and any attributes set
  on the user itself.
- **Groups:** the RADIUS attributes each group sends, shown as `name value` pairs. These
  are what firewalls and switches authorise on, for example `Cisco-AVPair shell:priv-lvl=15`
  or `PaloAlto-Admin-Role superuser`.
- **Devices that authenticate against it:** each RADIUS client, its address, and whether
  it's a device in the manager (linked) or not.
- **Recent sessions:** the latest 100 that have ended, with why (`user-request`, a session
  limit, a timeout).

**Passwords and secrets never leave the server.** User passwords, OTP secrets and the
shared secrets of the devices are left out of every read, on the backend, whatever
RouterOS returns.

## Clearing a stuck session

A session stays open in User Manager when the device never reports the logout (it
rebooted, or lost contact). For a user allowed only one session, that blocks the next
login. **Clear** on the session removes the record from User Manager. It doesn't log
anyone off the device itself. It needs operator access or above.

## Limits

- Read-only apart from clearing sessions. Adding, disabling or editing users is not
  offered yet.
- Failed logins aren't shown here: User Manager doesn't keep them as session records, only
  in the server's log.
