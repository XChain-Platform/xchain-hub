CREATE TABLE validator_rewards (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    validator_pubkey CHAR(64) NOT NULL,
    round_number     BIGINT NOT NULL,
    reward_type      VARCHAR(20) NOT NULL DEFAULT 'oracle_round',
    amount           VARCHAR(40) NOT NULL,
    block_index      BIGINT NULL,
    batch_seq        BIGINT NULL,
    claimed          TINYINT(1) NOT NULL DEFAULT 0,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Ledger-key qualifier: snapshot_block for anchor_archive, 0 for every other reward
    -- type (src/anchor_reward_key.js). The archive leg keys on MATCH_BATCH_SEQ, which a
    -- wipe-and-replay rebase reissues, so round_number alone cannot tell two genuinely
    -- distinct archive anchors apart. NEVER NULLABLE: MariaDB treats NULLs as distinct
    -- inside a UNIQUE index, so an unset qualifier would stop deduplicating every row.
    round_qualifier  BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_reward (validator_pubkey, round_number, reward_type, round_qualifier),
    KEY idx_validator (validator_pubkey),
    KEY idx_round (round_number),
    KEY idx_unclaimed (validator_pubkey, claimed),
    KEY idx_batch_seq (batch_seq)
);
