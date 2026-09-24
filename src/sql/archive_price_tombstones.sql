-- Hub-side only: the (round_number, coin_pair) keys a source-chain retraction deleted
-- from price_snapshots after an ANCHOR archive had already carried them, so recovery can
-- delete the key a replayed batch would otherwise resurrect. Filled by
-- insertPriceTombstonesForRetraction immediately before the delete; never mirrored.
-- db.verifyTables() picks this file up by directory scan at boot.
CREATE TABLE archive_price_tombstones (
    round_number BIGINT NOT NULL,
    coin_pair    VARCHAR(20) NOT NULL,
    batch_seq    BIGINT UNSIGNED DEFAULT NULL,   -- ANCHOR v1 archive batch that carried the tombstone; NULL = still owed
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (round_number, coin_pair)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
