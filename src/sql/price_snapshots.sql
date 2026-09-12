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
    push_generation     BIGINT NOT NULL DEFAULT 0,             -- source-chain reorg fence: see oracle_prices
    batch_block_time    BIGINT NOT NULL DEFAULT 0,             -- clock of the block the PRICE batch carrying this round LANDED in; 0 = no landed batch seen yet (a round this hub finalized over P2P, ahead of its batch). Stamped by PriceAggregator batch ingest for every round a landed batch carries, stored or deduped, and mirrored to every indexer that follows this hub.
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_round_pair (round_number, coin_pair),
    KEY idx_pair_block (coin_pair, reference_block),
    KEY idx_pair_timestamp (coin_pair, block_timestamp),
    KEY idx_status (status),
    KEY idx_source_chain (source_chain),
    -- The landing stamp is written by round_number and read by (coin_pair, landing
    -- clock, round_number) on the indexer side; keep the hub copy indexed the same way
    -- so the mirror's bootstrap paging and the hub's own snapshot reads share it.
    KEY idx_pair_batchtime_round (coin_pair, batch_block_time, round_number)
);
