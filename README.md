<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Hub

<p align="center">
  <img src="https://img.shields.io/badge/version-2.2.16-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-1222%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20smoke%20%7C%20regression%20%7C%20performance-brightgreen" alt="Coverage">
</p>

Decentralized config oracle, price oracle, and cross-chain coordinator for the XChain Platform. Validators form a P2P gossip network with PBFT consensus, Ed25519 identity, trimmed-median price aggregation, cross-chain attestation, and off-chain governance.

## Features

- **Service config registry**: stores connection parameters for all XChain services across BTC, LTC, DOGE on mainnet, testnet, and regtest
- **PBFT consensus**: config writes go through a 2/3+ validator consensus round
- **P2P gossip**: WebSocket-based peer mesh with heartbeat, reconnection, and message deduplication
- **Ed25519 validator identity**: cryptographic message signing and verification
- **Decentralized price oracle**: validators fetch prices from CoinGecko and CoinMarketCap, aggregate via trimmed median, finalize via PBFT consensus
- **Fee quotes**: gas -> XCHAIN -> native coin conversion using live oracle prices
- **Cross-chain attestation**: PBFT-based attestation for cross-chain actions with per-chain-pair validator filtering
- **External attestation framework**: contracts emit `ATTEST` v0 (request, via `xchain.attestation` VM namespace); validators in the responsible-set fetch from the named provider, reach PBFT consensus, and publish `ATTEST` v1 (response) on-chain. Built-in providers: `http_get` (byte-equality) and `llm` (Claude judge-model)
- **Capability-based staking**: five independent capabilities (`price`, `cross_chain`, `oracle_publish`, `attestation`, `full_node`) auto-qualify per validator based on aggregate stake amount vs governance-configurable `min_stake[capability]`; per-capability self-tests gate local participation
- **Block-boundary quorum snapshot**: every PBFT round locks N at a specific `block_index` via the indexer, so the qualified validator set is deterministic federation-wide even as stake drifts. The locked quorum governs the whole round (PREPARE, COMMIT, and view-change acceptance) so leader-failover elections can't diverge from the proposal phases when validators join or unstake mid-round
- **SWAP lifecycle tracking**: tracks cross-chain swaps through initiated -> attested -> executed -> settled -> failed
- **Reorg propagation**: cross-chain reorg detection, hub rollback, and coordinated chain rollback via PBFT consensus
- **Governance**: off-chain PBFT voting for parameter changes (7-day voting period, 2/3+ approval, 50% quorum)
- **Reward tracking**: per-round XCHAIN rewards for oracle participants; cross-hub `pushvalidatorrewards` to indexer for persistence
- **Slash detection**: price deviation (>5%), repeated deviation (3+ in 24h), non-participation (30+ missed rounds), and attestation divergence (byte_equality providers)
- **Leader rotation**: deterministic per-sequence leader with view change on timeout
- **Multi-instance**: multiple hub instances against shared MariaDB with consumer fallback
- **Single-node fallback**: all consensus operations apply directly when no peers are connected
- **Network-aware chain tips**: `pushchaintip` carries `network` (mainnet/testnet/regtest); consensus anchors against the matching tip with fallback to indexer's `getlatestblock`
- **State checkpoints and ANCHOR publishing**: `StateCheckpointEngine` quorum-signs per-chain ledger/actions/contract hash checkpoints; `StateAnchorPublisher` elects a leader from the `oracle_publish` snapshot and writes ANCHOR v0/v1/v2 transactions to DOGE with a failover ladder; archive batches carry both DEX matches and XCALL relay rows
- **MariaDB storage**: 20 relational tables with circuit breaker and exponential backoff
- **Docker-ready**: Dockerfile for containerized deployment via xchain-node

## Documentation

