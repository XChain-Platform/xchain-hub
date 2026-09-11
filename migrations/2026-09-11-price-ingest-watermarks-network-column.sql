-- ---------------------------------------------------------------------------
-- Fleet schema migration: price_ingest_watermarks gains a `network` column
-- ---------------------------------------------------------------------------
--
-- Context
--   The HUB-RETRACT-4 price ingest fence was keyed on source_chain ALONE
--   (`source_chain VARCHAR(10) PRIMARY KEY`). A hub database that is shared by,
--   or outlives, more than one deployment network therefore held ONE fence row
--   per chain for every network on it. Two consequences, both live:
--
--     1. Clearing the fence after a regtest indexer wipe (the node's
--        clearHubPriceIngestWatermark, run by `reset`) dropped the row that was
--        fencing the LIVE network for that same chain, which then admitted a
--        stale replay out of an orphaned range.
--     2. A retraction on one network raised the fence for all of them, so an
--        unrelated network's healthy pushes were dropped at ingest.
--
--   The node-side HUB_NETWORK guard shipped as a stopgap: it refused the clear
--   whenever the co-located hub named a different network, which left the
--   regtest price rail down and could not help at all when HUB_NETWORK was
--   unset. This migration replaces that stopgap with a real key.
--
-- What changes
--   * `network VARCHAR(20) NOT NULL DEFAULT ''` is added as the first column.
--   * The primary key becomes (network, source_chain).
--   * Existing rows are backfilled to THIS hub's own deployment network.
--
-- Backfill (read before running)
--   Existing rows carry no network, so nothing in the data can tell which
--   network's fence they are. They belong to the hub that wrote them, which is
--   the hub whose database this is, so set @hub_network below to that hub's
--   HUB_NETWORK value before running. Leaving it '' is legal and keeps the rows
--   in the ambiguous legacy bucket: readers fold that bucket into their own
--   network's fence and take the stricter of the two, so the fence is never
--   silently lost, but the cross-network coupling this migration exists to
--   remove survives for those rows until they are retired.
--
-- How to run
--   1. Back up price_ingest_watermarks (it is small: one row per chain).
--   2. Set @hub_network to this hub's network, lowercased.
--   3. Run the PREVIEW, then the MIGRATION, then VERIFY.
--
--   The ALTER is not transactional in MariaDB (DDL commits implicitly), so run
--   it with the hub stopped or accept that a push landing mid-ALTER may be
--   fenced on the pre-ALTER row. The table is tiny and the ALTER is sub-second.
-- ---------------------------------------------------------------------------

-- Set this to the deployment network of the hub that owns this database:
-- 'mainnet', 'testnet' or 'regtest' (lowercase). Leave '' only if this hub
-- genuinely runs with HUB_NETWORK unset.
SET @hub_network = '';

-- PREVIEW - the rows that will be re-keyed onto @hub_network:
SELECT source_chain, retraction_generation, from_action_index, updated_at
FROM price_ingest_watermarks;

-- MIGRATION ---------------------------------------------------------------

ALTER TABLE price_ingest_watermarks
    ADD COLUMN network VARCHAR(20) NOT NULL DEFAULT '' FIRST,
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (network, source_chain);

-- Backfill the pre-existing rows onto this hub's own network. Scoped to the ''
-- bucket so re-running the script is a no-op rather than a re-stamp of rows a
-- later hub wrote correctly.
UPDATE price_ingest_watermarks
SET network = @hub_network
WHERE network = '' AND @hub_network <> '';

-- VERIFY ------------------------------------------------------------------
-- Every row should now name a network (unless @hub_network was deliberately
-- left ''), and (network, source_chain) should be unique.
SELECT network, source_chain, retraction_generation, from_action_index
FROM price_ingest_watermarks
ORDER BY network, source_chain;

-- Rollback, if the fleet has to step back to a chain-keyed fence. Collapses the
-- per-network rows onto the STRICTER fence per chain (highest generation, and
-- the lowest orphan bound at that generation) so stepping back never lowers a
-- fence:
--
--   CREATE TEMPORARY TABLE piw_collapsed AS
--     SELECT w.source_chain, w.retraction_generation, MIN(w.from_action_index) AS from_action_index
--     FROM price_ingest_watermarks w
--     JOIN (SELECT source_chain, MAX(retraction_generation) AS g
--           FROM price_ingest_watermarks GROUP BY source_chain) m
--       ON m.source_chain = w.source_chain AND m.g = w.retraction_generation
--     GROUP BY w.source_chain, w.retraction_generation;
--   DELETE FROM price_ingest_watermarks;
--   ALTER TABLE price_ingest_watermarks DROP PRIMARY KEY, DROP COLUMN network,
--         ADD PRIMARY KEY (source_chain);
--   INSERT INTO price_ingest_watermarks (source_chain, retraction_generation, from_action_index)
--     SELECT source_chain, retraction_generation, from_action_index FROM piw_collapsed;
