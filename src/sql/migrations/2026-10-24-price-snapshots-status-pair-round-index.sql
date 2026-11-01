-- Add the finalized per-pair round index to price_snapshots on an already-deployed hub.
-- xchain:migration mode=manual

ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `idx_status_pair_round` (status, coin_pair, round_number);
