-- Remove everything seed-capsman-fixture.sql created. Devices cascade to their
-- wireless_interfaces and capsman_* rows.
--
-- Only the CAPsMAN fixture's own devices, by name (outside review O5): a
-- 'fixture-%' pattern also deleted the LTE fixture (fixture-lte-cpe-001).
DELETE FROM devices WHERE name IN (
  'fixture-core-rt-001', 'fixture-hall-ap-001', 'fixture-left-ap-001', 'fixture-right-ap-001'
);
SELECT 'cleaned' AS status,
       (SELECT count(*) FROM devices WHERE name IN (
          'fixture-core-rt-001', 'fixture-hall-ap-001', 'fixture-left-ap-001', 'fixture-right-ap-001'
        )) AS remaining;
