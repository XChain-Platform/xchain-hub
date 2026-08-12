CREATE TABLE anchor_published_checkpoints (
    chain          VARCHAR(10)     NOT NULL,             -- chain being checkpointed: BTC/LTC/DOGE
    network        VARCHAR(20)     NOT NULL,             -- mainnet/testnet/regtest
    checkpoint_seq BIGINT UNSIGNED NOT NULL,             -- state_checkpoints.checkpoint_seq (its uq_chain_seq identity)
    txid           VARCHAR(64),                          -- DOGE txid once the broadcast returned one (NULL while intent-only)
    intent_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,  -- when broadcast intent was durably recorded, BEFORE the send
    sent_at        TIMESTAMP NULL DEFAULT NULL,          -- when the broadcast returned a txid; NULL = intent only
    PRIMARY KEY (chain, network, checkpoint_seq),
    KEY idx_intent (intent_at)
);

-- The restart-surviving half of the checkpoint-anchor at-most-once guard,
-- the same marker the three sibling hub effectors already carry (OraclePublisher's
-- oracle_published_rounds, AttestationPublisher's attest_published_requests,
-- AttestationRelay's WAL). StateAnchorPublisher stamps state_checkpoints
-- .anchor_txid only AFTER the broadcast returns, and the existence check reads
-- getanchoraction, which resolves txids through MINED blocks only, so a crash between
-- an accepted-but-unmined send and that stamp left nothing anywhere recording that DOGE
-- had already paid. This table is that record.
--
-- Hub-local audit, deliberately NOT mirrored: hub_db_sync's HUB_STATE_TABLES carries
-- state_checkpoints and anchor_reward_attestations only, and the two sibling marker
-- tables are likewise absent from every mirror list.
--
-- Keyed on (chain, network, checkpoint_seq) rather than block_index because that is the
-- state_checkpoints uq_chain_seq identity: two BTC-tip-skewed leaders at one seq share
-- one marker instead of minting two, which is the same split-brain property that key
-- exists for.
