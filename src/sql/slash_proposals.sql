CREATE TABLE slash_proposals (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    validator_pubkey CHAR(64) NOT NULL,
    offense_type     VARCHAR(30) NOT NULL,
    round_number     BIGINT,
    evidence         TEXT,
    status           ENUM('pending','approved','rejected','expired') NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_validator (validator_pubkey),
    KEY idx_status (status)
);
