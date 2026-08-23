-- Remove everything seed-capsman-fixture.sql created. Devices cascade to their
-- wireless_interfaces and capsman_* rows.
DELETE FROM devices WHERE name LIKE 'fixture-%';
SELECT 'cleaned' AS status,
       (SELECT count(*) FROM devices WHERE name LIKE 'fixture-%') AS remaining;
