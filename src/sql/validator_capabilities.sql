CREATE TABLE validator_capabilities (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signing_pubkey  CHAR(64) NOT NULL,
    capability      ENUM('price','cross_chain','oracle_publish','attestation','full_node') NOT NULL,
    qualified       TINYINT(1) NOT NULL DEFAULT 0,             -- stake amount meets min_stake[capability]
    self_test_ok    TINYINT(1) NOT NULL DEFAULT 0,             -- latest selfTest() passed
    enabled         TINYINT(1) NOT NULL DEFAULT 1,             -- operator hasn't opted out via config
    self_test_at    TIMESTAMP NULL DEFAULT NULL,                -- when self_test was last run
    self_test_msg   VARCHAR(255),                               -- reason text on failure
    qualified_at_block BIGINT UNSIGNED NULL,                    -- on-chain block where qualification last computed
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pubkey_capability (signing_pubkey, capability),
    KEY idx_qualified (qualified, capability),
    KEY idx_selftest  (self_test_ok, capability),
    KEY idx_enabled   (enabled, capability)
);
