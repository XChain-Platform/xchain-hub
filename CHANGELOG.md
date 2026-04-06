# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-04-06

### Added
- Ed25519 validator identity (`ValidatorIdentity.js`) — message signing and signature verification using Node.js built-in crypto
- `validators` table for validator registry (signing pubkey, addr, status)
- `registervalidator` JSON-RPC method for bootstrap validator registration
- Leader rotation in PBFT consensus — deterministic leader per sequence number from sorted validator set
- View change protocol — `PBFT_VIEW_CHANGE` and `PBFT_NEW_VIEW` messages for leader failover on timeout
- Signature verification in PeerManager — incoming messages verified against registered validator pubkeys
- `SIGNING_PRIVKEY_HEX` env var for Ed25519 private key
- `REQUIRE_SIGNATURES` env var (default false) — when true, rejects unsigned P2P messages

### Changed
- PeerManager broadcasts now include Ed25519 signature in envelope `sig` field (when identity is configured)
- Consensus quorum now uses registered validator set size (not transient peer count)
- Consensus timeout now triggers view change (leader rotation) instead of simple rejection

## [1.2.0] - 2026-04-06

### Added
- PBFT consensus engine (`Consensus.js`) for config writes
- Config updates now go through PRE_PREPARE → PREPARE → COMMIT consensus round
- Quorum calculation: `2f+1` where `f = floor((N-1)/3)` (tolerates f Byzantine faults)
- `consensus_state` table for persistent sequence number tracking
- Single-node fallback: when no peers are connected, writes apply directly (backward compatible)
- Configurable consensus timeout via `PBFT_TIMEOUT` env var (default 30s)
- `startConsensus()` and `getConsensus()` methods on XChainHub
- `applyConfig()` method on XChainHub (separates consensus proposal from DB write)

## [1.1.0] - 2026-04-06

### Added
- P2P gossip layer (`PeerManager.js`) for validator-to-validator communication
- WebSocket-based peer connections with exponential backoff reconnection
- Heartbeat broadcasts every 15 seconds for liveness detection
- Message deduplication with configurable TTL
- Gossip relay (flood-fill) for small validator networks
- WS ping/pong dead connection detection (30-second interval)
- `p2p_peers` table for peer tracking
- New env vars: `P2P_PORT`, `P2P_HOST`, `SEED_NODES`, `P2P_VALIDATOR_ADDR`, etc.
- P2P is optional — hub works without it for backward compatibility
- `getPeerManager()` method on XChainHub for higher-layer access (PBFT, oracle)

## [1.0.0] - 2026-04-06

### Changed
- **BREAKING:** Replace LevelDB storage with MariaDB for platform alignment
- Replace `LevelUpDb.js` with `db.js` (MariaDB Database class with connection pool, circuit breaker, exponential backoff)
- Update `XChainHub.js` constructor to accept DB connection parameters
- Update `api.js` with required env var validation and proper DB initialization
- Replace `body-parser` with built-in `express.json()`
- Remove `/data/` volume from Dockerfile (LevelDB no longer used)
- Bump version to 1.0.0

### Added
- MariaDB `configs` table schema (`src/sql/configs.sql`)
- Auto-create database and tables on startup
- Required environment variable validation (`HUB_DB_HOST`, `HUB_DB_PORT`, `HUB_DB_NAME`, `HUB_DB_USER`, `HUB_DB_PASS`, `HUB_PORT`)
- Circuit breaker with exponential backoff for DB connections
- `setParam()` with upsert (INSERT ... ON DUPLICATE KEY UPDATE)

### Removed
- `levelup` and `leveldown` dependencies
- `LevelUpDb.js` (replaced by `db.js`)

## [0.0.3] - 2026-03-25

### Added
- CHANGELOG.md to track project changes
