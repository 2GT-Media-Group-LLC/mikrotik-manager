-- Remove everything seed-lte-fixture.sql created. The device cascades to its
-- interfaces, lte_interfaces, lte_cell_history and lte_observed_bands rows.
DELETE FROM devices WHERE name LIKE 'fixture-lte-%';
SELECT 'cleaned' AS status,
       (SELECT count(*) FROM devices WHERE name LIKE 'fixture-lte-%') AS remaining;
