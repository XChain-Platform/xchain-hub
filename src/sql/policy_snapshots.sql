-- Hub-side authority table for token-bridge policy inheritance
-- (the token bridge policy spec section 5). One signed snapshot of an
-- origin token's policy (allow list, block list, tick sleep) per (network, origin_chain,
-- tick, policy_seq); the destination indexer materializes it onto the bridged copy.
--
-- Shape copied from state_checkpoints.sql, which is the platform's signed, per-entity,
-- latest-wins mirrored table: append-only, applied INSERT IGNORE, readers take the
-- highest seq. capability_snapshots is deliberately NOT the precedent; its rows are
-- unsigned set membership.
--
-- db.verifyTables() picks this file up by directory scan at boot (src/db.js
-- verifyTables), so no table list needs the name.
--
-- TODO(L6): as with bridge_transfers, the GET /hub-db/snapshot/policy_snapshots route in
-- xchain-hub/src/api.js is NOT written here; L6 owns that file and each snapshot route is
-- a ~20-line express handler (api.js:2041 state_checkpoints is the shape for an
-- append-only table), not a one-line registration.
DROP TABLE IF EXISTS policy_snapshots;
CREATE TABLE policy_snapshots (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, -- mirror cursor (since_id)
    snapshot_id          CHAR(64)     NOT NULL,                    -- sha256(network|origin_chain:tick|policy_seq|snapshot_block), lowercase hex
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC-anchored block; selects the cross_chain validator set, as bridge_transfers
    origin_chain         VARCHAR(10)  NOT NULL,                    -- the chain the NATIVE token row lives on
    tick                 VARCHAR(250) NOT NULL,                    -- the native name, never the rooted <ORIGIN>.<NAME> form
    policy_seq           BIGINT UNSIGNED NOT NULL,                 -- 1 for the first snapshot of (network, origin_chain, tick), then +1. Ordering only: a gap is carried forward, never a refusal
    origin_block         BIGINT UNSIGNED NOT NULL,                 -- the confirmed origin-chain height the policy was read at; what every follower re-reads before co-signing; signed
    policy_hash          CHAR(64)     NOT NULL,                    -- sha256 over the canonical membership text ALLOW|<n or ->|<addr>|...|BLOCK|<m or ->|<addr>|...|SLEEP|<0 or 1>, addresses in utf8_bin order (the order getList returns for type-2 lists). `-` means the origin row has no such list, 0 means an empty one
    allow_list           MEDIUMTEXT,                               -- transport JSON array (or NULL); verified against policy_hash on apply and NEVER signed as a field
    block_list           MEDIUMTEXT,                               -- transport JSON array (or NULL); same rule
    sleeping             TINYINT(1)   NOT NULL DEFAULT 0,          -- tick sleep on the origin row; committed through policy_hash only, not repeated in the canonical. Column exists for the reads
    effective_time       BIGINT UNSIGNED NOT NULL,                 -- now + max(relayMarginFloorS(c)) over every chain c that holds a copy of this tick per the hub's own bridge_transfers rows (never over BRIDGE_CHAINS, which an issuer can empty while copies exist). NOT monotonic across policy_seq, so apply order is by seq
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; signed
    finalizing_view      INT          NOT NULL DEFAULT 0,          -- PBFT view the canonical was signed under
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}] over the EQUIV-wrapped XPOLICY canonical
    status               VARCHAR(20)  NOT NULL DEFAULT 'finalized',-- finalized / retracted
    push_generation      BIGINT       NOT NULL DEFAULT 0,          -- origin-chain reorg fence, as bridge_transfers
    btc_chain_id         CHAR(64)     NULL,                        -- hash of BTC block 1 on the writing hub's chain; transport, not signed
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Append-only (the mirror applies rows INSERT IGNORE, so an in-place UPDATE would
-- silently never propagate): a superseding policy is a NEW row at a higher policy_seq,
-- and readers resolve "the" policy for a tick as the highest APPLIED seq. The unique key
-- is therefore the identity a same-seq race must collapse on, exactly as
-- state_checkpoints keys (chain, network, checkpoint_seq).
CREATE UNIQUE INDEX uq_policy_seq ON policy_snapshots (network, origin_chain, tick, policy_seq);
CREATE UNIQUE INDEX snapshot_id   ON policy_snapshots (snapshot_id);
CREATE        INDEX effective_time ON policy_snapshots (effective_time);
CREATE        INDEX origin_tick   ON policy_snapshots (origin_chain, tick);
