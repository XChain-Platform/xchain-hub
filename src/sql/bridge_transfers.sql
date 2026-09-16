-- Hub-side authority table for the XCHAIN/token bridge (the base bridge spec
-- section 6). CrossChainBridgeEngine writes a finalized row here after the cross_chain
-- quorum signs the wrapped XBRIDGE canonical; db.verifyTables() picks this file up by
-- directory scan at boot (src/db.js verifyTables), so no table list needs the name.
--
-- Mirrored to every indexer over the hub-DB stream beside cross_chain_matches. A
-- mirrored table is upsert-only and is NEVER delete-and-reinserted: a delete leaves both
-- generations on every replica.
--
-- TODO(L6): the hub-side read surface is NOT registered here. L6 owns xchain-hub/src/api.js
-- and must add a GET /hub-db/snapshot/bridge_transfers route (the
-- /hub-db/snapshot/cross_chain_matches handler at api.js:1960 is the shape) plus the
-- getbridgeinvariant read; each is a ~20-line express handler, not a one-line registration,
-- so it is left to the owning lane rather than half-written here.
DROP TABLE IF EXISTS bridge_transfers;
CREATE TABLE bridge_transfers (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, -- mirror cursor (since_id)
    transfer_id          CHAR(64)     NOT NULL,                    -- sha256(network|src_chain:src_action_index|dest_chain:dest_address|snapshot_block), lowercase hex; snapshot_block is INSIDE the preimage so a retracted row never strands the id a re-formed transfer needs (the _deriveMatchId shape)
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC-anchored block; selects the cross_chain validator set for signature verification
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; signed into the canonical so a transfer finalized on one network can never replay onto another
    src_chain            VARCHAR(10)  NOT NULL,                    -- chain the lock (v0/v3) or burn (v1/v4) was mined on; direction is DERIVED from it (src_chain == the tick's origin chain is a lock) and is never a column
    src_action_index     BIGINT UNSIGNED NOT NULL,                 -- the source leg's action_index on src_chain
    src_address          VARCHAR(255) NOT NULL,                    -- the locking/burning source address
    dest_chain           VARCHAR(10)  NOT NULL,                    -- chain the credit lands on
    dest_address         VARCHAR(255) NOT NULL,                    -- address credited by the XBRIDGE v2/v5 settle leg
    tick                 VARCHAR(250) NOT NULL,                    -- the asset's NATIVE tick (never the rooted <ORIGIN>.<NAME> form); XCHAIN for every base-spec row. Signed from the first row (base D66) because the mirror drops unknown columns silently, so a general-token extension could never add it later
    decimals             TINYINT UNSIGNED NOT NULL,                -- the token's DECIMALS (8 for XCHAIN); signed for the same reason as `tick`, and the precision `amount` is formatted at
    amount               VARCHAR(250) NOT NULL,                    -- decimal string at `decimals` fractional digits; VARCHAR because amounts are bignumber math, never a DB numeric (the a_amount/b_amount precedent)
    effective_time       BIGINT UNSIGNED NOT NULL,                 -- protocol-time instant every indexer applies at: now + relayMarginFloorS(dest_chain); a follower refuses to co-sign a row less than 60 s or more than 3600 s ahead of its own clock
    -- ADMISSION HEIGHTS over the row's read set (dest_chain alone). Only that chain's
    -- column is ever set; the others exist so one uniform predicate serves every mirror
    -- table. NULL is the legacy row: see the note in cross_chain_matches.sql.
    admit_block_btc      BIGINT UNSIGNED DEFAULT NULL,
    admit_block_ltc      BIGINT UNSIGNED DEFAULT NULL,
    admit_block_doge     BIGINT UNSIGNED DEFAULT NULL,
    finalizing_view      INT          NOT NULL DEFAULT 0,          -- PBFT view the canonical was signed under; the indexer rebuilds the exact EQUIV header VIEW from it
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}] over the EQUIV-wrapped canonical; stake-weighted two-thirds or 2f+1 per the CROSS_SETTLE rule
    status               VARCHAR(20)  NOT NULL DEFAULT 'finalized',-- finalized / retracted
    push_generation      BIGINT       NOT NULL DEFAULT 0,          -- source-chain reorg fence stamped from src_chain's indexer generation; an unfenced quorum-class retraction is refused outright
    btc_chain_id         CHAR(64)     NULL,                        -- hash of BTC block 1 on the writing hub's chain; NULL accepted by every mirror. Transport, not signed: `network` guards across environments, this guards across a re-genesis of the same environment
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX transfer_id    ON bridge_transfers (transfer_id);
CREATE        INDEX snapshot_block ON bridge_transfers (snapshot_block);
CREATE        INDEX src_ref        ON bridge_transfers (src_chain, src_action_index);
CREATE        INDEX dest_chain     ON bridge_transfers (dest_chain);
CREATE        INDEX effective_time ON bridge_transfers (effective_time);
CREATE        INDEX status         ON bridge_transfers (status);
CREATE        INDEX tick           ON bridge_transfers (tick);
