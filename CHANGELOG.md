# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Sensitive-read auth tier: `getallconfigs` requires `x-api-key` when `HUB_API_KEY` is set (its response carries DB credentials), completing the app-side policy that lets the public reverse proxy drop its IP allowlist; emergency opt-out via `HUB_SENSITIVE_READ_AUTH=0`.
- `GET /api/v1/chain-registry`: public wallet/SDK bootstrap endpoint serving the wallet-synced chain descriptors (`src/chain-registry.json`), Ed25519-signed when the hub has an identity.
- Read-only JSON-RPC methods `getvotes` and `getvalidatorcapabilities`, plus optional `parameter`/`limit` filters on `getproposals`, so explorers can serve governance and capability pages over RPC instead of a co-located hub DB.

### Fixed
- `docs/openrpc.build.js` regains the three methods that were only hand-added to `openrpc.json`, so regenerating the spec no longer drops them.
- Correct the `/health` config-fetch counter comment: the `config_fetch` counts are body-only telemetry, deliberately not wired to the `healthy`/503 status (a config-fetch error must not pull a healthy hub out of federation rotation); an alerting probe compares `config_fetch.errors` across scrapes.

## [2.2.16] - 2026-06-20

### Added
- Add multi-fiat price-fetch coverage (`mockExternalApi.js`, `priceFetch.integration.test.js`, `generators.js`): 12-fiat fixtures, SC-1.7 asserting all 36 pairs, and a higher fuzz `fc_price()` bound; test-only.
- `verifyTables()` now reconciles column drift on existing tables at startup via `parseExpectedColumns()`/`alterTableForDrift()`, adding source-declared columns and relaxing nullability in the safe direction only.
- Add `.env.example` and `CONFIGURATION.md` documenting every hub environment variable by concern, flagging `HUB_API_KEY` and `SIGNING_PRIVKEY_HEX` as silently-failing-when-empty.
- Add `chainTipStalenessMs` to the `getoraclesubmissions` diagnostics response (`OracleRound.getSubmissionsInfo()`), reporting age in ms of the last successful BTC chain-tip read.
- Add a `health` JSON-RPC method that probes the DB and reports the circuit-breaker state (`dbCircuit`), returning HTTP 503 when the DB is unreachable or the breaker is open.

### Changed
- `XChainHub.js`: the BTC indexer-URL resolver reads the renamed flat-config key `INDEXER_URL` (was `INDEXER_HOST`); nested lookup unchanged, no behavioral change.
- `package.json`: pinned `mariadb` 3.5.2 to exact versions (dropped `^` caret ranges) so installs resolve a byte-identical tree; no source changes.
- `OracleConsensus.js`: `_storeSkippedRound()` takes a `reason` argument so the round-skipped log states why (`no submissions` / below-threshold / empty aggregation); log-message-only.
- `OraclePublisher.js`: the constructor now reads `queuePath`/`maxAttempts` from `hub.p2pConfig` as a fallback when the env vars are unset, matching `AttestationPublisher`'s dual-read pattern.
- `validators.sql`, `XChainHub.js`: the `validators.chains` column is now schema-declared and added by startup drift reconciliation, replacing the ad-hoc DDL-on-read in `_loadChainPairValidators()`.
- `AttestationRound.js`: removed an empty `peerManager` `'message'` listener and its no-op `_handleMessage()` stub; `AttestationConsensus` still handles all attestation PBFT messages.
- `getallconfigs` (`api.js`, `db.js`, `XChainHub.js`) now accepts an optional `since_updated_at` cursor and returns a `watermark`, replacing the unbounded full-table SELECT on every poll; backward-compatible. Adds `getConfigWatermark()`.
- `getallconfigs` (`api.js`, `db.js`, `XChainHub.js`) now returns `{ configs, seq }` where `seq` is the last PBFT-committed consensus sequence, so consumers detect committed config changes without a restart; backward-compatible. Adds `getLastSeq()`.
- `package.json`: aligned the `mariadb` driver to the platform-wide `^3.5.2` range (was `~3.4.5`), removing version drift and the mixed `~`/`^` operators; no source changes.
- `XChainHub._resolveBtcLatestBlock` now ignores an indexer tip whose `lag` exceeds `MAX_INDEXER_LAG_BLOCKS` (default `200`), falling through to graceful degradation instead of locking a stale validator set; only the `getlatestblock` fallback is affected.
- Upgraded `express-rate-limit` from `^7.5.0` to `^8.5.2`, switching `src/api.js` to v8 option names (`windowMs`, `limit`, `standardHeaders`, `legacyHeaders`); runtime behavior unchanged.
- Renamed the rate-limit env var `HUB_API_RATE_LIMIT` to `HUB_RATE_LIMIT_RPM` (default `100` rpm); operators must migrate, the old name is no longer read.

