# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.3] - 2026-05-28

### Fixed
- Governance proposal tallying is now performed by a single deterministic leader per proposal rather than independently on every hub. Because validator votes propagate via P2P gossip with variable latency, two hubs could previously tally the same expired proposal at different moments with different vote counts and reach contradictory `passed`/`failed` conclusions, leaving governance state split-brain across the federation. The leader is chosen deterministically from the active validator set (hash of the proposal id, same modular-index pattern as oracle consensus); followers accept the broadcast `GOV_RESULT` as authoritative. Standalone hubs with no validator set still tally locally.
- `_tallyProposal` now guards its status write with `AND status = 'voting'`, so a stale or duplicate result broadcast cannot overwrite an already-finalized proposal.
- Governance now emits `proposal:finalized` (previously `proposal:passed`) to match the attestation provider-registry hot-reload listener in `XChainHub`. The mismatch meant a passed proposal never triggered the runtime provider-config reload; the reload now fires as intended.

## [2.2.2] - 2026-05-28

### Fixed
- `getFeeQuote` now carries the full 17-entry gas schedule (previously 7). Fee quotes for `OWNERSHIP_ESCROW`, `VM_DEPLOY_PER_BYTE`, `VM_STATE_READ`/`VM_STATE_WRITE`/`VM_STATE_DELETE`, `VM_ORACLE_READ`, `VM_CROSSCHAIN_READ`, `VM_ATTEST_REQUEST`, `VM_EMISSION`, and `VM_COMPUTATION` now return a numeric fee instead of an `unknown action` error.

### Changed
- `getFeeQuote` sources the gas price from the config store (per-chain, `chain` module), falling back to the protocol default `0.00001` when no override is present or the store is unavailable, instead of a hardcoded constant.

## [2.2.1] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths.

## [2.2.0] - 2026-05-28

### Added
- New JSON-RPC method `pushpricereorg` (write — requires API key) — an indexer calls this after a block rollback to retract price rows seeded from rolled-back PRICE actions. Params: `{ source_chain, from_action_index }`. The hub previously only invalidated price snapshots on a separate PBFT reorg attestation (`ReorgHandler`), which never arrives for non-PBFT reorgs, leaving never-finalized prices in `price_snapshots` / `oracle_prices` indefinitely.
- `PriceAggregator.retractFromActionIndex(sourceChain, fromActionIndex)` — deletes `price_snapshots` rows (keyed by `source_action_index`) and `oracle_prices` rows (keyed by `action_index`) for the given chain at or above the supplied action index, and emits `row:deleted` events with the deletion filter. Returns per-table deleted-row counts.
- `HubDbBroadcaster.broadcastDeletion(event)` — forwards `row:deleted` retraction events (`{ table, source_chain, from_action_index }`) over the `/hub-db/subscribe` WebSocket channel so distributed indexers prune their local `price_snapshots` / `oracle_prices` copies, mirroring the existing `row:inserted` broadcast path.

### Changed
- `XChainHub` — wires `PriceAggregator`'s new `row:deleted` event to `HubDbBroadcaster.broadcastDeletion`, alongside the existing `row:inserted` → `broadcastRow` wiring.

## [2.1.0] - 2026-04-08

