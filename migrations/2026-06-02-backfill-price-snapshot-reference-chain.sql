-- ---------------------------------------------------------------------------
-- One-off data correction: price_snapshots.reference_chain backfill
-- ---------------------------------------------------------------------------
--
-- Context
--   For some time the PRICE v0 ingest path wrote price_snapshots rows with
--   reference_chain pinned to the literal 'BTC' regardless of which chain
--   actually carried the round. As a result every LTC- or DOGE-originated
--   round was stored (and served by the explorer API + mirrored to indexer
--   replicas) with reference_chain = 'BTC', making the column unreliable for
--   provenance/audit queries.
--
--   The ingest code now writes the originating chain into reference_chain, so
--   all NEW rows are correct. This script repairs the EXISTING rows.
--
-- Signal used
--   source_chain records the chain that carried the PRICE v0 transaction and
--   is the best available indicator of the true originating chain for a
--   historical row. We use it to restore reference_chain.
--
-- Caveat (read before running)
--   The old ingest path also defaulted a missing source_chain to 'DOGE'. Rows
--   that were written without an explicit source_chain are therefore
--   indistinguishable from genuine DOGE rows, so any such row will be set to
--   reference_chain = 'DOGE'. This is the best correction available from the
--   data on hand; rows whose source_chain is genuinely 'LTC'/'DOGE' are
--   corrected accurately. Rows already correct ('BTC' rounds) are untouched.
--
-- How to run
--   1. Take a backup / snapshot of price_snapshots first.
--   2. Run the PREVIEW query to see how many rows will change.
--   3. Run the UPDATE inside a transaction; verify counts; COMMIT.
-- ---------------------------------------------------------------------------

-- PREVIEW — how many rows will be corrected, broken out by originating chain:
SELECT source_chain, COUNT(*) AS rows_to_fix
FROM price_snapshots
WHERE reference_chain = 'BTC'
  AND source_chain IN ('LTC', 'DOGE')
GROUP BY source_chain;

-- CORRECTION — restore reference_chain to the originating chain:
START TRANSACTION;

UPDATE price_snapshots
SET reference_chain = source_chain
WHERE reference_chain = 'BTC'
  AND source_chain IN ('LTC', 'DOGE');

-- Verify the affected-row count matches the preview total, then:
COMMIT;
-- (or ROLLBACK; if the count looks wrong)
