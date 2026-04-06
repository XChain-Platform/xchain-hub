CREATE TABLE configs (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    coin        VARCHAR(16) NOT NULL,
    network     VARCHAR(16) NOT NULL,
    module      VARCHAR(64) NOT NULL,
    param_name  VARCHAR(32) NOT NULL,
    param_value TEXT,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY idx_config (coin, network, module, param_name)
);
