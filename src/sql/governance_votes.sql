CREATE TABLE governance_votes (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    proposal_id     VARCHAR(100) NOT NULL,
    voter_pubkey    CHAR(64) NOT NULL,
    vote            ENUM('approve','reject') NOT NULL,
    signature       TEXT NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_proposal_voter (proposal_id, voter_pubkey)
);
