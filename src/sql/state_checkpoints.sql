DROP TABLE IF EXISTS state_checkpoints;
CREATE TABLE state_checkpoints (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, -- mirror cursor (since_id)
    chain                VARCHAR(10)  NOT NULL,                    -- chain being checkpointed: BTC/LTC/DOGE
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; signed into the canonical
    block_index          BIGINT UNSIGNED NOT NULL,                 -- checkpointed block height on `chain`
    block_hash           VARCHAR(64)  NOT NULL,                    -- chain block hash at block_index
    ledger_hash          VARCHAR(64)  NOT NULL,                    -- indexer blocks.ledger_hash (chained) at block_index
    actions_hash         VARCHAR(64)  NOT NULL,                    -- indexer blocks.actions_hash (chained)
    contract_hash        VARCHAR(64)  NOT NULL,                    -- indexer blocks.contract_hash (chained)
    checkpoint_seq       BIGINT UNSIGNED NOT NULL,                 -- monotonic per (chain, network); derived from snapshot_block (StateCheckpointEngine.deriveCheckpointSeq); replay guard + split-brain key
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC block selecting the oracle_publish set for sig verification
    state_root           CHAR(64),                                 -- SPV light-client state_root (SMT over balances+stakes); NULL pre CHECKPOINT_COMMITMENT flag-day
    state_root_version   TINYINT UNSIGNED,                         -- merkle.js STATE_ROOT_VERSION the state_root was computed under; NULL pre-flag-day
    block_merkle_root    CHAR(64),                                 -- SPV per-block content Merkle root (§5); NULL pre-flag-day
    block_merkle_version TINYINT UNSIGNED,                         -- merkle.js BLOCK_MERKLE_VERSION; NULL pre-flag-day
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}], 2f+1 over the XCHECKPOINT canonical (incl. the roots post-flag-day)
    anchor_txid          VARCHAR(64),                              -- DOGE ANCHOR txid once published on-chain (hub-side audit only)
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Append-only (INSERT IGNORE): a reorged height is superseded by a NEW row with a
-- higher checkpoint_seq (never an UPDATE, because the indexer mirror applies rows with
-- INSERT IGNORE, so an in-place update would silently never propagate). Readers
-- resolve "the" checkpoint for a height as MAX(checkpoint_seq).
--
--  split-brain defense: the unique key is (chain, network, checkpoint_seq),
-- NOT (chain, network, block_index, checkpoint_seq). checkpoint_seq is derived
-- deterministically from snapshot_block (StateCheckpointEngine.deriveCheckpointSeq),
-- so two BTC-tip-skewed leaders can never mint divergent payloads under one seq.
-- This key is the last line of defense: if a same-seq race ever produces two rows
-- with different block_index/hashes, exactly one is admitted (INSERT IGNORE drops
-- the loser), so the anchor publisher's MAX(checkpoint_seq) selection can never see
-- two rows at one seq and double-spend a DOGE anchor for one logical checkpoint.
CREATE UNIQUE INDEX uq_chain_seq  ON state_checkpoints (chain, network, checkpoint_seq);
CREATE        INDEX sc_chain_blk  ON state_checkpoints (chain, network, block_index);
