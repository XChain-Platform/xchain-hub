CREATE TABLE governance_proposals (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    proposal_id     VARCHAR(100) NOT NULL UNIQUE,
    proposer_pubkey CHAR(64) NOT NULL,
    parameter       VARCHAR(100) NOT NULL,
    current_value   TEXT,
    proposed_value  TEXT NOT NULL,
    rationale       TEXT,
    status          ENUM('voting','passed','failed','expired') NOT NULL DEFAULT 'voting',
    -- DATETIME, not TIMESTAMP: TIMESTAMP is bounded by the signed 32-bit epoch
    -- (2038-01-19 03:14:07 UTC), and these two carry a FUTURE instant. voting_end is
    -- NOW() + GOV_VOTING_PERIOD, so once the horizon is inside one voting period every
    -- propose() writes an out-of-range value and governance stops (#4315). The session
    -- is pinned to UTC on every connection (db.js connectionPoolParams.timezone 'Z'),
    -- so the literal DATETIME stores the same instant TIMESTAMP did. Deployed tables are
    -- converted by _migrateColumnType in runMigrations; the drift reconciler adds columns
    -- but never changes a type.
    voting_start    DATETIME NOT NULL,
    voting_end      DATETIME NOT NULL,
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
