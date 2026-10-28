-- Index price_snapshots by (batch_block_time, round_number, status) so the landing-clock
-- repair sweep reads zero-stamped rounds in round order off one covering key; through the
-- pair-led key it filesorts every zero-stamped row and exceeds the statement limit.
ALTER TABLE `price_snapshots`
    ADD INDEX IF NOT EXISTS `idx_batchtime_round_status` (`batch_block_time`, `round_number`, `status`);
