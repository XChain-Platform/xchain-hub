-- Add the per-batch response lookup index to attestation_responses on an already-deployed hub.
-- xchain:migration mode=manual

ALTER TABLE `attestation_responses` ADD INDEX IF NOT EXISTS `idx_batch_action` (network, batch_action_index);
