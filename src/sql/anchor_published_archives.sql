CREATE TABLE anchor_published_archives (
    network     VARCHAR(20)     NOT NULL,             -- mainnet/testnet/regtest (the wrapper checkpoint's network)
    batch_seq   BIGINT UNSIGNED NOT NULL,             -- the archive round's batch_seq (its on-chain identity)
    txid        VARCHAR(64),                          -- DOGE txid of the v1 head once the broadcast returned one (NULL while intent-only)
    intent_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,  -- when broadcast intent was durably recorded, BEFORE the v1 send
    sent_at     TIMESTAMP NULL DEFAULT NULL,          -- when the v1 broadcast returned a txid; NULL = intent only
    settled_at  TIMESTAMP NULL DEFAULT NULL,          -- when the round's bookkeeping finished; NULL = still in flight
    PRIMARY KEY (network, batch_seq),
    KEY idx_open_intent (network, settled_at, intent_at)
);

-- The restart-surviving half of the ARCHIVE-anchor at-most-once guard, the archive
-- twin of anchor_published_checkpoints. StateAnchorPublisher._publishArchive
-- broadcasts a v1 head plus N v2 chunks and only afterwards stamps the source rows
-- (_backfillBatch), so a crash in between left the cross_chain_matches /
-- cross_chain_calls / validator_rewards rows still matching the pending selectors
-- (`batch_seq IS NULL OR archived_status <> status`) with nothing anywhere recording
-- that DOGE had already paid for that batch. The next flush then rebuilt the whole
-- archive under a fresh batch seq and re-paid for every chunk.
--
-- The checkpoint marker cannot serve this path. getanchoraction serves
-- CHECKPOINT_VERSIONS only, so an archive round has NO mined-state query surface at
-- all: the ambiguous-error defer is in-memory and dies with the process, which makes
-- this table the only durable record of an archive send.
--
-- Why the hold is per-NETWORK and not per-batch_seq: a rebuild after a crash always
-- draws a FRESH seq (_getNextBatchSeq is MAX(batch_seq)+1, and two v1 anchors sharing
-- one seq corrupt chunk reassembly), so a marker consulted by exact batch_seq would
-- never match the round it has to stop. The publisher therefore holds on ANY unsettled
-- intent for the network, and `settled_at` is what distinguishes a round whose
-- bookkeeping finished (never blocks the next round) from one that vanished mid-flight
-- (blocks until it ages past ANCHOR_INTENT_TTL_MS).
--
-- Retention: swept on the same window and the same two invariants as
-- anchor_published_checkpoints (ANCHOR_MARKER_RETENTION_MS, floored at a multiple of
-- ANCHOR_INTENT_TTL_MS, confirmed rows only). This table is the stricter of the pair:
-- _getLiveArchiveIntent reads `settled_at IS NULL` rows only, so a settled row is never
-- read by any live path at all. See _pruneAnchorMarkers.
--
-- Hub-local audit, deliberately NOT mirrored: hub_db_sync's HUB_STATE_TABLES carries
-- state_checkpoints and anchor_reward_attestations only, and every sibling marker table
-- (oracle_published_rounds, attest_published_requests, anchor_published_checkpoints) is
-- likewise absent from the mirror lists, so HUB_SCHEMA_VERSION does not move for it.
