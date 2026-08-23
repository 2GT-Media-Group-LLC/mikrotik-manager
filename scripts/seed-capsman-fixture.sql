-- A representative CAPsMAN deployment for local development.
--
-- Two bugs shipped in v0.23.5 and v0.23.6 because CAPsMAN code was written and
-- "verified" against a fleet that contains no CAPsMAN at all. Neither was catchable
-- by unit tests: both lived in SQL — a join that could not match, and a WHERE clause
-- that filtered out every managed radio before the analysis ran.
--
-- This reproduces the shape of a real deployment (reported on issue #94) so those
-- paths can be exercised locally against the actual endpoints:
--
--   * a controller that is a ROUTER with no radios of its own
--   * CAPs whose own wireless_interfaces rows carry NULL frequency and NULL ssid,
--     because the controller owns the configuration
--   * the controller's local mirror of each CAP interface, which makes a CAP's radio
--     MAC legitimately appear on two devices
--   * channels only in RouterOS's "<freq>/<phy>/<control-positions>" form
--
-- Everything is prefixed `fixture-` and removed by seed-capsman-fixture-clean.sql.

BEGIN;

-- Controller: a router. Deliberately NOT device_type 'wireless_ap', because that
-- misclassification is what hid controllers from the wireless section originally.
INSERT INTO devices (name, ip_address, api_username, api_password_encrypted,
                     device_type, status, model, wifi_role, wifi_package)
VALUES ('fixture-core-rt-001', '10.250.0.1', 'admin', 'x',
        'router', 'online', 'RB5009UPr+S+', 'controller', 'wifi')
ON CONFLICT DO NOTHING;

INSERT INTO devices (name, ip_address, api_username, api_password_encrypted,
                     device_type, status, model, wifi_role, wifi_package)
VALUES ('fixture-hall-ap-001',  '10.250.0.18', 'admin', 'x', 'wireless_ap', 'online', 'cAP ax', 'cap', 'wifi'),
       ('fixture-left-ap-001',  '10.250.0.20', 'admin', 'x', 'wireless_ap', 'online', 'cAP ax', 'cap', 'wifi'),
       ('fixture-right-ap-001', '10.250.0.22', 'admin', 'x', 'wireless_ap', 'online', 'cAP ax', 'cap', 'wifi')
ON CONFLICT DO NOTHING;

-- CAP-side interfaces: no ssid, no frequency, no band. This is what a CAP actually
-- reports, and assuming otherwise is what removed them from Channel Usage.
INSERT INTO wireless_interfaces (device_id, name, ssid, frequency, channel_width, band,
                                 disabled, running, registered_clients, managed_by_capsman,
                                 radio_mac, mac_address, config_json)
SELECT d.id, v.name, NULL, NULL, NULL, NULL, FALSE, TRUE, 0, TRUE, v.mac, v.mac, '{}'::jsonb
FROM (VALUES
  ('fixture-hall-ap-001',  'wifi1', '04:F4:1C:A2:C4:59'),
  ('fixture-hall-ap-001',  'wifi2', '04:F4:1C:A2:C4:5A'),
  ('fixture-left-ap-001',  'wifi1', '04:F4:1C:A3:1E:7B'),
  ('fixture-left-ap-001',  'wifi2', '04:F4:1C:A3:1E:7C'),
  ('fixture-right-ap-001', 'wifi1', '04:F4:1C:A5:0C:0D'),
  ('fixture-right-ap-001', 'wifi2', '04:F4:1C:A5:0C:0E')
) AS v(dev, name, mac)
JOIN devices d ON d.name = v.dev
ON CONFLICT (device_id, name) DO NOTHING;

-- The controller mirrors every CAP interface locally, so each CAP radio MAC appears
-- on two devices. A single-valued MAC index picked whichever row the database
-- returned first, which is how radios ended up attributed to the controller.
INSERT INTO wireless_interfaces (device_id, name, ssid, frequency, channel_width,
                                 disabled, running, registered_clients, managed_by_capsman,
                                 radio_mac, mac_address, config_json)
SELECT d.id, v.name, NULL, NULL, NULL, FALSE, TRUE, 0, FALSE, v.mac, v.mac, '{}'::jsonb
FROM (VALUES
  ('wifi-fixture-hall-2g',  '04:F4:1C:A2:C4:5A'),
  ('wifi-fixture-hall-5g',  '04:F4:1C:A2:C4:59'),
  ('wifi-fixture-left-2g',  '04:F4:1C:A3:1E:7C'),
  ('wifi-fixture-left-5g',  '04:F4:1C:A3:1E:7B'),
  ('wifi-fixture-right-2g', '04:F4:1C:A5:0C:0E'),
  ('wifi-fixture-right-5g', '04:F4:1C:A5:0C:0D')
) AS v(name, mac)
CROSS JOIN devices d
WHERE d.name = 'fixture-core-rt-001'
ON CONFLICT (device_id, name) DO NOTHING;

-- Controller's view of the radios it manages. Channels only in RouterOS form, and
-- deliberately including a partial overlap (2412 vs 2422) plus a co-channel pair
-- (5680 twice) so the interference analysis has something real to classify.
INSERT INTO capsman_radios (controller_device_id, radio_mac, interface_name, local, hw_type,
                            current_channel, matched_device_id, state, registered_peers,
                            authorized_peers, tx_power, ssid, config_json)
SELECT c.id, v.mac, v.iface, FALSE, 'QCA6018', v.chan, a.id, 'running', v.peers, v.peers, 20, v.ssid, '{}'::jsonb
FROM (VALUES
  ('04:F4:1C:A2:C4:5A', 'wifi-fixture-hall-2g',  '2412/ax/Ce',       'fixture-hall-ap-001',  8,  'Sunflower'),
  ('04:F4:1C:A2:C4:59', 'wifi-fixture-hall-5g',  '5680/ax/eCee/D',   'fixture-hall-ap-001',  1,  'Sunflower'),
  ('04:F4:1C:A3:1E:7C', 'wifi-fixture-left-2g',  '2422/ax/Ce',       'fixture-left-ap-001',  5,  'Sunflower'),
  ('04:F4:1C:A3:1E:7B', 'wifi-fixture-left-5g',  '5680/ax/eCee/D',   'fixture-left-ap-001',  7,  'Sunflower'),
  ('04:F4:1C:A5:0C:0E', 'wifi-fixture-right-2g', '2462/ax/Ce',       'fixture-right-ap-001', 3,  'Sunflower'),
  ('04:F4:1C:A5:0C:0D', 'wifi-fixture-right-5g', '5500/ax/Ceeeeeee/D','fixture-right-ap-001', 20, 'Sunflower')
) AS v(mac, iface, chan, cap, peers, ssid)
JOIN devices c ON c.name = 'fixture-core-rt-001'
JOIN devices a ON a.name = v.cap
ON CONFLICT (controller_device_id, radio_mac) DO NOTHING;

INSERT INTO capsman_configurations (controller_device_id, name, ssid, mode, band, security, authentication_types, config_json)
SELECT c.id, v.name, v.ssid, 'ap', v.band, 'public_security', 'wpa2-psk,wpa3-psk', '{}'::jsonb
FROM (VALUES ('public_conf', 'Sunflower', NULL), ('public_conf_2g', 'Sunflower', '2ghz-ax'))
  AS v(name, ssid, band)
JOIN devices c ON c.name = 'fixture-core-rt-001'
ON CONFLICT (controller_device_id, name) DO NOTHING;

INSERT INTO capsman_provisioning (controller_device_id, ros_id, action, master_configuration, disabled, config_json)
SELECT c.id, v.rid, 'create-dynamic-enabled', v.cfg, FALSE, '{}'::jsonb
FROM (VALUES ('*f1', 'public_conf'), ('*f2', 'public_conf_2g')) AS v(rid, cfg)
JOIN devices c ON c.name = 'fixture-core-rt-001'
ON CONFLICT (controller_device_id, ros_id) DO NOTHING;

COMMIT;

SELECT 'seeded' AS status,
       (SELECT count(*) FROM devices WHERE name LIKE 'fixture-%') AS devices,
       (SELECT count(*) FROM capsman_radios) AS radios;
