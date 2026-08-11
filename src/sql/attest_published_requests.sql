CREATE TABLE attest_published_requests (
    request_id VARCHAR(80) NOT NULL,                   -- ATTEST v1 request id (one response broadcast per request)
    txid       VARCHAR(80),                            -- BTC txid of the ATTEST response tx (NULL until confirmed; may stay NULL if the broadcaster returns none)
    intent_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,    -- when broadcast intent was durably recorded (before the send)
    sent_at    TIMESTAMP NULL DEFAULT NULL,            -- when the broadcast completed; authoritative at-most-once marker (NULL = intent only)
    PRIMARY KEY (request_id),
    KEY idx_sent (sent_at)
);
