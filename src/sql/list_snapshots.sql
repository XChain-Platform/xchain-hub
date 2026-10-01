-- Hub-side append-only shared-list versions.
-- The per-hub id is only the mirror cursor; snapshot_id and the natural version
-- key identify a signed version across hubs.
DROP TABLE IF EXISTS list_snapshots;
CREATE TABLE list_snapshots (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    snapshot_id          CHAR(64) NOT NULL,
    snapshot_block       BIGINT UNSIGNED NOT NULL,
    network              VARCHAR(20),
    home_chain           VARCHAR(10),
    home_list_index      BIGINT UNSIGNED,
    list_type            TINYINT UNSIGNED,
    seq                  BIGINT UNSIGNED,
    kind                 VARCHAR(8),
    added                MEDIUMTEXT NOT NULL,
    removed              MEDIUMTEXT NOT NULL,
    members_hash         CHAR(64),
    origin_block         BIGINT UNSIGNED,
    admit_block_btc      BIGINT UNSIGNED DEFAULT NULL,
    admit_block_ltc      BIGINT UNSIGNED DEFAULT NULL,
    admit_block_doge     BIGINT UNSIGNED DEFAULT NULL,
    finalizing_view      INT NOT NULL DEFAULT 0,
    validator_signatures TEXT NOT NULL,
    status               VARCHAR(20) NOT NULL DEFAULT 'finalized',
    anchor_txid          VARCHAR(64),
    batch_seq            BIGINT UNSIGNED,
    btc_chain_id         CHAR(64) NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX uq_list_snapshot_seq ON list_snapshots (network, home_chain, home_list_index, seq);
CREATE UNIQUE INDEX snapshot_id         ON list_snapshots (snapshot_id);
CREATE        INDEX home_list           ON list_snapshots (home_chain, home_list_index);
