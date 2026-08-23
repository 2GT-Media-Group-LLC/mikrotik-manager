# Field capture — MikroTik ATL 18 (Quectel EG18-EA, Cat-18)

Contributed by @trackersoft (Bulgaria, VIVACOM) in discussion #85, 2026-08-23.
Two captures: a CLI session, and a WinBox view of the same device carrying four
aggregated carriers.
Sensitive identifiers were redacted by the contributor. RouterOS 7.24 stable, arm64.

Kept verbatim because every LTE parsing decision in `utils/lte.ts` is calibrated
against it. Field *names* here differ from MikroTik's documentation in several
places (`data-class` not `access-technology`, `iccid` not `uicc`, `status: running`
not `connected`), and several documented fields are absent entirely — what a modem
reports depends on the chipset, not on RouterOS.

```
[user@MikroTik-LTE] > /interface/lte/monitor lte1 once
            status: running
             model: EG18-EA
          revision: EG18EAPAR01A14M4G
  current-operator: VIVACOM
    current-cellid: xxxxxx
            enb-id: xxxx
         sector-id: xx
        phy-cellid: xxx
        data-class: LTE
    session-uptime: 3d7h17m59s
              imei: xxxxxxxxxxxxxxx
              imsi: xxxxxxxxxxxxxxx
             iccid: xxxxxxxxxxxxxxxxxxxx
      primary-band: B1@20Mhz earfcn: 500 phy-cellid: 190
           ca-band: B3@20Mhz earfcn: 1800 phy-cellid: 190
     dl-modulation: 256qam
               cqi: 15
                ri: 2
               mcs: 20
              rssi: -69dBm
              rsrp: -97dBm
              rsrq: -9dB
              sinr: 17dB

[user@MikroTik-LTE] > /interface/lte/print detail
Flags: R - RUNNING
0 R default-name="lte1" name="lte1" mtu=1500 advertised-mtu=1500 apn-profiles=default
    allow-roaming=no sms-read=no sms-protocol=auto network-mode=lte band=1,3,7

[user@MikroTik-LTE] > /system/resource/print
   board-name: ATLGM        version: 7.24 (stable)     cpu: ARM64
  free-memory: 157.8MiB   total-memory: 256.0MiB
free-hdd-space: 1160.0KiB  total-hdd-space: 16.0MiB

[user@MikroTik-LTE] > /interface/lte/scan lte1 duration=10
(empty)
```

## Second capture — four aggregated carriers (WinBox)

The same interface at a moment of 4-carrier aggregation. Reproduced here because
it is the case that proves repeated attributes must survive parsing.

```
   Current Operator: VIVACOM
         Data Class: LTE
       Primary Band: B3@20Mhz earfcn: 1800 phy-cellid: 36
            CA Band: B1@20Mhz earfcn: 500 phy-cellid: 36
                     B7@20Mhz earfcn: 3150 phy-cellid: 36
                     B20@10Mhz earfcn: 6300 phy-cellid: 36
     Session Uptime: 00:02:51
               RSSI: -40 dBm      RSRP: -70 dBm
               SINR: 13 dB        RSRQ: -9.0 dB
                CQI: 14            RI: 2        MCS: 0
```

- **`ca-band` repeats once per carrier.** Keeping only the last value yields
  `B3 + B20` — 30 MHz — on a device actually running 70 MHz, and the narrowest
  carrier is the one that arrives last, so the error is severe rather than subtle.
- **`Session Uptime` renders as a clock here** but as `3d7h17m59s` over the CLI,
  so both forms are parsed.
- **`MCS: 0` is a reading, not a blank**, on an otherwise healthy link. It must
  not be treated as missing, and must not feed the quality grade.
- **Uplink rides the primary carrier alone.** Left on automatic this modem anchors
  to whichever band is loudest — often a 10 MHz B20 or B28 — and aggregates the
  wider bands for downlink only, which caps upload. Excluding the narrow bands to
  move the anchor is the contributor's actual reason for locking bands, and the
  reason `uplinkAnchor()` exists.

## Notes that shaped the implementation

- **Units live inside values** (`-69dBm`, `-9dB`, `17dB`), so every signal read strips them.
- **`primary-band` / `ca-band` are composite strings**, not structured fields.
- **The scan returned nothing because the site has one base station**, 10 km away —
  not because the modem cannot scan. Scanning is still not a dependable source: it
  interrupts service and finds nothing at exactly the remote sites that most need a
  band-lock warning. Observed-band history replaces it.
- **`session-uptime` resets on re-registration**, which makes session drops and
  handovers detectable by polling alone — this modem may log nothing.
- RSRP −97 dBm reads as mediocre, yet CQI 15 / RI 2 / 256QAM is the modem at its
  ceiling. Raw RSRP alone misleads; the interpreted view exists because of this.
- 1160 KiB free of 16 MiB flash: a Change Guard restore point cannot be assumed to fit.
