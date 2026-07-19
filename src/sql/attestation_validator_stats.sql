-- Per-validator attestation spot-check outcomes (, Phase 4 quality
-- enforcement). One row per (validator, spot-checked request): passed=1 when
-- the validator's signed response matched the platform's expected answer,
-- passed=0 when it diverged. block_index is the request's creation block, so a
-- chain reorg that orphans that block deletes the row (AttestationSpotChecker
-- .rollback), keeping the failure-window slash trigger reorg-safe. The rolling
-- window and threshold decision read live counts from these durable rows.
CREATE TABLE attestation_validator_stats (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    validator_pubkey CHAR(64) NOT NULL,
    provider_id      VARCHAR(64) NOT NULL,
    request_id       VARCHAR(128) NOT NULL,
    block_index      BIGINT NOT NULL DEFAULT 0,
    passed           TINYINT(1) NOT NULL,
    checked_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_check (validator_pubkey, request_id),
    KEY idx_validator_pass (validator_pubkey, passed),
    KEY idx_block (block_index)
);
