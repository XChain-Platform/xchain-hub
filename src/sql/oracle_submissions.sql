CREATE TABLE oracle_submissions (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    round_number     BIGINT NOT NULL,
    coin_pair        VARCHAR(20) NOT NULL,
    validator_pubkey CHAR(64) NOT NULL,
    price            VARCHAR(40) NOT NULL,
    sources          INT NOT NULL DEFAULT 0,
    submitted_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_round (round_number, coin_pair),
    KEY idx_validator (validator_pubkey)
);
