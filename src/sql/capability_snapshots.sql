DROP TABLE IF EXISTS capability_snapshots;
CREATE TABLE capability_snapshots (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, -- mirror cursor (since_id)
    snapshot_block BIGINT UNSIGNED NOT NULL,                -- BTC-anchored block boundary this set is locked at
    capability     VARCHAR(20)  NOT NULL,                   -- e.g. 'cross_chain'
    signing_pubkey VARCHAR(64)  NOT NULL,                   -- Ed25519 validator pubkey (64 hex)
    amount         VARCHAR(250) NOT NULL,                   -- source AGGREGATE active stake at the block (weight under STAKE_WEIGHTED_QUORUM; informational pre-activation)
    source         VARCHAR(255) NOT NULL DEFAULT '',         -- staking address (source) this key signs for; quorum weight is per-source, NOT per-key (DELEGATE v0 additive). '' on pre-activation rows
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Presence of a row = that pubkey QUALIFIED for `capability` at `snapshot_block`
-- (the hub only writes pubkeys already filtered by min_stake via getcapabilityvalidators).
-- `source` is part of the key : at/above STAKE_WEIGHTED_QUORUM a key
-- delegated by two sources yields one row per (source, pubkey); a 3-column key
-- (without source) collapses them on INSERT IGNORE and silently drops the second
-- source, understating stake for any mirror-reading verifier.
CREATE UNIQUE INDEX uq_cap_snap   ON capability_snapshots (snapshot_block, capability, signing_pubkey, source);
CREATE        INDEX cap_block     ON capability_snapshots (capability, snapshot_block);
