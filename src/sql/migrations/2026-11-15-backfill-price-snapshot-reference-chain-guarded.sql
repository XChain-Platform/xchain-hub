-- xchain:runbook
-- xchain:migration mode=manual
-- ---------------------------------------------------------------------------
-- One-off data correction: price_snapshots.reference_chain backfill, guarded
-- ---------------------------------------------------------------------------
--
-- Supersedes 2026-06-02-backfill-price-snapshot-reference-chain.sql. Run this
-- file instead of that one, and never run both.
--
-- Why the earlier runbook is not safe to run
--   It rewrites reference_chain from source_chain for every row that holds
--   reference_chain = 'BTC' and a source_chain of 'LTC' or 'DOGE'. A round
--   this hub finalized itself is stored with reference_chain 'BTC' and the
--   source_chain column default 'DOGE', and its source_action_index is NULL.
--   The earlier file therefore rewrites every hub-finalized round to
--   reference_chain 'DOGE'. Peer catch-up recognizes a hub-finalized round by
--   that stored shape, so a rewritten round is no longer mirrored to a hub
--   that catches up from this one.
--
-- What this file changes
--   Rows whose source_chain is 'LTC', and rows whose source_chain is 'DOGE'
--   and that name the source action of the PRICE transaction that carried
--   them. The column default is never 'LTC', so an LTC row is always a pushed
--   or batch round. A DOGE row with a NULL source_action_index is left as it
--   is: a hub-finalized round and a skipped placeholder both look like that,
--   and so does a pushed round whose sender gave no action index. The file
--   can therefore under-correct, and it never rewrites a hub-finalized round.
--
-- How to run
--   1. Take a backup / snapshot of price_snapshots first.
--   2. Run the PREVIEW query to see how many rows will change.
--   3. Run the UPDATE inside a transaction, verify counts, then COMMIT.
--
-- If the earlier runbook already ran on this hub
--   Run the DAMAGE CHECK query. A hub-finalized round rewritten by the earlier
--   file reads reference_chain 'DOGE' with source_chain 'DOGE' and a NULL
--   source_action_index. A nonzero count there is rows to restore to
--   reference_chain 'BTC'. The check cannot tell them from a row an old ingest
--   wrote without a source_chain, or a pushed round stored without an action
--   index, so inspect a sample before restoring:
--     UPDATE price_snapshots SET reference_chain = 'BTC'
--     WHERE reference_chain = 'DOGE' AND source_chain = 'DOGE'
--       AND source_action_index IS NULL
-- ---------------------------------------------------------------------------

-- PREVIEW: how many rows will be corrected, broken out by originating chain:
SELECT source_chain, COUNT(*) AS rows_to_fix
FROM price_snapshots
WHERE reference_chain = 'BTC'
  AND (source_chain = 'LTC' OR (source_chain = 'DOGE' AND source_action_index IS NOT NULL))
GROUP BY source_chain;

-- DAMAGE CHECK: rows the earlier runbook would have rewritten on this hub:
SELECT status, COUNT(*) AS rows_rewritten
FROM price_snapshots
WHERE reference_chain = 'DOGE'
  AND source_chain = 'DOGE'
  AND source_action_index IS NULL
GROUP BY status;

-- CORRECTION: restore reference_chain to the originating chain:
START TRANSACTION;

UPDATE price_snapshots
SET reference_chain = source_chain
WHERE reference_chain = 'BTC'
  AND (source_chain = 'LTC' OR (source_chain = 'DOGE' AND source_action_index IS NOT NULL));

-- Verify the affected-row count matches the preview total, then:
COMMIT;
-- (or ROLLBACK if the count looks wrong)
