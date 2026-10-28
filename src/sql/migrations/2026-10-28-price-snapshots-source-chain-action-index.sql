-- Index price_snapshots (source_chain, source_action_index, push_generation) so the batch
-- retraction reads (rounds of a retracted PRICE batch, orphaned landing stamps) are a range
-- read on the source chain's action window; unindexed they scan the wide table and exceed
-- the statement limit on every retry.
-- xchain:migration mode=manual
ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `idx_source_chain_action` (`source_chain`, `source_action_index`, `push_generation`);
