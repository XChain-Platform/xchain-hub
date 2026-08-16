CREATE TABLE attest_published_requests (
    request_id VARCHAR(80) NOT NULL,                   -- ATTEST v1 request id (one response broadcast per request)
    txid       VARCHAR(80),                            -- BTC txid of the ATTEST response tx (NULL until confirmed; may stay NULL if the broadcaster returns none)
    intent_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,    -- when broadcast intent was durably recorded (before the send)
    sent_at    TIMESTAMP NULL DEFAULT NULL,            -- when the broadcast completed; authoritative at-most-once marker (NULL = intent only)
    PRIMARY KEY (request_id),
    KEY idx_sent (sent_at)
);

-- Retention: AttestationPublisher prunes rows older than
-- ATTEST_PUBLISHED_REQUESTS_RETENTION_MS (default 7776000000, ~90 days; 0 disables)
-- after any sweep pass that follows a publish. ONLY confirmed rows (sent_at IS NOT
-- NULL) are ever deleted. A sent_at NULL row is a quarantine marker for a request whose
-- on-chain state is unknown and which an operator reconciles by hand, so it is retained
-- forever regardless of age. The window is additionally floored at the longest live
-- provider deadline_window_blocks (the horizon past which no path can surface the
-- request again) and never touches a request still on the durable WAL; see
-- AttestationPublisher._prunePublishedRequests.
