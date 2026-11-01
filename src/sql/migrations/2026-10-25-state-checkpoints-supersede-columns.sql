-- Add retroactive rules replay metadata to checkpoints on an already-deployed hub.
-- xchain:migration mode=manual

ALTER TABLE `state_checkpoints` ADD COLUMN IF NOT EXISTS `supersedes_from` BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE `state_checkpoints` ADD COLUMN IF NOT EXISTS `rules_digest` CHAR(64) DEFAULT NULL;
