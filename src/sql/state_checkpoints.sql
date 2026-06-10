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
    checkpoint_seq       BIGINT UNSIGNED NOT NULL,                 -- monotonic per (chain, network); replay guard
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC block selecting the oracle_publish set for sig verification
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}] — 2f+1 over the XCHECKPOINT canonical
    anchor_txid          VARCHAR(64),                              -- DOGE ANCHOR txid once published on-chain (hub-side audit only)
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Append-only (INSERT IGNORE): a reorged height is superseded by a NEW row with a
-- higher checkpoint_seq (never an UPDATE — the indexer mirror applies rows with
-- INSERT IGNORE, so an in-place update would silently never propagate). Readers
-- resolve "the" checkpoint for a height as MAX(checkpoint_seq).
CREATE UNIQUE INDEX chain_block_seq ON state_checkpoints (chain, network, block_index, checkpoint_seq);
CREATE        INDEX checkpoint_seq  ON state_checkpoints (chain, network, checkpoint_seq);
