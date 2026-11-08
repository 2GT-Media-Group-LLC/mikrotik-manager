# Sessions

**Security → Sessions** lists connections, one row each, built from NetFlow. It reads like the
traffic log on a Palo Alto or Check Point firewall. Each row shows:

- when the connection started and ended, and which router saw it
- the client and the server, with ports, the client's name when MikroTik Manager knows it, and
  the addresses NAT changed
- protocol and application
- bytes and packets each way
- how it ended

It complements [Firewall logs](firewall-events.md). A firewall log line is one packet that a
logging rule matched, often a drop. A session is a whole connection the router saw, from the
first packet to the last, whether or not any rule logs it.

## Turning it on

Sessions build on [Traffic analytics](traffic.md), so the router has to export NetFlow to
MikroTik Manager first. Then, on **Network Services → NetFlow**, turn on **Sessions** for each
router you want recorded. Nothing changes on the router; MikroTik Manager just keeps more of
what the router already sends. Operators and admins can turn it on in their sites.

A busy router can make many sessions a second, so it starts off. Sessions are kept for **3
days** (`retention_sessions_days`, under **Settings → Data Retention**).

## How a session is put together

RouterOS sends each direction of a connection as its own flow record. A long connection also
gets a new pair every active timeout, which MikroTik Manager sets to one minute. Sessions pairs
the two directions, adds each minute to the same row, and orients the row from client to
server:

- **Through NAT.** The record going out through masquerade carries the client's public address,
  and the record coming back carries the client. Both become one session, with the public
  address shown under the client as **NAT**. A port forward works the same way, with the
  address the client dialled shown under the server as **via**.
- **Client and server.** A known service port (443, 53, 22) marks the server, then a port under
  1024, then one below the ephemeral range. When ports don't settle it, the side that sent
  first is the client. A TCP SYN with no reply is always the client's.
- **Long connections.** A row appears about 10 seconds after the first minute's records arrive,
  and its end time, bytes and ending are updated each minute after that.

## How it ended

| Shown | Means |
|---|---|
| **Closed** | A TCP FIN: the connection closed normally |
| **Reset by client** / **Reset by server** | A TCP RST from that side |
| **No reply** | Traffic went one way only: nothing answered, or it was a broadcast |
| **Aged out** | It went quiet without a close: an idle timeout, or a long connection that is still open |

Hover over the ending to see the TCP flags each side sent.

## Filters

Address (matches the client, the server, or either NAT address, so a public address finds the
client behind masquerade), port, protocol, ending, device and time range. Click any address in
the table to filter by it.

## Routers behind NAT

When NAT sits between the routers and MikroTik Manager, every router's flows arrive from the
same address (see [Flows from unidentified exporters](traffic.md#flows-from-unidentified-exporters)).
MikroTik Manager still tells them apart by when each one booted: every NetFlow packet carries
that time, and polling records it for each device. So each router's own **Sessions** switch
applies, and its traffic is also counted under its name on the NetFlow page.

Two routers that booted within 10 seconds of each other, after a power cut for instance, can't
be told apart. For those there is **Keep sessions from unidentified exporters**. Their
sessions show under the source address instead of a device name, and only with all sites
selected.

## Limits

- No rule. RouterOS doesn't tell NetFlow which firewall rule passed a connection, so sessions
  have no rule tag. Use [Firewall logs](firewall-events.md#which-rule-logged-it) for that.
- Sampling. With NetFlow sampling on, byte counts are a sample.
- Load. The collector writes at most 5,000 sessions every 5 seconds. Past that, sessions are
  counted as dropped on the NetFlow page rather than kept.
