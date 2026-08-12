CREATE TABLE reorg_attestations (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    reorg_id         VARCHAR(100) NOT NULL UNIQUE,
    source_chain     VARCHAR(10) NOT NULL,
    reorg_height     BIGINT NOT NULL,
    reorg_timestamp  BIGINT NOT NULL,
    affected_chains  TEXT,
    validator_count  INT NOT NULL DEFAULT 0,
    consensus_proof  TEXT,
    status           ENUM('confirmed','rejected') NOT NULL DEFAULT 'confirmed',
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- ReorgHandler's INSERT ... ON DUPLICATE KEY UPDATE re-confirms an already-seen
    -- reorg by writing updated_at. The column was never declared here, so that
    -- statement failed with errno 1054 "Unknown column 'updated_at' in 'UPDATE'"
    -- on every duplicate report; the e2e cluster helper had been papering
    -- over it with a hand-run ALTER. Deployed tables pick this up through
    -- alterTableForDrift on the next startup.
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_chain (source_chain),
    KEY idx_status (status)
);
