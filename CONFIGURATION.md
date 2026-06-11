# xchain-hub Configuration

The hub is configured entirely through environment variables (typically loaded
from a `.env` file in the service root — copy `.env.example` to `.env` to start).
This document is the authoritative catalogue of every variable the hub reads,
grouped by concern.

The hub is the platform's **config oracle and cross-chain coordinator**: it
serves configuration to the indexer/explorer, runs the validator P2P cluster,
drives PBFT consensus and oracle price rounds, and publishes attestations and
oracle prices on-chain. A misconfigured hub can therefore affect the whole
validator federation — read the **Silent-failure variables** section first.

---

## ⚠️ Silent-failure variables (read this first)

Two variables degrade security when left empty. The hub starts and appears
healthy, so the misconfiguration is easy to miss.

### `HUB_API_KEY` — empty disables API authentication

When `HUB_API_KEY` is set, authentication fails closed: mutating methods
(`updateconfig`, `registervalidator`, `propose`, `vote`, `requestattestation`,
`reportreorg`, `initiateswap`, the oracle/price push methods) and the hub-DB
WebSocket upgrade return 401 unless the caller presents the configured key.

When it is unset or empty, those paths are **open** and a warning is logged at
startup. The key is deliberately not required at boot: `xchain-node`-managed
deployments provision no key, so a hard requirement would crash-loop them.

**Production requirement:** always set a strong, random `HUB_API_KEY`. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Clients then send it on each request (the indexer reads the same value as
`HUB_API_KEY`, the encoder-facing services as their `*_ENCODER_API_KEY`, etc.).

### `SIGNING_PRIVKEY_HEX` — empty means unsigned P2P messages / no federation identity

`SIGNING_PRIVKEY_HEX` is the Ed25519 private key (a 32-byte seed, encoded as 64
hex characters) that authenticates this hub's P2P messages to the rest of the
validator federation. When the P2P cluster is enabled (see `P2P_VALIDATOR_ADDR`)
but this key is empty, the hub **loads no validator identity**: outbound messages
go out unsigned and this hub has no verifiable identity among its peers. Nothing
fails loudly — the hub simply never participates as an authenticated validator,
and depending on peers' `REQUIRE_SIGNATURES` its messages may be silently dropped.

**Generate a key pair** (the private seed is what you set; keep it secret):

```bash
# Private seed (set this as SIGNING_PRIVKEY_HEX):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The corresponding public key is derived automatically at startup from the seed
(the hub logs the first 16 hex chars of the pubkey when the identity loads). Each
validator's pubkey must be registered in the cluster so peers can verify its
signatures.

> The key format is validated: it must be exactly 64 hex characters. An invalid
> non-empty value throws at startup — only the **empty** case is silent.

---

## Core API

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_PORT` | **Yes** | — | TCP port the REST/JSON-RPC API binds to. The hub will not start without it. |
| `HUB_HOST` | No | `0.0.0.0` | Bind interface. |
| `HUB_DB_KEEPALIVE_INTERVAL` | No | `30000` | DB keep-alive ping interval (ms). |

## Security

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_API_KEY` | **Prod** | _empty_ | API key required on write requests and WS upgrades when set. **Empty leaves them open (startup warning) — see above.** |
| `HUB_RATE_LIMIT_RPM` | No | `100` | Requests per minute per client. |
| `CORS_ORIGIN` | No | `false` | Allowed CORS origin; `false` disables cross-origin requests. |

## Database (MariaDB)

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_DB_HOST` | **Yes** | — | MariaDB host. |
| `HUB_DB_PORT` | **Yes** | — | MariaDB port. |
| `HUB_DB_NAME` | **Yes** | — | Database name. |
| `HUB_DB_USER` | **Yes** | — | Database user. |
| `HUB_DB_PASS` | **Yes** | — | Database password. |
| `DB_QUERY_TIMEOUT` | No | `30000` | Per-query timeout (ms). |

