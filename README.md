<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Hub

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

Config oracle and cross-chain coordinator for the XChain Platform. Stores service discovery configs (host, port, database credentials) for all platform services across all chains and networks in MariaDB, and serves them via a JSON-RPC API.

## Features

- **Service config registry** — stores connection parameters for all XChain services (decoder, indexer, explorer, etc.) across BTC, LTC, DOGE on mainnet, testnet, and regtest
- **JSON-RPC API** — `ping`, `getallconfigs`, `updateconfig` methods consumed by explorer, node, and e2e-test services
- **MariaDB storage** — relational config storage with upsert semantics, replacing the original LevelDB backend
- **Circuit breaker** — automatic failure detection and recovery for database connections with exponential backoff
- **Docker-ready** — Dockerfile for containerized deployment alongside other XChain services

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
