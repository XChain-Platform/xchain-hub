CREATE TABLE oracle_published_rounds (
    round      BIGINT NOT NULL,                        -- PRICE v0 round id (one broadcast per round)
    txid       VARCHAR(80),                            -- DOGE txid of the PRICE tx (NULL until confirmed; may stay NULL if the broadcaster returns none)
    intent_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,    -- when broadcast intent was durably recorded (before the send)
    sent_at    TIMESTAMP NULL DEFAULT NULL,            -- when the broadcast completed; authoritative at-most-once marker (NULL = intent only)
    PRIMARY KEY (round),
    KEY idx_sent (sent_at)
);
