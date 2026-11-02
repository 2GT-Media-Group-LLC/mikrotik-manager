# Wireless Systems and antenna alignment

**Wireless Systems** is the device category for outdoor PTP/PtMP bridges, directional
radios and CPE. The API/CSV type is `wisp`; CSV also accepts `ptp`, `ptmp` and `cpe`.
The stored type remains `wisp` when the display name changes, preserving existing classifications.
Ordinary indoor wireless access points retain the **Wireless AP** category.

Existing devices keep their type. In **Devices → Edit**, change both bridge ends
to **Wireless Systems (PTP / PtMP / CPE)**. Recognized outdoor models and W60G interfaces
are classified as Wireless Systems when newly adopted; other devices can be classified manually.
Compact type badges and filters use **WS**, with the full name in device forms.
Devices remains a single sidebar link. The category appears in device filters, dashboard, CSV import,
topology and network discovery settings. The shared Wireless pages still cover
all radio equipment and show its device category.

## Use the aligner

1. Add both radios to Manager using their existing RouterOS API/API-SSL login.
2. Set their device type to **Wireless Systems**.
3. Open either device and choose **Antenna aligner**.
4. Optionally select the other managed Wireless Systems device. Choose the interface and peer
   MAC at each end of the intended link. A single interface/peer is selected
   automatically; multiple choices always require a selection. A disconnected
   selected peer is retained rather than replaced with a stronger unrelated link.
5. Adjust the antennas in small steps while watching RX signal, per-chain
   readings/spread, SNR, CCQ, link rates and the signal history. Less negative dBm
   means more received power. These readings assist alignment; they do not replace
   the radio's link budget and operating limits.
6. **Enable tone** gives browser audio whose pitch increases with the weakest
   fresh RX signal. **Reset best** starts a new local history/best measurement.
   Fullscreen is offered when the browser supports it.

The default refresh is one second; 500 ms and two seconds are also available.
Pause, hiding the browser tab, leaving the aligner, or changing the link stops
its requests. Backend connections are shared between viewers, with at most two
samples/second per device, and close after ten idle seconds. At most 16 devices
have alignment sessions at once. No background alignment worker runs.
A live read has a fifteen-second deadline so a slow device cannot keep it open
indefinitely.

An old reading is held for at most three seconds, explicitly marked **Last
reading**, then cleared. Missing readings never improve the best value or drive
the tone; in a paired view both ends must be fresh for a weakest-link reading.
History and best measurements are browser-session data, not stored in InfluxDB.
Selecting a different device/interface/peer starts a new history. Unreported
measurements display an em dash, rather than an invented zero or quality score.
A registered peer without an RX measurement is labelled **Signal unavailable**;
it is not reported as **No link**. Other reported measurements remain visible.

## RouterOS support and access

The implementation uses Manager's native `RouterOSClient` through
`DeviceCollector`, including saved encrypted credentials, its configured API
port, API-SSL certificate pinning and device serial verification. It does not
need the standalone Python application or a second set of credentials.

Supported menu adapters are legacy `/interface/wireless` (including RouterOS 6),
`/interface/wifi`, earlier `/interface/wifiwave2`, and `/interface/w60g`.
Legacy wireless starts with the original standalone tool's plain registration
print, then tries unfiltered stats and detail reads if RX signal is missing.
Partial results are combined by interface and peer MAC; a registration interface
ID is matched to its name. No property filter is used for those legacy reads.
Station and bridge/AP interfaces can use a one-shot monitor when needed.
Monitoring tries the interface name and both supported `once` spellings before
an interface ID, continuing past summaries that contain no RX measurement.
An AP-wide reading is never assigned to several clients: it must identify a
registered MAC or belong to the single known peer. Noise floor and CCQ are not
substitutes for received signal. Permission/transport failures stop retries.
Validate the available telemetry with the device's RouterOS package and version.
W60G stations use their individual monitor; W60G `rssi` is displayed as dBm and
its positive `signal` quality value is displayed separately. Available fields
depend on the RouterOS package/model/version and account permissions.

Only `print` and `monitor ... once` commands are used. The feature never runs a
scan or RouterOS's disruptive `align` mode, and never changes radio settings.
The saved RouterOS account needs API/read access and permission to run monitor
(commonly `read,api,test`). SSH-only devices need their API enabled first.
API-SSL is used when that is the device's configured connection.

`GET /api/wireless/:id/alignment` requires authentication and device/site access
on every request, including cached samples. Viewers may read it. The backend
rejects devices outside the Wireless Systems category and SSH-only radios even if called directly.
Responses contain normalized telemetry only, never radio passwords or raw
configuration. Transport failures discard the session and the next request
reconnects. Unsupported menus are distinguished from permission/connection
failures so an unavailable read is not represented as an empty successful link.

To limit an accidental large read, a snapshot covers at most eight interfaces,
256 registration peers per interface and eight W60G station monitors per
interface. Truncation is shown in the view. This is a live alignment tool, not a
replacement for the normal fleet collector.

The adapters are tested with fixtures; verify telemetry on your actual radios
before relying on a newly supported package/version in the field.

RouterOS references:

- [Wireless registration table](https://manual.mikrotik.com/docs/wireless/abgn/wireless-interface/#registration-table)
- [WiFi registration table](https://help.mikrotik.com/docs/spaces/ROS/pages/224559120/WiFi)
- [W60G monitor and align behavior](https://manual.mikrotik.com/docs/wireless/w60g/)
- [W60G station monitor](https://manual.mikrotik.com/docs/cli-reference/interface/w60g/station/monitor/)
