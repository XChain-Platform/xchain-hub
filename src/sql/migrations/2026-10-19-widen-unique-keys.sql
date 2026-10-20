-- Widen deployed unique keys after 2026-10-19-dedup-and-add-unique-keys.sql (this file sorts after it).
-- xchain:migration mode=manual
-- Each widen adds the wider key as <name>_widening before dropping the original, so the table is never without the key.
-- A half-run file is not recorded, so the next operator run applies it again from the top; every step is idempotent.
-- The widened column must already exist; the boot-time column reconcile adds it.
-- A re-run rebuilds each key rather than skipping it.

UPDATE validator_rewards SET round_qualifier = block_index WHERE reward_type = 'anchor_archive' AND round_qualifier = 0 AND block_index IS NOT NULL AND block_index > 0;
ALTER TABLE `validator_rewards` ADD UNIQUE KEY IF NOT EXISTS `uq_reward_widening` (validator_pubkey, round_number, reward_type, round_qualifier);
ALTER TABLE `validator_rewards` DROP INDEX IF EXISTS `uq_reward`;
ALTER TABLE `validator_rewards` ADD UNIQUE KEY IF NOT EXISTS `uq_reward` (validator_pubkey, round_number, reward_type, round_qualifier);
ALTER TABLE `validator_rewards` DROP INDEX IF EXISTS `uq_reward_widening`;
ALTER TABLE `capability_snapshots` ADD UNIQUE KEY IF NOT EXISTS `uq_cap_snap_widening` (snapshot_block, capability, signing_pubkey, source);
ALTER TABLE `capability_snapshots` DROP INDEX IF EXISTS `uq_cap_snap`;
ALTER TABLE `capability_snapshots` ADD UNIQUE KEY IF NOT EXISTS `uq_cap_snap` (snapshot_block, capability, signing_pubkey, source);
ALTER TABLE `capability_snapshots` DROP INDEX IF EXISTS `uq_cap_snap_widening`;
ALTER TABLE `attestation_responses` ADD UNIQUE KEY IF NOT EXISTS `uq_attest_response_widening` (network, request_id, effective_time);
ALTER TABLE `attestation_responses` DROP INDEX IF EXISTS `uq_attest_response`;
ALTER TABLE `attestation_responses` ADD UNIQUE KEY IF NOT EXISTS `uq_attest_response` (network, request_id, effective_time);
ALTER TABLE `attestation_responses` DROP INDEX IF EXISTS `uq_attest_response_widening`;
