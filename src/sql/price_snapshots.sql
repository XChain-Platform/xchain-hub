CREATE TABLE price_snapshots (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    round_number        BIGINT NOT NULL,
    coin_pair           VARCHAR(20) NOT NULL,
    price               VARCHAR(40),
    reference_block     BIGINT NOT NULL DEFAULT 0,
    reference_chain     VARCHAR(10) NOT NULL DEFAULT 'BTC',
    block_timestamp     BIGINT NOT NULL DEFAULT 0,
    validator_count     INT NOT NULL,
    consensus_round     INT DEFAULT 1,
    consensus_proof     TEXT NOT NULL,
    status              ENUM('finalized','skipped','disputed') NOT NULL,
    source_chain        VARCHAR(10) NOT NULL DEFAULT 'DOGE',  -- which chain carried the PRICE v0 tx (audit/diagnostics)
    source_action_index BIGINT,                                -- action_index of the PRICE tx on source_chain (NULL for hub-finalized)
    push_generation     BIGINT NOT NULL DEFAULT 0,             -- source-chain reorg fence (item 5308): see oracle_prices
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_round_pair (round_number, coin_pair),
    KEY idx_pair_block (coin_pair, reference_block),
    KEY idx_pair_timestamp (coin_pair, block_timestamp),
    KEY idx_status (status),
    KEY idx_source_chain (source_chain)
);
