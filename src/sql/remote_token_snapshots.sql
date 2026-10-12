-- Federation-attested metadata for tokens observed on remote DEX legs.
DROP TABLE IF EXISTS remote_token_snapshots;
CREATE TABLE remote_token_snapshots (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    snapshot_id         CHAR(64) NOT NULL,
    snapshot_block      BIGINT UNSIGNED NOT NULL,
    network             VARCHAR(20) NOT NULL,
    coin                VARCHAR(10) NOT NULL,
    tick                VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    decimals            TINYINT UNSIGNED NOT NULL,
    owner               VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    source_action_index BIGINT UNSIGNED NOT NULL,
    finalizing_view     INT NOT NULL DEFAULT 0,
    validator_signatures TEXT NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'finalized',
    anchor_txid         VARCHAR(64),
    batch_seq           BIGINT UNSIGNED,
    btc_chain_id        CHAR(64) NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX snapshot_id ON remote_token_snapshots (snapshot_id);
CREATE INDEX pinned_remote_token ON remote_token_snapshots (network, coin, tick, snapshot_block);
