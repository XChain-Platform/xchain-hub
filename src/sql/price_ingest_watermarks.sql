CREATE TABLE price_ingest_watermarks (
    source_chain          VARCHAR(10) NOT NULL PRIMARY KEY,   -- BTC | LTC | DOGE
    retraction_generation BIGINT NOT NULL DEFAULT 0,          -- highest source-chain rollback generation whose price retraction the hub has processed (HUB-RETRACT-4 ingest fence)
    from_action_index     BIGINT NOT NULL DEFAULT 0,          -- the from_action_index (orphaned-range lower bound) of that highest-generation retraction; a stale push at push_generation <= retraction_generation AND action_index >= this bound is rejected at ingest
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