## Telemetry collector

The hub is the single collector for anonymous node-operator telemetry. The raw
client IP is never stored; at ingest the hub derives a coarse country/region and
a keyed one-way hash, then discards the IP.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEMETRY_ENABLED` | No | `true` | Accept telemetry pings. Set `false` on a private/local hub. |
| `TELEMETRY_RETENTION_DAYS` | No | `90` | Prune telemetry rows older than N days. |
| `TELEMETRY_IP_SALT` | No | _empty_ | Secret salt for the one-way IP hash. Without it, `ip_hash` is left null (an unsalted hash would be trivially reversible). |

## P2P validator cluster

The P2P cluster, PBFT consensus, oracle rounds, cross-chain engine, reorg
handler, governance, and attestation subsystems are **all enabled only when
`P2P_VALIDATOR_ADDR` is set**. Leave it empty for a standalone config-oracle hub.

| Variable | Required | Default | Description |
|---|---|---|---|
| `P2P_VALIDATOR_ADDR` | No | _empty_ | This validator's address. Setting it enables the entire P2P/validator stack. |
| `ORACLE_EPOCH_START` | **If P2P** | — | Unix-ms timestamp anchoring oracle round numbering. Must be identical across all hubs in the federation. The hub exits at startup if P2P is enabled and this is unset. |
| `SIGNING_PRIVKEY_HEX` | **If P2P** | _empty_ | Ed25519 seed (64 hex chars). **Empty = unsigned / no identity — see above.** |
| `REQUIRE_SIGNATURES` | No | `true` | Reject unsigned or invalid peer messages. |
| `P2P_PORT` | No | `10001` | P2P listener port. |
| `P2P_HOST` | No | `0.0.0.0` | P2P bind interface. |
| `SEED_NODES` | No | _empty_ | Comma-separated `host:port` seed peers. |
| `P2P_HEARTBEAT_INTERVAL` | No | `15000` | Peer heartbeat interval (ms). |
| `P2P_DEDUP_PRUNE_INTERVAL` | No | `30000` | Dedup cache prune interval (ms). |
| `P2P_WS_PING_INTERVAL` | No | `30000` | WebSocket ping interval (ms). |
| `P2P_RECONNECT_BASE` | No | `2000` | Reconnect backoff base (ms). |
| `P2P_RECONNECT_MAX` | No | `60000` | Reconnect backoff ceiling (ms). |
| `P2P_MSG_DEDUP_TTL` | No | `60000` | Message dedup TTL (ms). |
| `P2P_MAX_PAYLOAD` | No | `1048576` | Max P2P payload (bytes). |

## Oracle price rounds (P2P)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORACLE_ROUND_INTERVAL` | No | `600000` | Round length (ms). |
| `ORACLE_SUBMISSION_WINDOW` | No | `180000` | Submission window within a round (ms). |
| `ORACLE_REWARD_PER_ROUND` | No | `10.00000000` | Reward per round. |
| `ORACLE_FINALIZATION_TIMEOUT` | No | `120000` | Finalization timeout (ms). |
| `ORACLE_MIN_SUBMISSIONS` | No | `1` | Minimum submissions to finalize a round. |
| `SLASH_DEVIATION_THRESHOLD` | No | `0.05` | Price-deviation slashing threshold (fraction). |
| `SLASH_MISSED_ROUNDS_THRESHOLD` | No | `30` | Missed-rounds slashing threshold. |

## Price feeds

| Variable | Required | Default | Description |
|---|---|---|---|
| `COINGECKO_API_KEY` | No | _empty_ | CoinGecko API key. |
| `COINMARKETCAP_API_KEY` | No | _empty_ | CoinMarketCap API key. |
| `PRICE_FETCH_TIMEOUT` | No | `10000` | Price fetch timeout (ms). |

## PBFT consensus

