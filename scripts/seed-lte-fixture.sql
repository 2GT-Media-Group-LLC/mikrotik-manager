-- A cellular device for local development, reproducing a real field capture.
--
-- The fleet this platform is developed against contains no LTE hardware at all
-- (49 ethernet interfaces, 7 wifi, zero cellular), which is exactly the position
-- CAPsMAN support was written from before two bugs shipped. This seeds the shape
-- of a real modem so the LTE paths can be exercised against actual endpoints.
--
-- Values come from a MikroTik ATL 18 (Quectel EG18-EA, Cat-18) on VIVACOM,
-- contributed by @trackersoft in discussion #85. See
-- backend/src/utils/__tests__/fixtures/lte-atl18.md for the raw capture.
--
-- What makes this shape worth reproducing:
--
--   * RSRP −97 dBm — "fair" on its own — on a link running 256QAM at CQI 15 with
--     two spatial streams, which is the modem at its ceiling. Any UI that grades
--     on RSRP alone gets this device visibly wrong.
--   * a primary carrier plus an aggregated one, so carrier-aggregation rendering
--     is exercised rather than assumed
--   * a configured band allow-list (1,3,7) that is wider than the bands actually
--     observed, which is the state a band-lock warning has to reason about
--   * tower movement history, which cannot be recovered after the fact
--
-- Everything is prefixed `fixture-` and removed by seed-lte-fixture-clean.sql.

BEGIN;

-- A cellular CPE. Deliberately device_type 'router': cellular is a property of
-- the hardware, and gating the LTE tab on device_type would hide it here.
INSERT INTO devices (name, ip_address, api_username, api_password_encrypted,
                     device_type, status, model, has_lte)
VALUES ('fixture-lte-cpe-001', '10.251.0.1', 'admin', 'x',
        'router', 'online', 'ATL18', TRUE)
ON CONFLICT DO NOTHING;

-- The interface row is what collectLte keys off, so the modem is only contacted
-- on devices that actually have one.
INSERT INTO interfaces (device_id, name, type, mtu, running, disabled, updated_at)
SELECT id, 'lte1', 'lte', 1500, TRUE, FALSE, NOW()
  FROM devices WHERE name = 'fixture-lte-cpe-001'
ON CONFLICT (device_id, name) DO UPDATE SET type = 'lte', running = TRUE;

-- Current state, verbatim from the capture.
INSERT INTO lte_interfaces (
  device_id, interface_name, status, data_class, modem_model, modem_revision,
  operator, cell_id, enb_id, sector_id, phy_cell_id, session_uptime_s,
  primary_band, ca_bands, rssi, rsrp, rsrq, sinr, cqi, rank_indicator, mcs,
  dl_modulation, quality, allowed_bands, network_mode, apn_profiles,
  allow_roaming, updated_at)
SELECT id, 'lte1', 'running', 'LTE', 'EG18-EA', 'EG18EAPAR01A14M4G',
       'VIVACOM', '123456', '1234', '12', '190', 285479,
       '{"band":1,"bandwidthMhz":20,"earfcn":500,"phyCellId":190,
         "raw":"B1@20Mhz earfcn: 500 phy-cellid: 190"}'::jsonb,
       '[{"band":3,"bandwidthMhz":20,"earfcn":1800,"phyCellId":190,
          "raw":"B3@20Mhz earfcn: 1800 phy-cellid: 190"}]'::jsonb,
       -69, -97, -9, 17, 15, 2, 20,
       '256qam', 'good', '1,3,7', 'lte', 'default', FALSE, NOW()
  FROM devices WHERE name = 'fixture-lte-cpe-001'
ON CONFLICT (device_id, interface_name) DO UPDATE SET updated_at = NOW();

-- Bands seen serving this device. Note B7 is *allowed* but has never been
-- observed — locking to it is the case a future pre-flight has to catch.
INSERT INTO lte_observed_bands (device_id, interface_name, band, observations, first_seen, last_seen)
SELECT d.id, 'lte1', b.band, b.n, NOW() - INTERVAL '6 days', NOW()
  FROM devices d, (VALUES (1, 4120), (3, 3980)) AS b(band, n)
 WHERE d.name = 'fixture-lte-cpe-001'
ON CONFLICT (device_id, interface_name, band) DO NOTHING;

-- Movement over the last day: a handover, a re-registration, and an aggregated
-- carrier dropping away and returning.
INSERT INTO lte_cell_history (device_id, interface_name, at, kind, detail, cell_id, enb_id, bands, rsrp, sinr)
SELECT d.id, 'lte1', NOW() - h.ago, h.kind, h.detail, h.cell, '1234', h.bands, h.rsrp, h.sinr
  FROM devices d, (VALUES
    (INTERVAL '35 minutes', 'band-change',   'Bands changed from 1 to 1,3',        '123456', '1,3', -97::real, 17::real),
    (INTERVAL '2 hours',    'band-change',   'Bands changed from 1,3 to 1',        '123456', '1',   -101::real, 12::real),
    (INTERVAL '7 hours',    'handover',      'Cell changed from 998877 to 123456', '123456', '1,3', -95::real, 18::real),
    (INTERVAL '7 hours',    'session-reset', 'Session restarted — uptime fell from 210433s to 12s',
                                                                                   '998877', '1',   -104::real, 9::real),
    (INTERVAL '19 hours',   'handover',      'Cell changed from 123456 to 998877', '998877', '1',   -103::real, 10::real)
  ) AS h(ago, kind, detail, cell, bands, rsrp, sinr)
 WHERE d.name = 'fixture-lte-cpe-001';

COMMIT;

SELECT 'seeded' AS status,
       (SELECT count(*) FROM lte_interfaces)    AS lte_interfaces,
       (SELECT count(*) FROM lte_cell_history)  AS history_rows,
       (SELECT count(*) FROM lte_observed_bands) AS observed_bands;
