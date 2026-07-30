CREATE TABLE governance_votes (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    proposal_id     VARCHAR(100) NOT NULL,
    voter_pubkey    CHAR(64) NOT NULL,
    vote            ENUM('approve','reject') NOT NULL,
    signature       TEXT NOT NULL,
    -- GOV-VOTE-REPLAY-1 : the monotonic seq carried INSIDE the signed
    -- vote payload. The sink only overwrites a row when the incoming seq is
    -- strictly greater, so a captured (payload, signature) pair cannot be
    -- replayed to reinstate a superseded vote. DEFAULT 0 so pre- rows
    -- backfill to a value that any real seq beats.
    vote_seq        BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_proposal_voter (proposal_id, voter_pubkey)
);