| Variable | Required | Default | Description |
|---|---|---|---|
| `PBFT_TIMEOUT` | No | `30000` | PBFT phase timeout (ms). |
| `MIN_VALIDATORS` | No | `1` | Minimum validators for consensus. |

## Capabilities

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_CAPABILITY_CONFIG` | No | `null` | Path to the capability/self-test JSON config (MIN_STAKE thresholds, per-capability self-test blocks). |

## BTC attestation publisher

Wallet and encoder the hub uses to publish ATTEST responses on Bitcoin.

| Variable | Required | Default | Description |
|---|---|---|---|
| `BTC_ADDRESS` | If publishing | _empty_ | Bitcoin address used to publish attestations. |
| `BTC_PUBKEY_HEX` | If publishing | _empty_ | Public key (hex) for the above address. |
| `BTC_ENCODER_URL` | If publishing | _empty_ | xchain-encoder endpoint for Bitcoin. |
| `BTC_ENCODER_API_KEY` | No | _empty_ | API key for the Bitcoin encoder. |
| `ATTESTATION_QUEUE_PATH` | No | `./data/attestation-queue.jsonl` | On-disk attestation publish write-ahead log (durable; replayed on restart). |
| `ATTESTATION_FAILOVER_POLL_MS` | No | `30000` | Sweep cadence (ms) for crash-replay and follower step-in of finalized responses. |
| `ATTESTATION_FAILOVER_WINDOW_BLOCKS` | No | `2` | Blocks of leader silence before the next responsible validator steps in to broadcast. |
| `ATTESTATION_LEADER_RETRY_MS` | No | `60000` | Grace (ms) before the sweep retries the leader's own un-broadcast entry. |
| `ATTESTATION_BLOCK_MS` | No | `600000` | Approx block time (ms) used to translate the failover window into a wall-clock silence threshold. |
| `ATTESTATION_TIMEOUT` | No | `60000` | Attestation timeout (ms). |
| `REORG_TIMEOUT` | No | `60000` | Reorg-handler timeout (ms). |

## DOGE oracle publisher

Wallet and encoder the hub uses to publish oracle prices on Dogecoin.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DOGE_ADDRESS` | If publishing | _empty_ | Dogecoin address used to publish prices. |
| `DOGE_PUBKEY_HEX` | If publishing | _empty_ | Public key (hex) for the above address. |
| `DOGE_ENCODER_URL` | If publishing | _empty_ | xchain-encoder endpoint for Dogecoin. |
| `DOGE_ENCODER_API_KEY` | No | _empty_ | API key for the Dogecoin encoder. |
| `DOGE_LOW_BALANCE_THRESHOLD` | No | `10` | Low-balance warning threshold (DOGE). |
| `PUBLISHER_QUEUE_PATH` | No | `./data/publisher-queue.jsonl` | On-disk price publish queue. |
| `PUBLISHER_MAX_ATTEMPTS` | No | `5` | Max publish retry attempts. |

## Reward tracker

| Variable | Required | Default | Description |
|---|---|---|---|
| `BTC_INDEXER_API_URL` | No | _empty_ | Bitcoin indexer endpoint used for reward tracking. |
| `BTC_INDEXER_API_KEY` | No | _empty_ | API key for the Bitcoin indexer. |
| `MAX_INDEXER_LAG_BLOCKS` | No | `200` | Max blocks the indexer's committed tip may trail the decoder before the hub treats the indexer's latest-block response as stale and falls back to graceful degradation, rather than anchoring a consensus snapshot on a lagging tip. |

## Governance

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOV_VOTING_PERIOD` | No | `604800000` (7 days) | Proposal voting period (ms). |
| `GOVERNANCE_TALLY_INTERVAL` | No | `60000` | Vote tally interval (ms). |

## LLM attestation provider

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_DEFAULT_MODEL` | No | `claude-sonnet-4-6` | Default judge model. Must be in the approved-models list. |
| `CLAUDE_BIN` | No | `claude` | Path to the Claude CLI binary. |
