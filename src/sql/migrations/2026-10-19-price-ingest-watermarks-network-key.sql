-- Re-key price_ingest_watermarks on (network, source_chain) on an already-deployed hub.
-- xchain:migration mode=manual
-- The network column must already exist; the boot-time column reconcile adds it from src/sql/price_ingest_watermarks.sql.
-- DROP and ADD are one statement, so the table is never left without a primary key.
-- No dedup is needed: source_chain alone was the key, and the reconciled column defaults every existing row to ''.
-- Those rows stay in the '' bucket, which every network's fence read folds in, so no live fence is lowered.

ALTER TABLE `price_ingest_watermarks` DROP PRIMARY KEY, ADD PRIMARY KEY (network, source_chain);