### Fixed
- Capability `MIN_STAKE` thresholds are now block-anchored across `CapabilityRegistry`/`Governance`/`CapabilitySnapshot`/`XChainHub`: a `MIN_STAKE` proposal carries a validated `activation_block` resolved per-block so every hub locks the same qualifying set and quorum `N`; consensus change, deploy the fleet atomically.
- `CapabilitySnapshot.js`, `XChainHub.js`: the validator-set snapshot cache now keys on the resolved `min_stake` and is flushed via `flushCapability()` on a `MIN_STAKE` change, so a governance change can no longer leave two hubs computing different quorums for the same round.
- `StateAnchorPublisher.js`: the checkpoint-anchor election now fails closed when the `oracle_publish` eligible set is empty (deferring the round) instead of letting every hub double-anchor; `_mayPublish([], …)` returns `false`.
- `CrossChainCallEngine.js`, `.env.example`: a relayed call's `effective_time` is now stamped a forward margin (`XCALL_RELAY_MARGIN_BLOCKS` × block interval, capped below the 3600s skew bound) so live and replaying nodes inject at the same block, preventing `call_id` desync.
- `AttestationConsensus.js`: `judge_model` (`llm`) attestations at redundancy 3/5 are now fulfillable: every responsible validator re-signs the canonical winning body and `_checkCommitQuorum` gates on `signatures.size >= needed`; `byte_equality` divergence still correctly expires.
- `StateAnchorPublisher.js`: the v1 ANCHOR archive is now signed and quorum-checked against the `oracle_publish` set at the wrapper's `snapshot_block` (not the current election block), and `_publishArchive` keeps rows pending when on-chain quorum is not reached instead of dequeuing them.
- `RewardTracker.js`, `StateAnchorPublisher.js`: `recordAnchorReward` now applies a cross-pubkey dedup keeping the lexicographically-smallest pubkey, so an anchor-publish failover overlap no longer mints two rewards for one checkpoint; archived rows are immutable.
- `api.js`, `.env.example`, `CONFIGURATION.md`: `HUB_API_KEY` is optional at boot again and the no-key mode logs a loud warning; both gates enforce only when a key is configured, fixing keyless `xchain-node` crash-loops.
- `AttestationPublisher.js`: lowered `ATTEST_WIRE_MAX_BYTES` from `8192` to `8189` (the largest raw payload that fits the encoder's compiled OP_PUSHDATA2 ceiling) so an over-limit attestation is rejected here with a clear message.
- `XChainHub.js`: removed `FEE_PAYMENT_MODE` from `OPERATIONAL_PARAMS` since the indexer derives fee mode from coin and fee output and never reads the override, making the published governance surface match actual behavior.
- `PriceFetcher.js`: `fetchFromCoinMarketCap()` now retries transient 429/503 with the same backoff as CoinGecko via a shared `_fetchWithRetry()` helper, restoring dual-source price redundancy.
- `OracleConsensus.js`: the oracle round now survives a leader that crashes after submitting but before proposing; the lowest-address non-leader submitter arms a `ORACLE_LEADER_TIMEOUT_MS` grace (default 30s) and takes over as fallback proposer, self-aborting if a PROPOSE arrives.
- `ReorgHandler.js`: a reorg consensus round that times out without quorum now emits a `reorg:timeout` event with the discarded rollback details before deleting the pending entry, on both initiator and follower paths.
- `ReorgHandler.js`: the reorg consensus quorum is now locked into the pending round at start instead of recomputed live per check, matching the other engines, so a mid-round N change can no longer split COMMIT quorum.
- `CrossChainEngine.js`, `XChainHub.js`: cross-chain attestation quorum is now locked to a deterministic block-boundary `cross_chain` capability snapshot (leader stamps `btcBlockHeight`, all hubs resolve via `_resolveQuorum()`); `syncValidators()` also reloads `crossChain`'s set.
- `OracleConsensus.js`: `_aggregate()` now counts at most one price per sender per coin pair (inner loop `break`s after the first valid value), so a duplicated outlier can no longer skew the trimmed-median trim boundary.
- `AttestationConsensus.js`: an `ATTEST_COMMIT` arriving after `pending` exists but before its winner is established is now buffered in `earlyCommits` and replayed once the winner is set, restoring liveness when the responsible-set quorum is greater than one.
- `AttestationConsensus.js`: the PBFT handlers now reject an oversized peer-supplied `body_b64` (cap derived from the provider's `max_response_bytes` × 1.4, default 64 KB) before the Buffer decode, closing a memory-amplification DoS vector.
- `PriceAggregator.js`: `receiveOraclePrice` now scopes the 24h effective-at lock-window check to `source_chain`, so a first cross-chain submission is effective immediately instead of being misclassified as a delayed update.
- `PriceAggregator.js`: `receiveValidatedRound` now binds the originating chain into `reference_chain` (was hardcoded `'BTC'`) and changes the `source_chain` fallback to `|| null` so a missing chain fails loudly; backfill ships in `migrations/2026-06-02-backfill-price-snapshot-reference-chain.sql`.
- `OracleRound.js`, `api.js`: oracle freshness counters now rehydrate from `price_snapshots` on `start()` and `/health` reports `oracle_last_finalized_age_s`/`oracle_stale` (503 past `ORACLE_STALENESS_THRESHOLD_S`), so a stalled feed is detectable after a restart.
- `AttestationPublisher.js`, `OraclePublisher.js`: the default-broadcast path now passes uppercase `encoding: 'P2SH'` to the encoder's `createTx` (the case-sensitive allowlist rejected lowercase `'p2sh'`), restoring on-chain output.
- `OracleConsensus.js`: the fallback-proposer legitimacy check in `_handlePropose` now elects strictly from the receiver's locally-observed submission map instead of the attacker-controlled `submissionKeys`, closing a price-injection vector.
- `AttestationPublisher.js`: `onRequestFinalized` now rejects an oversized `ATTEST v1` payload (`ATTEST_WIRE_MAX_BYTES` = `8192`) before it enters the durable WAL, so a too-large response can no longer poison the failover sweep forever.
- `AttestationConsensus.js`: attestation PBFT now computes quorum over the REDUNDANCY-sized responsible set (`2*floor((R-1)/3)+1`) instead of the full attestation-validator count, restoring liveness whenever `N > REDUNDANCY`.
- `Consensus.js`: `_handleNewView` now authenticates `PBFT_NEW_VIEW` (numeric `seq`/`view`, strictly-forward move, sender is the rotation-designated leader for the claimed view) before advancing, closing a single-validator leader-steering attack.
- `Consensus.js`: `_handlePrePrepare` no longer broadcasts a `PBFT_PREPARE` for a digest it cannot commit; it now returns early when an incoming `PRE_PREPARE`'s digest differs from the existing pending proposal's.
- `Consensus.js`: PBFT view-change acceptance now uses the round-locked quorum (stashed in `viewChangeQuorums` by `_initiateViewChange`) instead of recomputing live, preventing validator churn from breaking liveness or safety.
- `AttestationPublisher.js`: a finalized attestation response now survives a leader crash via a durable fsync'd WAL written by every responsible node and a crash-replay/interval sweep (`ATTESTATION_FAILOVER_POLL_MS`), with rank-staggered follower step-in and the indexer pending-set as double-broadcast guard.
- `AttestationConsensus.js`, `AttestationRound.js`: bounded two monotonically-growing structures: `finalized` is now a ring buffer (`ATTESTATION_FINALIZED_MAX`, default 10000) and `rounds` lazily evicts entries older than `ATTESTATION_ROUND_TTL_MS` (default 1h).
- `PriceFetcher.js`, `OracleConsensus.js`, `OracleRound.js`, `constants.js`: unified the price upper bound under a single `PRICE_MAX` (`10_000_000`) so ingestion rejects at the same ceiling the aggregator enforces; `OracleRound` now persists the filtered `validPrices`.
- `OracleConsensus.js`: the single-node (`quorum === 0`) branch of `finalizeRound()` now calls `this.finalized.add(round)`, so a second call no longer re-stores the snapshot and enqueues a duplicate PRICE v0 broadcast.
- `providers/http_get.js`: the `byte_equality` `agree()` now requires a simple-majority `ceil((N+1)/2)` instead of BFT `2f+1`, so under `REDUNDANCY=3` three different bodies no longer let a single validator's response become canonical.
- `Consensus.js`: the PBFT `pendingViewChanges` map is now pruned (entries below the adopted view deleted on a successful change) and cleared on `stop()`, so failed view-change rounds can no longer leak in-process memory.

### Security
- `Consensus.js`, `OracleConsensus.js`, `CrossChainEngine.js`, `ReorgHandler.js`, `AttestationConsensus.js`, `CapabilitySnapshot.js`, `CrossChainDexConsensus.js`, `PriceAggregator.js`, `StateCheckpointEngine.js`, `StateAnchorPublisher.js`: every PBFT quorum is now floored at a simple majority `max(2f+1, ceil((N+1)/2))`, fixing the `2f+1` degeneracy that let one validator finalize at N=3 (N=2→2, N=3→2, N=6→4).
- `PeerManager.js`, `Consensus.js`, `OracleConsensus.js`, `CrossChainEngine.js`: peer-message auth now fails closed when the validator-pubkey registry is `null`, and PBFT engines gain an `_isKnownSender()` guard so quorum votes from unregistered senders are ignored.
- `providers/http_get.js`: the `http_get` attestation provider now refuses non-public targets (SSRF guard), resolving the host once and pinning the connection to the validated public address; `ATTESTATION_HTTP_GET_ALLOW_PRIVATE=1` disables it for regtest only.
- `PriceAggregator.js`: `receiveValidatedRound()` now re-verifies a pushed PRICE v0 round at the hub (strict wire shape, snapshot-resolved signer set, Ed25519 verification, PBFT-quorum check) instead of trusting the pusher; `consensus_proof` stores only verified pairs.
- `ReorgHandler.js`: the reorg-consensus engine now applies the `_isKnownSender()` guard in `_handleAlert`/`_handlePrepare`/`_handleCommit`, closing the unregistered-sender quorum-inflation gap that could trigger a rollback (`attestations` deletes, `price_snapshots` disputes).

## [2.2.12] - 2026-05-29

### Fixed
- `XChainHub._compareDecimal` now compares decimal strings digit-for-digit via `BigInt` instead of through `parseFloat`, so two stakes differing by one satoshi no longer collapse to the same float and mis-qualify an underweight validator.
- `Governance._validateChangeBounds` now evaluates bounds-change ratios by exact `BigInt` cross-multiplication (float ratio kept only for the error message), eliminating float rounding on large parameter values.

## [2.2.11] - 2026-05-29

### Fixed
- `AttestationRound` now pages forward through the entire pending-request set via a keyset cursor (`after_block_index`/`after_action_index`) instead of always re-reading the oldest 100, and the `seen` set is now a TTL-evicted `Map` (`ATTESTATION_RETRY_AFTER_MS`) so backlogged or transiently-skipped requests are no longer starved or leaked. Companion to the indexer cursor change (>= 2.7.10).

## [2.2.10] - 2026-05-29

### Changed
- Dependency installs are now reproducible: `package-lock.json` is committed and the Docker image builds with `npm ci` (was `npm install`), so a container can no longer pick up untested transitive versions.

## [2.2.9] - 2026-05-29

### Security
- Hub to indexer federation read calls now attach the `x-api-key` header (from `BTC_INDEXER_API_KEY`) via the new `_btcIndexerHeaders()` helper, authenticating the four previously-unauthenticated reads; omitted when the env var is unset. `getlatestblock` stays ungated.

## [2.2.8] - 2026-05-29

### Fixed
- `CrossChainEngine` now locks the PBFT quorum into each pending attestation at round creation (both leader and follower paths) instead of re-deriving it live per check, so two hubs with different validator sets can no longer diverge mid-round. Brings it in line with `Consensus` and `OracleConsensus`.

## [2.2.7] - 2026-05-29

### Fixed
- `CapabilitySnapshot` now sends the hub's governance-sourced `MIN_STAKE` (`CapabilityRegistry.getMinStake()`) as a `min_stake` field in `getcapabilityvalidators`, making the hub authoritative for the threshold instead of the indexer's local config; older indexers ignore the field. Requires the companion indexer change.

## [2.2.6] - 2026-05-29

### Fixed
- Capability `MIN_STAKE` changes approved by governance now take effect without a hub restart: `XChainHub.startAttestation()` listens for `proposal:finalized`, applies `CAPABILITY_<CAP>_MIN_STAKE` via `CapabilityRegistry._applyGovernanceChange()`, and re-evaluates this node's qualification, fixing the split PBFT quorum membership across long-running nodes.

## [2.2.5] - 2026-05-29

### Fixed
- Oracle fallback-proposer election no longer diverges under uneven gossip: the proposer piggybacks its sorted `submissionKeys` on `ORACLE_PROPOSE` and validators verify fallback legitimacy against that authoritative view rather than their own divergent local map. Backward-compatible with older peers.

## [2.2.4] - 2026-05-29

### Fixed
- The publisher default-broadcast pipelines (`AttestationPublisher`, `OraclePublisher`) now pass their base58check address (`btcAddress`/`dogeAddress`) instead of the raw hex pubkey, which the encoder's P2SH `fromBase58Check()` threw on, crashing every default broadcast. Added direct `_defaultBroadcast` unit coverage.

## [2.2.3] - 2026-05-28

### Fixed
- Governance proposal tallying is now done by a single deterministic leader per proposal (hash of the proposal id), with followers accepting the broadcast `GOV_RESULT`, ending the split-brain where gossip latency let two hubs reach contradictory pass/fail conclusions. Standalone hubs still tally locally.
- `_tallyProposal` now guards its status write with `AND status = 'voting'`, so a stale or duplicate result broadcast cannot overwrite an already-finalized proposal.
- Governance now emits `proposal:finalized` (was `proposal:passed`) to match the attestation provider-registry hot-reload listener, so a passed proposal now triggers the runtime provider-config reload as intended.

## [2.2.2] - 2026-05-28

### Changed
- `getFeeQuote` now sources the gas price from the config store (per-chain `chain` module), falling back to the protocol default `0.00001` when unset or unavailable, instead of a hardcoded constant.

### Fixed
- `getFeeQuote` now carries the full 17-entry gas schedule (was 7), so `OWNERSHIP_ESCROW`, `VM_DEPLOY_PER_BYTE`, the `VM_STATE_*` ops, `VM_ORACLE_READ`, `VM_CROSSCHAIN_READ`, `VM_ATTEST_REQUEST`, `VM_EMISSION`, and `VM_COMPUTATION` return a numeric fee instead of an `unknown action` error.

## [2.2.1] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate `qs.stringify` DoS) across all transitive paths.

## [2.2.0] - 2026-05-28

### Added
- New `pushpricereorg` JSON-RPC method (write, requires API key): an indexer calls it after a block rollback to retract price rows seeded from rolled-back PRICE actions. Params `{ source_chain, from_action_index }`.
- `PriceAggregator.retractFromActionIndex(sourceChain, fromActionIndex)`: deletes `price_snapshots` and `oracle_prices` rows at or above the action index, emits `row:deleted`, and returns per-table deleted-row counts.
- `HubDbBroadcaster.broadcastDeletion(event)`: forwards `row:deleted` retraction events over the `/hub-db/subscribe` WebSocket so indexers prune their local copies, mirroring the `row:inserted` path.

### Changed
- `XChainHub`: wires `PriceAggregator`'s new `row:deleted` event to `HubDbBroadcaster.broadcastDeletion`, alongside the existing `row:inserted` to `broadcastRow` wiring.

## [2.1.0] - 2026-04-08

### Added
- `PriceAggregator.js`: receives validated PRICE v0/v1 actions from all chains, dedupes by `round_number` (v0) or `(source_chain, action_index)` (v1), writes unified `price_snapshots`/`oracle_prices`, emits `row:inserted`, and applies the 24h v1 lock window.
- `OraclePublisher.js`: Tier 3 publisher broadcasting finalized PRICE v0 to DOGE, with deterministic leader rotation, fsync'd JSONL queue, PRICE v0 wire builder, and DOGE balance monitoring; subscribes to `round:finalized`.
- `EncoderClient.js`: minimal JSON-RPC client for `xchain-encoder` (`get_utxos`, `create_tx`, `broadcast_tx`), used by `OraclePublisher`'s default DOGE pipeline.
- `HubDbBroadcaster.js`: WebSocket subscriber registry forwarding `PriceAggregator` row events to indexer hub-DB-sync clients, with backpressure handling (`WS_BACKPRESSURE_LIMIT`).
- `sql/oracle_prices.sql`: new table for cross-chain TOKEN/FIAT oracle prices with an `effective_at` column enforcing the 24h lock window.
- `setChainTip()`/`getChainTip()` in `db.js`: store the latest BTC/LTC/DOGE chain tip in `configs`, used to anchor oracle rounds to real BTC heights (fixes the hardcoded `reference_block=0` bug).
- New JSON-RPC write methods `pushchaintip`, `pushpriceround`, `pushoracleprice` (require API key) for indexers to push chain state and validated PRICE actions.
- REST snapshot endpoints `GET /hub-db/snapshot/price_snapshots` and `GET /hub-db/snapshot/oracle_prices` with `since_id` pagination for incremental indexer bootstrap.
- WebSocket channel `/hub-db/subscribe`: streams `row:inserted` events for the hub's cross-chain price tables; requires `Authorization: Bearer <HUB_API_KEY>`.
- Multi-validator signature aggregation in `OracleConsensus.js`: each validator signs the canonical PRICE v0 payload during prepare/commit, signatures collect on `pending.signatures`, and `round:finalized` carries them for `OraclePublisher`.
- `_signPriceV0()`, `_buildPriceV0Payload()`, `_verifyAndStoreSig()` helpers in `OracleConsensus.js`, matching the indexer's `ed25519.js` canonical payload format.

### Changed
- `OracleConsensus.js`: `_storeSnapshot()`/`_storeSkippedRound()` now accept `btcBlockHeight`/`btcBlockTime`, replacing hardcoded `reference_block=0` and `Date.now()`, so two nodes at the same BTC height produce identical snapshots.
- `OracleConsensus.finalizeRound(round, btcBlockHeight, btcBlockTime)`: accepts and threads the BTC chain-tip values through pending rounds to storage and `round:finalized`.
- `OracleRound.js`: `_executeRound()` reads the BTC chain tip from `db.getChainTip('BTC')` and threads it through `_scheduleFinalization()` to `finalizeRound()`.
- `PriceFetcher.js`: rewritten for 3 coins x 12 fiats (36 pairs/round) via `vs_currencies`/`convert`; supported fiats USD/CAD/AUD/MXN/GBP/JPY/CNY/CHF/BRL/INR/EUR/KRW. Adds `PriceFetcher.getCoinPairs()`.
- `OracleConsensus._storeSkippedRound()`: now uses `PriceFetcher.getCoinPairs()` for the pair list instead of a hardcoded triple.
- `sql/price_snapshots.sql`: added `source_chain VARCHAR(10)` (defaults `DOGE`) tracking the chain that carried the PRICE v0 tx, plus `source_action_index BIGINT` for audit and a `source_chain` index.
- `RewardTracker.js`: `distributeRewards()` now accepts `btcBlockHeight` and pushes reward records to the BTC indexer via `pushvalidatorrewards`, populating `validator_rewards` so `CLAIM_REWARDS` finds unclaimed rewards.
- `XChainHub.start()`: instantiates `PriceAggregator` and `HubDbBroadcaster` in all modes; validator-mode `startOracle()` also starts `OraclePublisher`.
- Hub `api.js`: now uses an explicit `http.Server` with a WebSocket upgrade handler for the hub-DB-sync channel, plus `WRITE_METHODS` entries for the three new push methods.

### Fixed
- `reference_block` hardcoded to `0` in `_storeSnapshot()`/`_storeSkippedRound()` now uses the BTC chain tip at round execution, restoring cross-node determinism for fee validation and VM oracle queries.
- `block_timestamp` in price snapshots now uses the BTC block's `block_time` instead of wall-clock `Date.now()`.
- `round:finalized` now carries `btcBlockHeight`, `btcBlockTime`, and `signatures` for downstream consumers.
- `README.md`: updated version badge to 2.0.12, added tests/coverage badges and a test-suite breakdown, expanded the scripts table, and linked the new DATABASE.md and OPERATIONS.md docs.

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
  - `test:regression:p0`: 78 critical tests (<1s) for every commit
  - `test:regression:p0p1`: 154 high-priority tests (3s) for PR gating
  - `test:regression`: full 195-test suite (3s) for nightly/pre-release
- Regression testing plan document at `reports/XCHAIN_HUB_REGRESSION_TESTING_PLAN.md`

## [2.0.11] - 2026-04-06

### Added
- Mutation testing infrastructure using StrykerJS
- `stryker.config.json`: full mutation config targeting all `src/**/*.js` (excludes SQL schemas)
- `stryker.config.phase1.json`: pilot config targeting `Consensus.js` and `OracleConsensus.js` only
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
- `REQUIRE_SIGNATURES` now defaults to `true` (was `false`), P2P messages require Ed25519 signatures by default
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
- Infinity values leaking through oracle price aggregation, replaced `!isNaN(val)` with `isFinite(val)` in `_aggregate()` filter
- TypeError crash in PeerManager when receiving non-object JSON (null, number, string), added type guard after JSON.parse
- Message ID collisions under high throughput, replaced `Math.random()` with `crypto.randomUUID()` in `_makeId()`
- Object.prototype pollution in fee quote gas schedule lookup, replaced bracket notation with `hasOwnProperty` check

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
- Governance engine (`Governance.js`), off-chain PBFT voting for parameter changes
- `governance_proposals` and `governance_votes` tables
- 7-day voting period with 2/3+ approval threshold and 50% quorum
- Proposal constraints: max 50%/33% change bounds (25%/20% for slashing params), 14-day cooldown after rejection
- `propose`, `vote`, `getproposals`, `getproposal` JSON-RPC methods
- Automatic proposal tallying when voting period ends
- `proposal:passed` event emitted for downstream parameter application
- HEARTBEAT messages now include hub software version for upgrade coordination
- `GOV_VOTING_PERIOD` env var (default 7 days)

### Changed
- **Major version bump to 2.0.0**, governance system completes the decentralized hub architecture (Phases 0-5)

## [1.9.0] - 2026-04-06

### Added
- SWAP lifecycle tracker (`SwapTracker.js`), tracks cross-chain swaps through initiated → attested → executed → settled
- `swap_records` table for SWAP lifecycle persistence
- Per-chain-pair validator filtering in CrossChainEngine, only validators supporting both chains participate in cross-chain quorum
- `chains` and `tier` columns added to `validators` table (auto-migration on startup)
- Validators with NULL chains support all chain-pairs (backward compatible)
- `initiateswap`, `getswap`, `getswaps` JSON-RPC methods
- SwapTracker auto-progresses swap status on attestation finalization

## [1.8.0] - 2026-04-06

### Added
- Reorg handler (`ReorgHandler.js`), cross-chain reorg propagation with PBFT consensus
- `reorg_attestations` table for storing confirmed reorg events
- Hub rollback on reorg: deletes attestations after reorg timestamp, invalidates price snapshots
- `REORG_ALERT` gossip message for reorg detection
- `XCHAIN_REORG_PREPARE` / `XCHAIN_REORG_COMMIT` for reorg consensus
- `reportreorg` JSON-RPC method, report a blockchain reorg for cross-chain propagation
- `getreorghistory` JSON-RPC method, query confirmed reorg attestations
- `reorg:confirmed` event emitted for downstream indexer notification

## [1.7.0] - 2026-04-06

### Added
- Cross-chain attestation engine (`CrossChainEngine.js`), PBFT-based consensus for cross-chain action verification
- `attestations` table for storing finalized cross-chain attestations
- Attestation lifecycle: PROPOSE → PREPARE (2f+1) → COMMIT (2f+1) → store
- Per-chain confirmation thresholds (BTC: 3, LTC: 3, DOGE: 6)
- `requestattestation` JSON-RPC method, submit attestation requests
- `getattestations` JSON-RPC method, query stored attestations
- `getattestation` JSON-RPC method, get specific attestation by source chain + action index
- `attestation:finalized` event emitted for downstream processing
- Single-node fallback for attestations (stores directly without consensus)

## [1.6.0] - 2026-04-06

### Added
- Reward tracker (`RewardTracker.js`), distributes XCHAIN rewards to oracle round participants
- Slash detector (`SlashDetector.js`), detects price deviation (>5%), repeated deviation (3+ in 24h), and non-participation (30+ missed rounds)
- `validator_rewards` table for reward tracking with unclaimed/claimed status
- `slash_proposals` table for recording detected offenses
- `syncvalidators` JSON-RPC method, push validator set from external staking data
- `getvalidators` JSON-RPC method, list active validators
- `getvalidatorstatus` JSON-RPC method, detailed validator status with rewards and slash history
- `getfeequote` JSON-RPC method, calculates native coin fee amount via gas → XCHAIN → oracle conversion
- OracleConsensus now emits `round:finalized` event consumed by reward tracker and slash detector
- New env vars: `ORACLE_REWARD_PER_ROUND`, `SLASH_DEVIATION_THRESHOLD`, `SLASH_MISSED_ROUNDS_THRESHOLD`

## [1.5.0] - 2026-04-06

### Added
- Oracle consensus engine (`OracleConsensus.js`), PBFT-like finalization for price rounds
- Trimmed median aggregation, discard top/bottom 15%, compute median of remaining submissions
- `price_snapshots` table for finalized price data (round_number, coin_pair, price, status, consensus_proof)
- Automatic round finalization after submission window closes
- Skipped round detection, rounds with no submissions stored as `status='skipped'`
- `getpricesnapshots` JSON-RPC method, returns recent finalized snapshots
- `getprice` JSON-RPC method, returns latest finalized price for a coin pair
- Single-node fallback, stores local prices directly as snapshots when no peers connected

## [1.4.0] - 2026-04-06

### Added
- Price oracle round system (`OracleRound.js`), timer-based round lifecycle with configurable interval
- External price fetcher (`PriceFetcher.js`), fetches BTC/USD, LTC/USD, DOGE/USD from CoinGecko and CoinMarketCap
- `ORACLE_PRICE_SUBMIT` gossip message, validators broadcast price submissions each round
- `oracle_submissions` table for persisting price submissions per round
- `getoraclesubmissions` JSON-RPC method for oracle diagnostics
- `startOracle()` and `getOracle()` methods on XChainHub
- New env vars: `ORACLE_ROUND_INTERVAL`, `ORACLE_SUBMISSION_WINDOW`, `COINGECKO_API_KEY`, `COINMARKETCAP_API_KEY`, `PRICE_FETCH_TIMEOUT`

## [1.3.0] - 2026-04-06

### Added
- Ed25519 validator identity (`ValidatorIdentity.js`), message signing and signature verification using Node.js built-in crypto
- `validators` table for validator registry (signing pubkey, addr, status)
- `registervalidator` JSON-RPC method for bootstrap validator registration
- Leader rotation in PBFT consensus, deterministic leader per sequence number from sorted validator set
- View change protocol, `PBFT_VIEW_CHANGE` and `PBFT_NEW_VIEW` messages for leader failover on timeout
- Signature verification in PeerManager, incoming messages verified against registered validator pubkeys
- `SIGNING_PRIVKEY_HEX` env var for Ed25519 private key
- `REQUIRE_SIGNATURES` env var (default false), when true, rejects unsigned P2P messages

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
- P2P is optional, hub works without it for backward compatibility
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
