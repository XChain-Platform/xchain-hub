-- Index price_snapshots.batch_seq so getNextAnchorBatchSeq's MAX(batch_seq) is an index
-- read; unindexed it full-scans the wide table and exceeds the statement limit every flush.
ALTER TABLE `price_snapshots`
    ADD INDEX IF NOT EXISTS `idx_batch_seq` (`batch_seq`);