### Added
- `PriceAggregator.js` — receives validated PRICE v0/v1 actions from indexers across all chains, deduplicates by `round_number` (v0) or `(source_chain, action_index)` (v1), writes to unified `price_snapshots` and `oracle_prices` tables. EventEmitter — emits `row:inserted` for the hub DB sync channel. Applies 24-hour lock window for PRICE v1 (first broadcast immediate, subsequent delayed).
- `OraclePublisher.js` — Tier 3 oracle publisher for broadcasting finalized PRICE v0 transactions to the DOGE chain. Features: deterministic leader rotation (`round % active_tier3_count`, sorted by `signing_pubkey`), persistent JSONL queue with fsync, PRICE v0 wire format builder, DOGE balance monitoring with WARN/ERROR log thresholds. Subscribes to `OracleConsensus` `round:finalized` events and uses collected validator signatures from the PBFT prepare/commit phases.
- `EncoderClient.js` — minimal JSON-RPC client for talking to `xchain-encoder` (`get_utxos`, `create_tx`, `broadcast_tx`). Used by `OraclePublisher` for the default DOGE broadcast pipeline.
- `HubDbBroadcaster.js` — WebSocket subscriber registry that forwards `PriceAggregator` row events to connected indexer hub DB sync clients. Includes backpressure handling (drops connections exceeding `WS_BACKPRESSURE_LIMIT` buffered messages).
- `sql/oracle_prices.sql` — new table for cross-chain user TOKEN/FIAT oracle prices with `effective_at` column enforcing the 24-hour price lock window.
- `setChainTip()` / `getChainTip()` in `db.js` — stores the latest BTC/LTC/DOGE chain tip in the `configs` table, used by `OracleRound._executeRound()` to anchor oracle rounds to real BTC block heights (fixes the hardcoded `reference_block=0` bug).
- New JSON-RPC methods on hub API: `pushchaintip`, `pushpriceround`, `pushoracleprice` — write methods (require API key) for indexers to push chain state and validated PRICE actions to the hub.
- REST snapshot endpoints: `GET /hub-db/snapshot/price_snapshots` and `GET /hub-db/snapshot/oracle_prices` with `since_id` pagination for incremental bootstrap of indexers' local hub DB copies.
- WebSocket channel `/hub-db/subscribe` — streams `row:inserted` events for the hub's cross-chain price tables to subscribed indexers. Requires `Authorization: Bearer <HUB_API_KEY>`.
- Multi-validator signature aggregation in `OracleConsensus.js` — each validator signs the canonical PRICE v0 payload (`JSON.stringify({round, timestamp, sortedPairs})`) during PBFT prepare/commit phases. Signatures travel in PROPOSE/PREPARE/COMMIT messages and collect on `pending.signatures` Map. The `round:finalized` event now carries the collected signatures array so `OraclePublisher` can embed real validator sigs in the published PRICE v0 transaction.
- `_signPriceV0()`, `_buildPriceV0Payload()`, `_verifyAndStoreSig()` helpers in `OracleConsensus.js` — canonical payload construction matching the indexer's `ed25519.js` format.

### Changed
- `OracleConsensus.js` — `_storeSnapshot()` and `_storeSkippedRound()` now accept `btcBlockHeight` and `btcBlockTime` parameters, replacing the hardcoded `reference_block=0` and `block_timestamp=Date.now()` values. Cross-node determinism fix: two independent nodes processing the same BTC block height now produce identical oracle snapshots.
- `OracleConsensus.finalizeRound(round, btcBlockHeight, btcBlockTime)` — accepts and threads BTC chain tip values through PBFT pending rounds to storage and round:finalized events.
- `OracleRound.js` — `_executeRound()` reads BTC chain tip from `db.getChainTip('BTC')` at the start of each round and passes it through `_scheduleFinalization()` to `OracleConsensus.finalizeRound()`.
- `PriceFetcher.js` — rewritten to support 3 coins × 12 fiat currencies = **36 pairs per round**. CoinGecko and CoinMarketCap APIs are now called with `vs_currencies` / `convert` parameters for all 12 fiats in a single call. Supported fiats: USD, CAD, AUD, MXN, GBP, JPY, CNY, CHF, BRL, INR, EUR, KRW. New static method `PriceFetcher.getCoinPairs()`.
- `OracleConsensus._storeSkippedRound()` — now uses `PriceFetcher.getCoinPairs()` for dynamic pair list instead of hardcoded `['BTC/USD', 'LTC/USD', 'DOGE/USD']`.
- `sql/price_snapshots.sql` — added `source_chain VARCHAR(10)` column (defaults to `DOGE`) to track which chain carried the PRICE v0 transaction, plus `source_action_index BIGINT` for audit. New index on `source_chain`.
- `RewardTracker.js` — `distributeRewards()` now accepts a `btcBlockHeight` parameter and pushes reward records to the BTC indexer via the new `pushvalidatorrewards` JSON-RPC endpoint. Populates the previously-empty indexer `validator_rewards` table so `CLAIM_REWARDS` can find unclaimed rewards.
- `XChainHub.start()` — instantiates `PriceAggregator` and `HubDbBroadcaster` (both available in all modes). In validator mode, `startOracle()` also instantiates and starts `OraclePublisher`.
- Hub `api.js` — now uses an explicit `http.Server` with WebSocket upgrade handler attached (for the hub DB sync channel). New `WRITE_METHODS` entries for the three new push methods.

