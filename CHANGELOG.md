# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.6] - 2026-04-06

### Added
- Boundary test suite (266 tests across 14 files) validating behavior at extreme input edges
- Quorum calculation boundary tests: N=0–100 across Consensus, OracleConsensus, CrossChainEngine, ReorgHandler
- Trimmed median aggregation boundary tests: trim threshold transitions (N=1–20), outlier handling, float precision, invalid data filtering
- PriceFetcher boundary tests: zero/negative/NaN/huge API responses, partial responses, dual-source failures
- Governance boundary tests: exact change bounds (50%/33%/25%/20%), tally quorum arithmetic, cooldown expiry
- SlashDetector boundary tests: exact 5% deviation threshold, missed rounds at 29/30/31, 24h repeated deviation window pruning
- Consensus PBFT boundary tests: leader rotation wrap-around, seq/view boundaries, PRE_PREPARE validation, duplicate vote dedup
- CrossChainEngine boundary tests: chain pair fallback with both orderings, confirmation thresholds per chain, attestation re-finalization
- ReorgHandler boundary tests: height 0, far-future timestamps, duplicate reorgId dedup
- RewardTracker boundary tests: division precision at N=1/3/7/100/1000, satoshi-level rounding loss
- Config management boundary tests: empty coin key filtering, PARAMETER_LIST enforcement, null/undefined/empty value handling
- Fee quote boundary tests: gas calculation precision, zero/small/large oracle prices, missing oracle data
- Validator registration boundary tests: pubkey regex edge cases (63/64/65 chars, non-hex), addr validation
- Database layer boundary tests: DB name regex, circuit breaker state transitions, doQuery argument handling
- P2P layer boundary tests: malformed envelope rejection, self-connection detection, dedup, signature verification modes

## [2.0.5] - 2026-04-06

### Added
- End-to-end test suite (64 tests across 8 files) validating full operational pipelines
- E2E test helpers: cluster manager (multi-hub in-process with real P2P), JSON-RPC client, price API mocks, async polling, DB assertion utilities
- Oracle E2E tests: price fetch → single-node finalization → JSON-RPC serving, API degradation, round skipping, reward distribution, multi-round persistence
- Config E2E tests: write/read round-trip, multi-coin updates, overwrite behavior
- Attestation E2E tests: single-node attestation lifecycle, SWAP initiation and status queries
- Governance E2E tests: proposal creation, vote casting, tally/pass, rejection with cooldown, change bounds enforcement
- Reorg E2E tests: rollback cascade (attestation deletion, reorg history), chain isolation
- Fee quote E2E tests: oracle-fed fee calculation, gas schedule verification, missing data handling
- API contract E2E tests: all 24 JSON-RPC methods validated, invalid input handling across all endpoints
- Multi-node E2E tests: 3-node cluster with real WebSocket P2P, PBFT oracle consensus, cross-chain attestation, cross-instance data consistency
- `npm run test:e2e` script

## [2.0.4] - 2026-04-06

### Added
- Smoke test suite (24 tests) for quick service health checks
- Covers env validation, DB schema init, JSON-RPC routing, config round-trip, PriceFetcher with mocked APIs, median calculation, oracle trimmed-median aggregation, circuit breaker state, and graceful handling of disabled subsystems
- `npm run test:smoke` script with `--bail` flag for fast-fail execution

## [2.0.3] - 2026-04-06

### Added
- Integration test suite (63 tests across 10 files) covering cross-module data flows
- Test infrastructure: testDb (real MariaDB setup/teardown), mockExternalApi (nock-based API mocking), testPeerNetwork (WS peer simulation, envelope builder)
- Oracle pipeline integration tests: price fetching, round lifecycle, persistence precision, reward distribution, slash detection
- Cross-chain integration tests: attestation PBFT, SWAP auto-progression, reorg rollback cascading writes
- Consensus integration tests: PBFT config consensus, single-node fallback, timeout/view-change
- Governance integration tests: proposal lifecycle, rejection, change bounds, cooldown, non-validator rejection
- JSON-RPC API integration tests: end-to-end Express server with config, validator, price, and fee quote endpoints
- P2P integration tests: real WebSocket message routing, deduplication, Ed25519 signature verification
- Resilience integration tests: circuit breaker activation/recovery, DB failure during finalization, concurrent operations
- `nock` devDependency for HTTP request interception
- `npm run test:integration` and `npm run test:all` scripts

## [2.0.2] - 2026-04-06

### Added
- Comprehensive unit test suite (295 tests) covering all 13 source modules
- Test infrastructure: mocha, chai, sinon, proxyquire devDependencies
- Shared test helpers: mockHub factory and fixtures (validator sets, sample prices)
- Tests for: ValidatorIdentity, OracleConsensus (trimmed median, PBFT), Consensus (PBFT, view change), SlashDetector (deviation/participation thresholds), CrossChainEngine (chain-pair filtering, attestation PBFT), PriceFetcher (API mocking), OracleRound, Governance (change bounds, tally logic), ReorgHandler (rollback, consensus), RewardTracker, SwapTracker, PeerManager (dedup, signatures), Database (circuit breaker), XChainHub orchestrator

### Changed
- `npm test` now runs mocha against `test/unit/**/*.test.js`

## [2.0.1] - 2026-04-06

### Changed
- Rewrite README.md to match xchain-sdk/xchain-indexer format: badges, feature bullets, documentation links, quick start, env vars, JSON-RPC API summary, database schema table, dependencies

