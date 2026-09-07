CREATE TABLE attest_published_requests (
    request_id    VARCHAR(80) NOT NULL,                -- ATTEST v1 request id
    txid          VARCHAR(80),                         -- BTC txid of the most recent ATTEST response tx (NULL until confirmed; may stay NULL if the broadcaster returns none)
    intent_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- when broadcast intent was durably recorded (before the send)
    sent_at       TIMESTAMP NULL DEFAULT NULL,         -- when the most recent broadcast completed (NULL = intent only)
    sent_statuses VARCHAR(64) DEFAULT NULL,            -- comma-joined response statuses already broadcast for this request; NULL reads as EVERY status
    intent_status VARCHAR(32) DEFAULT NULL,            -- response status of the armed, unconfirmed broadcast; NULL when none is armed
    PRIMARY KEY (request_id),
    KEY idx_sent (sent_at)
);

-- Identity: the row is keyed by request id, and `sent_statuses` carries the
-- at-most-once identity inside it. One request can legitimately publish more than one
-- response, because a non-ok status (provider_error, no_quorum) is an advisory audit
-- row that leaves the request PENDING and retryable on the indexer, so a later round
-- can finalize the same request ok. The gate therefore admits a status absent from
-- `sent_statuses` and refuses one already listed; an 'ok' entry is terminal for every
-- status. A NULL column is a row this hub wrote before the column existed, whose
-- outcome is unrecorded, and reads as every status so an upgrade can never re-open a
-- request the older code had closed. The status vocabulary is closed and short
-- (AttestationConsensus emits ok, provider_error, no_quorum), which is what keeps the
-- list inside VARCHAR(64) and the identity inside one row: widening PRIMARY KEY
-- (request_id) would need a key migration this schema layer does not perform, and a
-- hub that upgraded without one would collide every second publication.

-- Retention: AttestationPublisher prunes rows older than
-- ATTEST_PUBLISHED_REQUESTS_RETENTION_MS (default 7776000000, ~90 days; 0 disables)
-- after any sweep pass that follows a publish. ONLY rows that are both confirmed
-- (sent_at IS NOT NULL) and free of an armed intent (intent_status IS NULL) are ever
-- deleted. A sent_at NULL row, and any row holding an armed intent, is a quarantine
-- marker for a publication whose on-chain state is unknown and which an operator
-- reconciles by hand, so it is retained forever regardless of age. The window is
-- additionally floored at the longest live provider deadline_window_blocks (the horizon
-- past which no path can surface the request again) and never touches a request still
-- on the durable WAL; see AttestationPublisher._prunePublishedRequests.
