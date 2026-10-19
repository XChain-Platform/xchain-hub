-- Re-key price_ingest_watermarks from (source_chain) to (network, source_chain).
-- xchain:migration mode=auto on-error=warn
-- One ALTER, so the table is never left without a primary key. The network column is added by the
-- boot-time column reconcile, which runs first; if it is missing the statement fails and is logged.
-- Existing rows keep network '' and stay unique per chain, so no dedup is needed.

ALTER TABLE `price_ingest_watermarks` DROP PRIMARY KEY, ADD PRIMARY KEY (`network`, `source_chain`);