## [2.0.0] - 2026-04-06

### Added
- Governance engine (`Governance.js`) — off-chain PBFT voting for parameter changes
- `governance_proposals` and `governance_votes` tables
- 7-day voting period with 2/3+ approval threshold and 50% quorum
- Proposal constraints: max 50%/33% change bounds (25%/20% for slashing params), 14-day cooldown after rejection
- `propose`, `vote`, `getproposals`, `getproposal` JSON-RPC methods
- Automatic proposal tallying when voting period ends
- `proposal:passed` event emitted for downstream parameter application
- HEARTBEAT messages now include hub software version for upgrade coordination
- `GOV_VOTING_PERIOD` env var (default 7 days)

### Changed
- **Major version bump to 2.0.0** — governance system completes the decentralized hub architecture (Phases 0-5)

## [1.9.0] - 2026-04-06

### Added
- SWAP lifecycle tracker (`SwapTracker.js`) — tracks cross-chain swaps through initiated → attested → executed → settled
- `swap_records` table for SWAP lifecycle persistence
- Per-chain-pair validator filtering in CrossChainEngine — only validators supporting both chains participate in cross-chain quorum
- `chains` and `tier` columns added to `validators` table (auto-migration on startup)
- Validators with NULL chains support all chain-pairs (backward compatible)
- `initiateswap`, `getswap`, `getswaps` JSON-RPC methods
- SwapTracker auto-progresses swap status on attestation finalization

## [1.8.0] - 2026-04-06

### Added
- Reorg handler (`ReorgHandler.js`) — cross-chain reorg propagation with PBFT consensus
- `reorg_attestations` table for storing confirmed reorg events
- Hub rollback on reorg: deletes attestations after reorg timestamp, invalidates price snapshots
- `REORG_ALERT` gossip message for reorg detection
- `XCHAIN_REORG_PREPARE` / `XCHAIN_REORG_COMMIT` for reorg consensus
- `reportreorg` JSON-RPC method — report a blockchain reorg for cross-chain propagation
- `getreorghistory` JSON-RPC method — query confirmed reorg attestations
- `reorg:confirmed` event emitted for downstream indexer notification

## [1.7.0] - 2026-04-06

### Added
- Cross-chain attestation engine (`CrossChainEngine.js`) — PBFT-based consensus for cross-chain action verification
- `attestations` table for storing finalized cross-chain attestations
- Attestation lifecycle: PROPOSE → PREPARE (2f+1) → COMMIT (2f+1) → store
- Per-chain confirmation thresholds (BTC: 3, LTC: 3, DOGE: 6)
- `requestattestation` JSON-RPC method — submit attestation requests
- `getattestations` JSON-RPC method — query stored attestations
- `getattestation` JSON-RPC method — get specific attestation by source chain + action index
- `attestation:finalized` event emitted for downstream processing
- Single-node fallback for attestations (stores directly without consensus)

## [1.6.0] - 2026-04-06

### Added
- Reward tracker (`RewardTracker.js`) — distributes XCHAIN rewards to oracle round participants
- Slash detector (`SlashDetector.js`) — detects price deviation (>5%), repeated deviation (3+ in 24h), and non-participation (30+ missed rounds)
- `validator_rewards` table for reward tracking with unclaimed/claimed status
- `slash_proposals` table for recording detected offenses
- `syncvalidators` JSON-RPC method — push validator set from external staking data
- `getvalidators` JSON-RPC method — list active validators
- `getvalidatorstatus` JSON-RPC method — detailed validator status with rewards and slash history
- `getfeequote` JSON-RPC method — calculates native coin fee amount via gas → XCHAIN → oracle conversion
- OracleConsensus now emits `round:finalized` event consumed by reward tracker and slash detector
- New env vars: `ORACLE_REWARD_PER_ROUND`, `SLASH_DEVIATION_THRESHOLD`, `SLASH_MISSED_ROUNDS_THRESHOLD`

## [1.5.0] - 2026-04-06

### Added
- Oracle consensus engine (`OracleConsensus.js`) — PBFT-like finalization for price rounds
- Trimmed median aggregation — discard top/bottom 15%, compute median of remaining submissions
- `price_snapshots` table for finalized price data (round_number, coin_pair, price, status, consensus_proof)
- Automatic round finalization after submission window closes
- Skipped round detection — rounds with no submissions stored as `status='skipped'`
- `getpricesnapshots` JSON-RPC method — returns recent finalized snapshots
- `getprice` JSON-RPC method — returns latest finalized price for a coin pair
- Single-node fallback — stores local prices directly as snapshots when no peers connected

## [1.4.0] - 2026-04-06

### Added
- Price oracle round system (`OracleRound.js`) — timer-based round lifecycle with configurable interval
- External price fetcher (`PriceFetcher.js`) — fetches BTC/USD, LTC/USD, DOGE/USD from CoinGecko and CoinMarketCap
- `ORACLE_PRICE_SUBMIT` gossip message — validators broadcast price submissions each round
- `oracle_submissions` table for persisting price submissions per round
- `getoraclesubmissions` JSON-RPC method for oracle diagnostics
- `startOracle()` and `getOracle()` methods on XChainHub
- New env vars: `ORACLE_ROUND_INTERVAL`, `ORACLE_SUBMISSION_WINDOW`, `COINGECKO_API_KEY`, `COINMARKETCAP_API_KEY`, `PRICE_FETCH_TIMEOUT`

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
