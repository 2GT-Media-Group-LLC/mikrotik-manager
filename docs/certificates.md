# Device certificates

**Operations → Certificates** (fleet admins only) has two tabs: **PKI**, described first, and
[**Reverse proxy**](#reverse-proxy).

The **PKI** tab gives devices certificates from a
certificate authority (CA) of your own, instead of the self-signed certificates RouterOS and
the manager make. Then the manager, your browser, scripts and other tools can all check a
device's certificate properly (#200).

It's optional. Nothing changes on any device until you set up a CA and issue a certificate to
it, one device or a selection at a time.

## Why

Without it, each device's api-ssl and WebFig certificate is self-signed. The manager protects
itself by remembering the certificate a device showed the first time and refusing a different
one later (see [Security](security.md)), but nothing else can tell a real certificate from a
fake one, browsers warn on every visit to WebFig, and a replaced certificate needs someone to
approve it.

With a CA, every enrolled device presents a certificate signed by it for the addresses and
names you use. Install the CA certificate as trusted once, and every device checks out.

## Setting up the CA

Choose one:

- **Create a new CA.** Give it a name, optionally an organisation, and a lifetime of 5, 10 or
  20 years. It can sign device certificates only, not other CAs.
- **Import an existing CA**, for example an intermediate from your organisation's PKI: its
  certificate and private key (PEM, the key optionally encrypted with a passphrase). The
  manager checks it's a CA, that the key matches, and that it hasn't expired. If it has
  *name constraints* you get a warning: RouterOS 7 has been seen refusing to import a CA with
  critical name constraints, and device certificates must fall inside them.

The CA's private key is stored encrypted with the manager's encryption key, like device
passwords, and is included in [platform backups](platform-backup.md). It can't be viewed or
downloaded. **Download CA certificate** gives you the public certificate to install in browsers
and tools.

Trust the CA only where you'd trust the manager itself: whoever holds its key can sign a
certificate for any name.

The CA can be deleted once no device has a certificate from it.

## Defaults

| Setting | Default | |
|---|---|---|
| Lifetime | 1 year | 30 days to 5 years, or any number of days. A certificate never outlives the CA |
| Renew before expiry | 30 days | |
| Renew automatically | On | Checked every 30 minutes; a failed renewal is retried after 6 hours |
| Use for WebFig | On | Can be chosen per device when issuing |

## Issuing a certificate

Choose **Issue** on a device, or tick several and choose **Issue to selected**. You can set the
lifetime, whether WebFig (www-ssl) uses it too, and, for a single device, extra names: DNS
names or other addresses people use to reach it. The device's management address is always
included.

The manager then:

1. Makes a key and certificate. The key is sent to the device once, encrypted with a one-time
   passphrase, and is not kept: renewal makes a new key.
2. Uploads the CA certificate (if the device doesn't have it yet), the device certificate and
   the key. RouterOS 7.9 and later take files over the API. On older RouterOS the manager uses
   SFTP, which needs the device's SSH login. RouterOS deletes the files once imported.
3. Imports them, and checks the certificate arrived with its key.
4. Points api-ssl at the new certificate and **proves it**: a fresh login must work, and the
   device must present exactly the certificate just issued. If not, api-ssl goes back to the
   certificate it had, the new one is removed, and the reason is shown.
5. Points WebFig at it too, if chosen.

A device still managed over the plain API moves to API-SSL in the same step: api-ssl is
enabled on 8729 with the new certificate (and api's allowed addresses, if api-ssl has none).
The move only happens if the login over API-SSL works. If it doesn't, usually because a firewall
or api-ssl's "available from" list lets 8728 in but not 8729, the device stays on the plain API
and nothing changes.

The certificates appear in the device certificate list on the [Security page](security.md) as
well.

## How the manager checks enrolled devices

A device with a certificate from the CA must present that exact certificate, signed by the CA,
before the manager sends its login. Renewals update this automatically, so there's nothing to
approve. Devices without one keep the ordinary first-use pinning.

If an enrolled device presents a different certificate (someone replaced it on the device, or
the device was reset), the manager stops connecting and asks, as it does for any changed
certificate. Trusting the new certificate takes the device out of the CA's list.

## Renewing, changing and removing

- **Renew now** issues a fresh certificate with the same settings.
- **Change** (pencil) reissues with a different lifetime, names or WebFig choice.
- **Remove** puts api-ssl and WebFig back on the certificates they had before (or the manager's
  self-signed one, if the old certificate is gone), proves the login, then deletes the manager's
  certificate and the CA certificate it installed. The device goes back to first-use pinning.
- **Forget** appears if Remove fails: it drops the record without touching the device, for a
  device that was reset or replaced.

If automatic renewal fails, the device shows **Renewal failed** with the reason, an event is
logged, and the **Device certificate renewal failed** alert fires (on by default; see
[Alerting](alerting.md)). The usual certificate-expiry alert also still applies.

## Platform backups

The CA (its certificate and encrypted key), the defaults and the list of enrolled devices are part
of every [platform backup](platform-backup.md), configuration and configuration + database alike.
Restored on another server, the CA key is re-encrypted with that server's key. Device keys
aren't stored anywhere but on the devices, so there's nothing else to back up.

Restoring an older backup can leave the manager remembering an older certificate than a device
now serves: one renewed since, or a device enrolled after the backup was made. The manager
sorts this out by itself on the next connection. A certificate the CA signed, still valid,
whose names cover the device's management address, is accepted and recorded, with an
informational event instead of a changed-identity alert. Anything else is still refused. A
device adopted this way after being enrolled after the backup has no record of what api-ssl used
before, so **Remove** puts it on the manager's self-signed certificate and leaves the CA
certificate on the device.

## Trusting the CA

Install `mikrotik-manager-ca.crt` as a trusted root:

- **macOS:** open it in Keychain Access, add it to the System keychain, and set it to
  *Always Trust*.
- **Windows:** `certutil -addstore -f Root mikrotik-manager-ca.crt`, or double-click it and
  install it into *Trusted Root Certification Authorities*.
- **Linux (Debian/Ubuntu):** copy it to `/usr/local/share/ca-certificates/` and run
  `sudo update-ca-certificates`.
- **Firefox** keeps its own store: Settings → Privacy & Security → Certificates → Import.
- **Scripts:** point the client at the file, for example `curl --cacert mikrotik-manager-ca.crt`,
  or `ssl_context.load_verify_locations('mikrotik-manager-ca.crt')` in Python.

## Reverse proxy

The **Reverse proxy** tab manages RouterOS's reverse proxy (#358). A router answers HTTPS for a host
name, such as `nas.example.com`, and passes the request to a web server behind it over plain HTTP.
Several servers can then share the router's address on port 443 without a NAT rule each. It needs
RouterOS 7.22 or later, and isn't available on SMIPS devices (hAP lite, hAP mini). Point each host
name's DNS at the router.

The tab lists every device in view that has rules, read with the slow poll. For each rule it shows
the web server, the certificate it serves and when that expires. A certificate the manager's CA
issued is marked **CA, renews**. Below come the devices that can use the reverse proxy, with
**Add rule**, and those that can't, and why.

### Rules

A rule has:

| Setting | |
|---|---|
| Host name | The name browsers ask for, matched exactly: RouterOS doesn't match wildcards, so add a rule per name. One enabled rule per name |
| Web server address and port | Where requests go. The router connects over plain HTTP, even to port 443 |
| Certificate | What the router presents for the name. The form lists the device's certificates that name it first |
| VRF | Shown when the device has more than one |

Rules are written under [Change Guard](change-guard.md), and **Review changes** shows the commands
first. Rules RouterOS makes for container apps are shown but not edited: change those in the app.

### Port 443 and WebFig

WebFig over HTTPS (`www-ssl`) also uses port 443 by default. The reverse proxy only listens once it
has an enabled rule, but then one of the two can't. When a rule would cause that, the form asks
which to move and to which port:

- **Move WebFig HTTPS**, to 8443 for example. Proxied addresses stay plain `https://name/`, and the
  manager's **Open** button follows WebFig to its new port.
- **Move the reverse proxy.** WebFig keeps 443, and proxied addresses need the port
  (`https://name:8443/`).

**Ports** on a device's card moves either one at any time, for example WebFig back to 443 after the
last rule is gone. A port another enabled service uses is refused.

### Certificates for rules

Each rule's certificate is one of:

- **A certificate already on the device**, with its private key. It must name the host, directly or
  with a wildcard such as `*.example.com`, or browsers refuse it, so the form won't save one that
  doesn't.
- **One issued by the manager's CA** (fleet admins, once the CA is set up on the PKI tab). The
  manager issues a certificate for the host name and installs it with the CA certificate. Every
  rule for that name then serves it. It's renewed on the CA's settings (**Renew this many days before expiry** and
  **Renew automatically**), like device certificates, and a failed renewal raises the same alert.
  **Renew now** and **Remove** are on the device's card. Remove refuses while a rule still uses
  the certificate. Browsers trust it once the CA certificate is installed on them
  ([Trusting the CA](#trusting-the-ca)).
- **The reverse-proxy service's certificate**, set under IP Services. With none there either,
  HTTPS for the name fails, and the tab says so.

Let's Encrypt (ACME) isn't offered yet.
