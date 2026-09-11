CREATE TABLE price_ingest_watermarks (
    network               VARCHAR(20) NOT NULL DEFAULT '',     -- deployment network the fence belongs to (mainnet | testnet | regtest), lowercased; '' is the legacy/unset bucket written by a hub whose HUB_NETWORK is not set
    source_chain          VARCHAR(10) NOT NULL,                -- BTC | LTC | DOGE
    retraction_generation BIGINT NOT NULL DEFAULT 0,          -- highest source-chain rollback generation whose price retraction the hub has processed (HUB-RETRACT-4 ingest fence)
    from_action_index     BIGINT NOT NULL DEFAULT 0,          -- the from_action_index (orphaned-range lower bound) of that highest-generation retraction; a stale push at push_generation <= retraction_generation AND action_index >= this bound is rejected at ingest
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (network, source_chain)
);

-- `network` is part of the key, not decoration. One hub DB can be shared by (or
-- outlive) more than one deployment network, and a chain-only key gave every
-- network on it ONE fence row per chain: clearing the regtest fence after an
-- indexer wipe dropped the live testnet fence for the same chain, which then
-- admitted a stale replay from an orphaned range on that live network. With the
-- column, a clear scopes to (network, source_chain) and every other network's
-- fence for that chain survives untouched.
--
-- The '' bucket is what a hub with HUB_NETWORK unset writes. It is ambiguous by
-- construction, so readers fold it together with their own network's row and
-- take the STRICTER fence (highest generation, lowest orphan bound at a tie): a
-- fence that over-rejects is loud and clearable, a fence silently lost admits
-- the orphan replay it exists to stop.
