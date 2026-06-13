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
    UNIQUE KEY uq_reward (validator_pubkey, round_number, reward_type),
    KEY idx_validator (validator_pubkey),
    KEY idx_round (round_number),
    KEY idx_unclaimed (validator_pubkey, claimed),
    KEY idx_batch_seq (batch_seq)
);
