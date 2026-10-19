-- Add plain indexes and remove retired indexes on an already-deployed hub.
-- xchain:migration mode=auto on-error=warn
-- Run after the unique-key steps; retired checkpoint indexes are dropped only after `uq_chain_seq` exists.

ALTER TABLE `validator_rewards` ADD INDEX IF NOT EXISTS `idx_batch_seq` (batch_seq);
ALTER TABLE `state_checkpoints` ADD INDEX IF NOT EXISTS `sc_chain_blk` (chain, network, block_index);
ALTER TABLE `state_checkpoints` DROP INDEX IF EXISTS `chain_block_seq`;
ALTER TABLE `state_checkpoints` DROP INDEX IF EXISTS `checkpoint_seq`;
ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `idx_status_block_round` (status, reference_block, round_number);
ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `idx_status_timestamp_round` (status, block_timestamp, round_number);
ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `idx_status_created` (status, created_at);
