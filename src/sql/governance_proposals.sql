CREATE TABLE governance_proposals (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    proposal_id     VARCHAR(100) NOT NULL UNIQUE,
    proposer_pubkey CHAR(64) NOT NULL,
    parameter       VARCHAR(100) NOT NULL,
    current_value   TEXT,
    proposed_value  TEXT NOT NULL,
    rationale       TEXT,
    status          ENUM('voting','passed','failed','expired') NOT NULL DEFAULT 'voting',
    voting_start    TIMESTAMP NOT NULL,
    voting_end      TIMESTAMP NOT NULL,
    -- Block-anchored activation: for CAPABILITY_<CAP>_MIN_STAKE proposals this is the
    -- proposer-declared block height at which the new threshold takes effect. Every hub
    -- resolves the threshold for block N as the latest activation_block <= N, so the
    -- capability validator set (and quorum N) stays federation-deterministic even though
    -- finalization is wall-clock (#3703). NULL for proposals that predate this column or
    -- carry no activation height. Added to existing tables by the startup drift-reconciler.
    activation_block BIGINT NULL DEFAULT NULL,
    -- Snapshot-locked electorate (R2-M2): the validator set captured at proposal
    -- creation, as a pubkey-sorted JSON array of {pubkey, addr}. The tally
    -- denominator and vote-membership resolve against THIS set, not the live
    -- mutable validator set, so a set churn between propose() and tally cannot
    -- move the quorum/approval goalposts (and R2-H2's follower re-tally counts
    -- against the identical locked denominator). NULL for proposals that predate
    -- this column (tallied against the live set, legacy behaviour). Added to
    -- existing tables by the startup drift-reconciler.
    validator_snapshot MEDIUMTEXT NULL DEFAULT NULL,
    applied_at      TIMESTAMP NULL DEFAULT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_parameter (parameter),
    KEY idx_status (status)
);
