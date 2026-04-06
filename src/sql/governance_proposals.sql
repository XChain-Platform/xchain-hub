CREATE TABLE governance_proposals (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    proposal_id     VARCHAR(100) NOT NULL UNIQUE,
    proposer_pubkey CHAR(64) NOT NULL,
    parameter       VARCHAR(100) NOT NULL,
    current_value   TEXT,
    proposed_value  TEXT NOT NULL,
    rationale       TEXT,
    status          ENUM('voting','passed','failed','expired') NOT NULL DEFAULT 'voting',
    voting_start    TIMESTAMP NOT NULL,
    voting_end      TIMESTAMP NOT NULL,
    applied_at      TIMESTAMP NULL DEFAULT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_parameter (parameter),
    KEY idx_status (status)
);
