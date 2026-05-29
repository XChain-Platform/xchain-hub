CREATE TABLE telemetry_pings (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    install_id     CHAR(36)     NOT NULL,        -- anonymous UUID generated once per xchain-node install
    country        CHAR(2),                       -- derived from the connecting IP at ingest, then the IP is discarded
    region         VARCHAR(16),                   -- subdivision/state code, best-effort and often null, paired with country
    ip_hash        CHAR(64),                      -- keyed HMAC-SHA256(TELEMETRY_IP_SALT, ip) one-way hash, counts distinct sources without storing the IP
    node_version   VARCHAR(32),                  -- xchain-node version string
    os_platform    VARCHAR(32),                  -- os.platform() (linux/darwin/win32)
    os_release     VARCHAR(64),                  -- os.release()
    arch           VARCHAR(16),                  -- os.arch() (x64/arm64)
    docker_version VARCHAR(32),                  -- docker engine version, best-effort
    modules        JSON,                          -- [{module, coin, network, version, running}]
    event          VARCHAR(24),                  -- install | update | start | heartbeat
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_install (install_id),
    KEY idx_country (country),
    KEY idx_ip_hash (ip_hash),
    KEY idx_created (created_at)
);