Full hub documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/hub) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/README.md) | Overview, installation, quick start, service discovery, multi-instance deployment |
| [Architecture](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/ARCHITECTURE.md) | Subsystem design, P2P gossip, PBFT consensus, oracle pipeline, cross-chain engine |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/CONFIGURATION.md) | All environment variables, database schema, connection pool, validator identity |
| [API](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/API.md) | JSON-RPC method reference: config, validators, oracle, attestations, swaps, reorgs, governance |
| [Database](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/DATABASE.md) | Full schema reference: 13 tables for config, validators, oracle, attestations, governance |
| [Operations](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/OPERATIONS.md) | Running, Docker, resilience, troubleshooting |
| [Decentralization](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/DECENTRALIZATION.md) | Evolution from centralized oracle to decentralized validator network (all phases complete) |

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cat > .env << 'EOF'
HUB_HOST=0.0.0.0
HUB_PORT=10000
HUB_DB_HOST=localhost
HUB_DB_PORT=3306
HUB_DB_NAME=XChain_Hub
HUB_DB_USER=xchain
HUB_DB_PASS=password
EOF

# Start the hub
npm run api
```

The hub automatically creates the database and all tables on first startup. Without `P2P_VALIDATOR_ADDR`, it runs in standalone mode (config oracle only). Set P2P variables to activate the full validator stack.

## Multi-Instance Deployment

Multiple hub instances can run against the same MariaDB database for high availability. Consumer services use `HUB_VALIDATORS` to specify a comma-separated list of hub endpoints:

```env
HUB_VALIDATORS=hub1.local:10000,hub2.local:10000,hub3.local:10000
```

Consumers try each endpoint in order and fall back to the next if one is unreachable.

## Environment Variables

### Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_HOST` | No | `0.0.0.0` | Host to bind the API server |
| `HUB_PORT` | Yes | (none) | Port for the JSON-RPC API |
| `HUB_DB_HOST` | Yes | (none) | MariaDB host |
| `HUB_DB_PORT` | Yes | (none) | MariaDB port |
| `HUB_DB_NAME` | Yes | (none) | MariaDB database name |
| `HUB_DB_USER` | Yes | (none) | MariaDB username |
| `HUB_DB_PASS` | Yes | (none) | MariaDB password |

### Validator Mode (optional)

| Variable | Default | Description |
|---|---|---|
| `P2P_VALIDATOR_ADDR` | (none) | This validator's public address (activates validator mode) |
| `P2P_PORT` | `10001` | WebSocket P2P listen port |
| `SEED_NODES` | (none) | Comma-separated peer addresses |
| `SIGNING_PRIVKEY_HEX` | (none) | 64-hex-char Ed25519 private key seed |
| `ORACLE_EPOCH_START` | (none) | Oracle round-numbering anchor (Unix ms). Required in validator mode and must be identical across the federation. |
| `HUB_NETWORK` | (none) | Deployment network: `mainnet`, `testnet`, or `regtest`. Required when `P2P_VALIDATOR_ADDR` is set (hub exits with an error if missing or invalid). Must match the network the federated indexers are on. |
| `HUB_CAPABILITY_CONFIG` | (none) | Path to the capability config JSON (see below). Required for `price`/`cross_chain`/`oracle_publish` to pass their self-tests and for `MIN_STAKE` qualification thresholds. |
| `COINGECKO_API_KEY` | (none) | CoinGecko API key |
| `COINMARKETCAP_API_KEY` | (none) | CoinMarketCap API key (enables second price source) |

### Capability Configuration (`HUB_CAPABILITY_CONFIG`)

In validator mode the hub runs a self-test per capability and tracks on-chain
stake to decide which capabilities it is qualified + ready to serve. The config
file supplies the `MIN_STAKE` qualification thresholds **and** the per-capability
self-test config blocks. Without it, `price`/`cross_chain`/`oracle_publish`
self-tests fail ("config missing"), and capabilities have no `MIN_STAKE` so they
stay **inactive** (the hub now fails closed rather than qualifying at a 0 threshold).
The file is hot-reloaded; edits apply without a restart.

```json
{
  "CAPABILITIES": {
    "price":          { "MIN_STAKE": "1000.00000000" },
    "cross_chain":    { "MIN_STAKE": "1000.00000000" },
    "oracle_publish": { "MIN_STAKE": "500.00000000"  },
    "attestation":    { "MIN_STAKE": "1000.00000000" },
    "full_node":      { "MIN_STAKE": "1000.00000000" }
  },
  "DISABLED_CAPABILITIES": [],
  "price":          { "sources": ["coingecko"], "fiats": ["USD"] },
  "cross_chain":    { "chains": { "BTC": { "rpc": "http://node:8332" } } },
  "oracle_publish": { "doge_address": "D...", "doge_wallet": "/path/to/wallet.dat" },
  "attestation":    { "providers": {} },
  "full_node":      { "BTC_RPC": "http://node:8332" }
}
```

