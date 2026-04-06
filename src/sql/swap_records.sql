CREATE TABLE swap_records (
    id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_chain           VARCHAR(10) NOT NULL,
    source_action_index    BIGINT NOT NULL,
    dest_chain             VARCHAR(10) NOT NULL,
    dest_action_index      BIGINT,
    attestation_id         VARCHAR(100),
    status                 ENUM('initiated','attested','executed','settled','failed') NOT NULL DEFAULT 'initiated',
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY idx_source (source_chain, source_action_index),
    KEY idx_status (status),
    KEY idx_attestation (attestation_id)
);