### Fixed
- `reference_block` hardcoded to `0` in `_storeSnapshot()` and `_storeSkippedRound()` — now uses the BTC chain tip at the time of round execution. Previously broke cross-node determinism for fee validation and VM oracle queries.
- `block_timestamp` in price snapshots — now uses the BTC block's `block_time` instead of wall-clock `Date.now()`.
- `round:finalized` event — now carries `btcBlockHeight`, `btcBlockTime`, and `signatures` fields for downstream consumers.
- `README.md` — updated version badge to 2.0.12, added tests badge (1,222 passing), coverage badge, test suite breakdown table, expanded scripts table with all test commands, added development dependencies section, added links to new DATABASE.md and OPERATIONS.md documentation

## [2.0.12] - 2026-04-06

### Added
- Comprehensive regression test suite (195 tests across 7 files) covering:
  - Consensus PBFT: quorum math, leader rotation, full PRE_PREPARE→PREPARE→COMMIT flow, view change, sequence persistence, replay prevention, single-node fallback, digest determinism
  - Oracle pipeline: PriceFetcher local median, trimmed median aggregation (15% trim), PBFT finalization, price validation, 8-decimal formatting, single-node fallback
  - Cross-chain engine: attestation PBFT flow, confirmation thresholds (BTC=3, LTC=3, DOGE=6), chain-pair validator filtering, attestation:finalized events
  - SwapTracker: auto-progress on attestation finalization, lifecycle management, null safety
  - ReorgHandler: PBFT reorg consensus, attestation rollback, price snapshot dispute marking, affected chain computation
  - Governance: proposal lifecycle, vote collection, 2/3+50% quorum tally, parameter change bounds (±50%/±33% normal, ±25%/±20% slashing), 14-day cooldown
  - P2P & ValidatorIdentity: Ed25519 sign/verify round-trip, envelope signatures, message deduplication, signature enforcement, identity seed validation
  - Database: circuit breaker open/half-open/closed, parameterized queries, SQL injection prevention, config CRUD hierarchy
  - Incentives: equal-split reward distribution, slash detection (price deviation >5%, repeated deviation 3+/24h, non-participation 30+ rounds)
- Three-tier test execution via Mocha `--grep`:
  - `test:regression:p0` — 78 critical tests (<1s) for every commit
  - `test:regression:p0p1` — 154 high-priority tests (3s) for PR gating
  - `test:regression` — full 195-test suite (3s) for nightly/pre-release
- Regression testing plan document at `reports/XCHAIN_HUB_REGRESSION_TESTING_PLAN.md`

## [2.0.11] - 2026-04-06

### Added
- Mutation testing infrastructure using StrykerJS
- `stryker.config.json` — full mutation config targeting all `src/**/*.js` (excludes SQL schemas)
- `stryker.config.phase1.json` — pilot config targeting `Consensus.js` and `OracleConsensus.js` only
- `npm run test:mutate` script for full mutation testing
- `npm run test:mutate:pilot` script for Phase 1 pilot runs
- `@stryker-mutator/core` and `@stryker-mutator/mocha-runner` devDependencies

## [2.0.10] - 2026-04-06

### Added
- Chaos engineering test suite (81 tests, 14 files) covering:
  - Database resilience: circuit breaker lifecycle, flapping connections, pool exhaustion
  - Oracle fault tolerance: single source failure, total blackout, malformed price data
  - Consensus disruption: network partition, leader crash, quorum loss
  - Compound failures: reorg during oracle round, validator churn during consensus
  - API abuse protection: rate limit saturation, concurrent burst handling
- Chaos test helpers: experiment runner, steady-state checker, metrics collector
- `test:chaos` npm script (`mocha --timeout 30000`)

## [2.0.9] - 2026-04-06

### Added
- Performance and load testing suite (6 test files, 3 helpers) covering:
  - API query saturation with concurrent blast and ramp-up tests
  - Oracle round execution timing and degradation under load
  - P2P WebSocket message flood, dedup cache, and rate limiting verification
  - MariaDB connection pool stress, mixed read/write concurrency, and saturation
  - 2-minute soak test with memory leak detection and p95 trend analysis
  - Dependency degradation scenarios (slow/failed APIs, recovery timing)