The `full_node` capability requires a reachable BTC RPC endpoint (`FULLNODE.BTC_RPC` in the config block) and gates a distinct reward tranche for validators providing full-node services.

> Easiest path: run `xchain-node validator init`, which generates your signing
> key, prints the **pubkey to stake to**, and writes a starter
> `capabilities.json` that `xchain-node install` mounts into the hub container.

### External Attestation Framework (optional)

| Variable | Default | Description |
|---|---|---|
| `ATTESTATION_POLL_MS` | `15000` | How often AttestationRound polls the BTC indexer for new pending requests |
| `ATTESTATION_CONFIRMATIONS` | `3` | BTC blocks of confirmation before initiating an external provider fetch (reorg safety) |
| `ATTESTATION_FETCH_TIMEOUT` | `10000` | Per-request provider fetch timeout (ms) |
| `ATTESTATION_RETRY_AFTER_MS` | `5 x ATTESTATION_POLL_MS` | How long an evaluated request is suppressed from re-polling before it can be re-evaluated (lets transiently-skipped requests retry) |
| `ATTESTATION_ROUND_TIMEOUT_MS` | `120000` | PBFT round lifetime before in-memory state is dropped |
| `ATTESTATION_QUEUE_PATH` | `./data/attestation-queue.jsonl` | FSYNC queue for in-flight ATTEST v1 (response) broadcasts |
| `BTC_ENCODER_URL` | (none) | xchain-encoder JSON-RPC URL for AttestationPublisher's default broadcast pipeline |
| `BTC_ENCODER_API_KEY` | (none) | API key for the BTC encoder |
| `BTC_ADDRESS` | (none) | BTC address that pays the on-chain ATTEST v1 (response) broadcast fee |
| `BTC_PUBKEY_HEX` | (none) | Pubkey hex for the BTC_ADDRESS (encoder needs both for PSBT construction) |
| `ANTHROPIC_API_KEY` | (none) | Required to serve the `llm` provider. Without it, the LLM probe in `selfTest('attestation')` is skipped and the validator silently opts out of LLM requests. |
| `LLM_DEFAULT_MODEL` | first of `approved_models` | LLM model this validator chooses when serving requests. Falls back to registry default if not in `approved_models`. |

See [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/CONFIGURATION.md) for the full list of 30+ environment variables.

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start the hub API server |
| `npm test` | Run unit tests (~366 tests) |
| `npm run test:integration` | Integration tests (~72 tests, requires MariaDB) |
| `npm run test:e2e` | End-to-end tests (~64 tests, requires full stack) |
| `npm run test:fuzz` | Fuzz tests (property-based via fast-check) |
| `npm run test:chaos` | Chaos engineering tests |
| `npm run test:smoke` | Smoke tests (quick sanity check) |
| `npm run test:regression` | Regression tests (tagged across all suites) |
| `npm run test:regression:p0` | P0-priority regression tests |
| `npm run test:regression:p0p1` | P0+P1 regression tests |
| `npm run test:perf` | All performance tests |
| `npm run test:mutate` | Mutation tests (Stryker) |
| `npm run test:mutate:pilot` | Pilot mutation tests (phase 1) |
| `npm run test:all` | Complete test suite |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit - Core | ~294 | `XChainHub.test.js`, `Consensus.test.js`, `PeerManager.test.js`, `OracleRound.test.js`, `OracleConsensus.test.js`, `CrossChainEngine.test.js`, `Governance.test.js`, `PriceFetcher.test.js`, `ReorgHandler.test.js`, `SwapTracker.test.js`, `ValidatorIdentity.test.js`, `RewardTracker.test.js`, `SlashDetector.test.js`, `db.test.js` |
| Unit - Security | ~72 | SQL safety, parameter injection, authentication, rate limiting |
| Boundary | ~260 | Quorum thresholds, consensus edge cases, fee quotes, governance bounds, P2P limits, price fetcher, trimmed median, rewards, slashing, config, cross-chain, reorg, DB, validator |
| Integration | ~72 | Oracle rounds, price persistence, attestation, reorg, config consensus, governance, JSON-RPC API, message routing, error handling |
| E2E | ~64 | Oracle, fee quotes, config, governance, attestation, reorg, multi-node, API contract |
| Fuzz | ~88 | Property-based testing via fast-check: price fetcher, governance, validator identity, consensus, oracle consensus, peer manager, fee quotes |
| Chaos | ~122 | Network partition, leader crash, quorum loss, DB flapping, pool exhaustion, connection loss, single source failure, malformed data, total blackout, reorg-during-oracle, validator churn, rate limit saturation |
| Smoke | ~15 | Hub startup, API liveness, basic config operations |
| Regression | ~193 | Oracle, reorg, governance, P2P, DB, incentives, consensus, cross-chain |
| Performance | ~42 | API load, oracle load, P2P flood, DB stress, soak, resilience |
| **Total** | **~1,222** | |

