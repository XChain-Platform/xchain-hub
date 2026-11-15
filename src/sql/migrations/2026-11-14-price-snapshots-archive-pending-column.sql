-- Materialize and index the mutable archive-pending predicate used by price_snapshots reads.
-- Supersedes 2026-10-24-z-price-snapshots-archive-pending-index.sql for boot reporting: a boot
-- baselines this file on a hub that already holds the column and key (a fresh hub, or one that
-- ran that runbook) and logs it pending on a hub that lacks either, so npm run migrate applies it.
-- xchain:migration mode=manual

ALTER TABLE `price_snapshots`
    ADD COLUMN IF NOT EXISTS `archive_pending` TINYINT(1)
        GENERATED ALWAYS AS (
            batch_seq IS NULL OR
            archived_status <> status OR
            archived_batch_block_time <> batch_block_time OR
            archived_proof_sha <> SHA2(consensus_proof, 256)
        ) STORED,
    ADD INDEX IF NOT EXISTS `idx_archive_pending_round` (`archive_pending`, `round_number`);