- `test:perf` npm script (`mocha --timeout 300000`)
- Reusable performance helpers: `Histogram`, `MemoryTracker`, `blast()`, `ramp()`, `seedAll()`

## [2.0.8] - 2026-04-06

### Added
- API key authentication for write methods via `HUB_API_KEY` env var
- Rate limiting on JSON-RPC endpoint via `express-rate-limit` (`HUB_API_RATE_LIMIT`, default 100/min)
- Configurable CORS origin restriction via `CORS_ORIGIN` env var
- Chain validation (BTC/LTC/DOGE only) on all chain-accepting endpoints
- Limit parameter validation (positive integer, max 1000) on list endpoints
- Per-IP connection limit on P2P WebSocket server (`P2P_MAX_CONNECTIONS_PER_IP`, default 3)
- Per-peer message rate limiting on P2P layer (`P2P_MSG_RATE_LIMIT`, default 100/min)
- Dedup cache size bound to prevent memory exhaustion (`P2P_DEDUP_CACHE_MAX`, default 100000)
- Peer address format validation before WebSocket connection
- Consensus sequence monotonicity check to reject replayed PRE_PREPARE messages
- Single-node mode warning when `MIN_VALIDATORS` > 1 but no peers connected
- Minimum submission count for oracle round finalization (`ORACLE_MIN_SUBMISSIONS`, default 1)
- Price sanity bounds (> 0, < 10M) on oracle submissions, aggregation, and external API responses
- Max submissions per oracle round (`ORACLE_MAX_SUBMISSIONS_PER_ROUND`, default 200)
- Cross-chain attestation ID format validation
- Reorg report parameter validation (chain, height, timestamp) and rate limiting (1 per chain per 60s)
- Governance voter authorization (must be active validator to vote)
- Governance parameter name length limit (255 chars) and rationale length limit (2000 chars)
- Reward participant pubkey validation (must be 64 hex chars)
- Slash proposal pubkey validation and in-memory deviation array bounds (max 1000)
- Database query timeout (`DB_QUERY_TIMEOUT`, default 30s)
- Config structure validation with value length limit (1024 chars) and type coercion
- Security test suite (72 tests) covering all hardening measures
- `express-rate-limit` production dependency

### Changed
- `REQUIRE_SIGNATURES` now defaults to `true` (was `false`) — P2P messages require Ed25519 signatures by default
- Object query arguments serialized via `JSON.stringify()` instead of `toString()` with warning log
- Null-safe traversal for CoinGecko and CoinMarketCap API response parsing
- Invalid JSON on P2P WebSocket now logged at warn level instead of silently discarded

## [2.0.7] - 2026-04-06

### Added
- Fuzz testing suite (88 properties across 7 test files) using fast-check for property-based testing
- Shared generator module with 17 composable fast-check arbitraries for prices, submissions, P2P envelopes, hex strings, configs, and governance parameters
- OracleConsensus fuzz tests: trimmed median aggregation invariants, NaN/Infinity filtering, quorum monotonicity, digest determinism
- PeerManager fuzz tests: structural robustness against arbitrary JSON, malformed envelope rejection, deduplication correctness, ID uniqueness
- PriceFetcher fuzz tests: median bounds and immutability, API response parsing robustness, output format validation
- Consensus PBFT fuzz tests: leader rotation, quorum bounds, digest properties, PrePrepare message validation
- Governance fuzz tests: change bound enforcement for normal and slashing parameters, tally quorum arithmetic
- Fee quote fuzz tests: gas arithmetic consistency, round-trip precision, unknown action handling
- ValidatorIdentity fuzz tests: constructor validation, sign/verify round-trip, mutation detection, cross-key rejection

### Fixed
- Infinity values leaking through oracle price aggregation — replaced `!isNaN(val)` with `isFinite(val)` in `_aggregate()` filter
- TypeError crash in PeerManager when receiving non-object JSON (null, number, string) — added type guard after JSON.parse
- Message ID collisions under high throughput — replaced `Math.random()` with `crypto.randomUUID()` in `_makeId()`
- Object.prototype pollution in fee quote gas schedule lookup — replaced bracket notation with `hasOwnProperty` check

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
