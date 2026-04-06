CREATE TABLE attestations (
    id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
    attestation_id        VARCHAR(100) NOT NULL UNIQUE,
    source_chain          VARCHAR(10) NOT NULL,
    source_action_index   BIGINT NOT NULL,
    dest_chain            VARCHAR(10) NOT NULL,
    confirmations         INT NOT NULL DEFAULT 0,
    status                ENUM('pending','attested','rejected','expired') NOT NULL DEFAULT 'pending',
    validator_count       INT NOT NULL DEFAULT 0,
    consensus_proof       TEXT,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_source (source_chain, source_action_index),
    KEY idx_status (status)
);
