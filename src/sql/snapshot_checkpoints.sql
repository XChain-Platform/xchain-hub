DROP TABLE IF EXISTS snapshot_checkpoints;
CREATE TABLE snapshot_checkpoints (
    id                   BIGINT NOT NULL AUTO_INCREMENT,
    chain                VARCHAR(10) NOT NULL,
    network              VARCHAR(16) NOT NULL,
    block_index          BIGINT UNSIGNED NOT NULL,
    block_hash           CHAR(64) NOT NULL,
    state_root           CHAR(64) NOT NULL,
    state_root_version   INT NOT NULL,
    validator_signatures MEDIUMTEXT NOT NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_snap_ckpt (chain, network, block_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
