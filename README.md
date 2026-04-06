<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Hub

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

Decentralized config oracle, price oracle, and cross-chain coordinator for the XChain Platform. Validators form a P2P gossip network with PBFT consensus, Ed25519 identity, and governance.

## Features

- **Service config registry** — stores connection parameters for all XChain services across BTC, LTC, DOGE on mainnet, testnet, and regtest
- **PBFT consensus** — config writes go through a 2/3+ validator consensus round
- **P2P gossip** — WebSocket-based peer mesh with heartbeat, reconnection, and message deduplication
- **Ed25519 validator identity** — cryptographic message signing and verification
- **Decentralized price oracle** — validators fetch prices from external APIs, aggregate via trimmed median, finalize via PBFT consensus
- **Cross-chain attestation** — PBFT-based attestation for cross-chain actions (SWAP lifecycle tracking)
- **Reorg propagation** — cross-chain reorg detection, hub rollback, and coordinated chain rollback
- **Governance** — off-chain PBFT voting for parameter changes (7-day voting period, 2/3+ approval)
- **Reward tracking** — per-round XCHAIN rewards for oracle participants
- **Slash detection** — price deviation, repeated deviation, and non-participation monitoring
- **Leader rotation** — deterministic per-sequence leader with view change on timeout
- **Multi-instance** — multiple hub instances against shared MariaDB with consumer fallback
- **MariaDB storage** — relational storage with circuit breaker and exponential backoff
- **Docker-ready** — Dockerfile for containerized deployment

## Documentation

Full hub documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/hub) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/README.md) | Overview, architecture, API reference, service discovery |
| [Decentralization](https://github.com/XChain-platform/xchain-documentation/blob/master/components/hub/DECENTRALIZATION.md) | Roadmap for evolving the hub into a decentralized validator network |

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

The hub will automatically create the `XChain_Hub` database and `configs` table on first startup.

## Multi-Instance Deployment

Multiple hub instances can run against the same MariaDB database for high availability. Consumer services use the `HUB_VALIDATORS` environment variable to specify a comma-separated list of hub endpoints:

```env
HUB_VALIDATORS=hub1.local:10000,hub2.local:10000,hub3.local:10000
```

Consumers try each endpoint in order and fall back to the next if one is unreachable. If `HUB_VALIDATORS` is not set, consumers fall back to the legacy `HUB_API_HOST:HUB_PORT` variables for backward compatibility.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_HOST` | No | `0.0.0.0` | Host to bind the API server |
| `HUB_PORT` | Yes | — | Port for the JSON-RPC API |
| `HUB_DB_HOST` | Yes | — | MariaDB host |
| `HUB_DB_PORT` | Yes | — | MariaDB port |
| `HUB_DB_NAME` | Yes | — | MariaDB database name (e.g., `XChain_Hub`) |
| `HUB_DB_USER` | Yes | — | MariaDB username |
| `HUB_DB_PASS` | Yes | — | MariaDB password |

## Scripts

| Script | Command | Description |
|---|---|---|
| `npm run api` | `node ./src/api.js` | Start the hub API server |

## JSON-RPC API

All methods are called via HTTP POST to `http://<host>:<port>` with JSON-RPC 2.0 format.

### `ping`

Health check.

```json
{"jsonrpc":"2.0","method":"ping","id":1}
→ {"status":"success"}
```

### `getallconfigs`

Returns all service configs as a nested object: `{ coin: { network: { module: { param: value } } } }`.

```json
{"jsonrpc":"2.0","method":"getallconfigs","id":1}
```

### `updateconfig`

Upserts service configs from a nested JSON object.

```json
{"jsonrpc":"2.0","method":"updateconfig","params":{"config":{"BTC":{"mainnet":{"xchain-decoder":{"host":"192.168.1.10","port":"8332"}}}}},"id":1}
→ {"status":"success"}
```

## Database Schema

The hub uses a single `configs` table:

| Column | Type | Description |
|---|---|---|
| `coin` | VARCHAR(16) | Coin identifier (BTC, LTC, DOGE) |
| `network` | VARCHAR(16) | Network (mainnet, testnet, regtest) |
| `module` | VARCHAR(64) | Service name (xchain-decoder, xchain-indexer, etc.) |
| `param_name` | VARCHAR(32) | Parameter name (host, port, db_host, etc.) |
| `param_value` | TEXT | Parameter value |
| `updated_at` | TIMESTAMP | Last update timestamp |

---

Copyright © 2025 Dankest, LLC. Licensed under the [Dankest Community License](LICENSE.md). See [NOTICE.md](NOTICE.md) for third-party attributions.
