DROP TABLE IF EXISTS cross_chain_matches;
CREATE TABLE cross_chain_matches (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, -- mirror cursor (since_id)
    match_id             VARCHAR(80)  NOT NULL,                    -- deterministic hash of both order refs + snapshot_block
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC-anchored block; selects the cross_chain validator set for sig verification
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; signed into the canonical so a match can never settle off-network
    -- Order A (canonical-lower side). payout addr = A's receive address on B's chain.
    a_chain              VARCHAR(10)  NOT NULL,
    a_action_index       BIGINT UNSIGNED NOT NULL,
    a_tick               VARCHAR(255),                             -- NULL = native coin (later phase)
    a_amount             VARCHAR(250) NOT NULL,
    a_ownership          TINYINT(1)   NOT NULL DEFAULT 0,
    a_payout_addr        VARCHAR(255) NOT NULL,
    -- Order B (canonical-higher side). payout addr = B's receive address on A's chain.
    b_chain              VARCHAR(10)  NOT NULL,
    b_action_index       BIGINT UNSIGNED NOT NULL,
    b_tick               VARCHAR(255),
    b_amount             VARCHAR(250) NOT NULL,
    b_ownership          TINYINT(1)   NOT NULL DEFAULT 0,
    b_payout_addr        VARCHAR(255) NOT NULL,
    effective_time       BIGINT UNSIGNED NOT NULL,                 -- wall-clock instant indexers apply at (shared clock across chains)
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}] — 2f+1 over the canonical match
    status               VARCHAR(20)  NOT NULL DEFAULT 'finalized',-- finalized / retracted
    batch_root           VARCHAR(64),                              -- optional Merkle root of the DOGE audit batch
    anchor_txid          VARCHAR(64),                              -- optional DOGE anchor txid
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX match_id       ON cross_chain_matches (match_id);
CREATE        INDEX snapshot_block ON cross_chain_matches (snapshot_block);
CREATE        INDEX a_ref          ON cross_chain_matches (a_chain, a_action_index);
CREATE        INDEX b_ref          ON cross_chain_matches (b_chain, b_action_index);
CREATE        INDEX effective_time ON cross_chain_matches (effective_time);
CREATE        INDEX status         ON cross_chain_matches (status);
