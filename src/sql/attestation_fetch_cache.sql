CREATE TABLE attestation_fetch_cache (
    request_id  VARCHAR(80) NOT NULL,                   -- ATTEST v1 request id; one billed provider fetch per request per retry window
    provider_id VARCHAR(100) NOT NULL,                  -- provider that was fetched (audit)
    status      VARCHAR(32) NOT NULL,                   -- 'ok' or 'provider_error'; the outcome this hub proposed
    body        LONGBLOB,                               -- provider response bytes (empty on provider_error)
    meta        MEDIUMTEXT,                             -- provider meta string (empty on provider_error)
    model       VARCHAR(128),                           -- block-pinned fetch model id, for audit
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,    -- fetch completion time; rows age out with the seen-window
    PRIMARY KEY (request_id),
    KEY idx_created (created_at)
);
