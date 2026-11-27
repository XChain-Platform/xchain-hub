-- Stamp the landing anchor carried by each archived price row so a re-landed or
-- chain-restored row becomes pending again when its canonical landing moves.
-- xchain:migration mode=manual

ALTER TABLE `price_snapshots`
    ADD COLUMN IF NOT EXISTS `archived_reference_block` BIGINT DEFAULT NULL AFTER `archived_proof_sha`,
    ADD COLUMN IF NOT EXISTS `archived_source_action_index` BIGINT DEFAULT NULL AFTER `archived_reference_block`;

UPDATE `price_snapshots`
SET `archived_reference_block` = `reference_block`,
    `archived_source_action_index` = `source_action_index`
WHERE `batch_seq` IS NOT NULL AND `archived_reference_block` IS NULL;

ALTER TABLE `price_snapshots`
    DROP INDEX IF EXISTS `idx_archive_pending_round`,
    MODIFY COLUMN `archive_pending` TINYINT(1)
        GENERATED ALWAYS AS (
            batch_seq IS NULL OR
            archived_status <> status OR
            archived_batch_block_time <> batch_block_time OR
            archived_proof_sha <> SHA2(consensus_proof, 256) OR
            NOT (archived_reference_block <=> reference_block) OR
            NOT (archived_source_action_index <=> source_action_index)
        ) STORED,
    ADD INDEX `idx_archive_pending_round` (`archive_pending`, `round_number`);
