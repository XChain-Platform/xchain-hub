CREATE TABLE oracle_published_rounds (
    round      BIGINT NOT NULL,                        -- PRICE v0 round id (one broadcast per round)
    txid       VARCHAR(80),                            -- DOGE txid of the PRICE tx (NULL until confirmed; may stay NULL if the broadcaster returns none)
    intent_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,    -- when broadcast intent was durably recorded (before the send)
    sent_at    TIMESTAMP NULL DEFAULT NULL,            -- when the broadcast completed; authoritative at-most-once marker (NULL = intent only)
    PRIMARY KEY (round),
    KEY idx_sent (sent_at)
);

-- Retention: OraclePublisher prunes rows older than
-- ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS (default 12960 rounds, ~90 days at the
-- 10-minute round default; 0 disables) after each publish pass. ONLY confirmed rows
-- (sent_at IS NOT NULL) are ever deleted. A sent_at NULL row is a quarantine marker
-- for a round whose on-chain state is unknown and which an operator reconciles by
-- hand, so it is retained forever regardless of age.
