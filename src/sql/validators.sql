CREATE TABLE validators (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signing_pubkey  CHAR(64) NOT NULL UNIQUE,
    addr            VARCHAR(255) NOT NULL,
    status          ENUM('active','suspended','removed') NOT NULL DEFAULT 'active',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
