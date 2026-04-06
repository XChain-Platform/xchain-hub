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
    KEY idx_chain (source_chain),
    KEY idx_status (status)
);