## JSON-RPC API

All methods are called via HTTP POST with JSON-RPC 2.0 format. See [API Reference](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/API.md) for full details.

| Category | Methods |
|---|---|
| Config | `ping`, `getallconfigs`, `updateconfig` |
| Validators | `registervalidator`, `syncvalidators`, `getvalidators`, `getvalidatorstatus` |
| Oracle | `getoraclesubmissions`, `getpricesnapshots`, `getprice` |
| Fees | `getfeequote` |
| Cross-Chain | `requestattestation`, `getattestation`, `getattestations` |
| Swaps | `initiateswap`, `getswap`, `getswaps` |
| Reorgs | `reportreorg`, `getreorghistory` |
| Governance | `propose`, `vote`, `getproposals`, `getproposal` |

The hub also calls **indexer** RPCs (`getownstake`, `getactivevalidators`, `getcapabilityvalidators`, `getpendingattestation_requests`, `getlatestblock`) and posts back to it (`pushchaintip`, `pushvalidatorrewards`, `pushpriceround`, `pushoracleprice`).

## Database Schema

The hub uses 15 MariaDB tables (auto-created on startup):

| Table | Purpose |
|---|---|
| `configs` | Service config parameters per coin/network/module |
| `validators` | Active validators with signing pubkey, address, chains |
| `consensus_state` | PBFT sequence number persistence |
| `p2p_peers` | Known P2P peers and last-seen timestamps |
| `oracle_submissions` | Per-validator PRICE v0 submissions per round |
| `oracle_prices` | User-published PRICE v1 oracle rows (per source_address x coin/tick/fiat) |
| `price_snapshots` | Finalized price data per round per coin pair |
| `attestations` | Cross-chain attestation records |
| `swap_records` | SWAP lifecycle tracking |
| `reorg_attestations` | Confirmed blockchain reorg events |
| `governance_proposals` | Parameter change proposals |
| `governance_votes` | Validator votes on proposals |
| `slash_proposals` | Detected validator misbehavior (price deviation, non-participation, attestation divergence) |
| `validator_rewards` | Per-round oracle reward accounting |
| `validator_capabilities` | Per-pubkey x capability state: `qualified`, `self_test_ok`, `enabled`, `qualified_at_block` |

## Dependencies

### Runtime

| Package | Purpose |
|---|---|
| `axios` | HTTP client for external price API calls (CoinGecko, CoinMarketCap) |
| `express` | HTTP server for JSON-RPC API |
| `express-json-rpc-router` | JSON-RPC 2.0 routing for the API server |
| `helmet` | HTTP security headers |
| `cors` | Cross-origin resource sharing |
| `mariadb` | MariaDB connection pool for all hub data |
| `ws` | WebSocket server/client for P2P gossip layer |
| `express-rate-limit` | API rate limiting |
| `dotenv` | `.env` file loading for environment-based configuration |

### Development

| Package | Purpose |
|---|---|
| `mocha` | Test framework |
| `chai` | Assertion library |
| `sinon` | Mocking, stubbing, and spying for tests |
| `fast-check` | Property-based (fuzz) testing |
| `nock` | HTTP request mocking for tests |
| `proxyquire` | Module dependency injection for tests |
| `@stryker-mutator/core` | Mutation testing framework |
| `@stryker-mutator/mocha-runner` | Stryker Mocha integration |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/licensing).
