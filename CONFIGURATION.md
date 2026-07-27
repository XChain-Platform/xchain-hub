# xchain-hub Configuration

The hub is configured entirely through environment variables (typically loaded
from a `.env` file in the service root - copy `.env.example` to `.env` to start).
This document is the authoritative catalogue of every variable the hub reads,
grouped by concern.

The hub is the platform's **config oracle and cross-chain coordinator**: it
serves configuration to the indexer/explorer, runs the validator P2P cluster,
drives PBFT consensus and oracle price rounds, and publishes attestations and
oracle prices on-chain. A misconfigured hub can therefore affect the whole
validator federation - read the **Silent-failure variables** section first.

---

## ⚠️ Silent-failure variables (read this first)

Two variables degrade security when left empty. The hub starts and appears
healthy, so the misconfiguration is easy to miss.

### `HUB_API_KEY` - empty disables API authentication

When `HUB_API_KEY` is set, authentication fails closed: mutating methods
(`updateconfig`, `registervalidator`, `propose`, `vote`, `requestattestation`,
`reportreorg`, `initiateswap`, the oracle/price push methods) and the hub-DB
WebSocket upgrade return 401 unless the caller presents the configured key.

When it is unset or empty those paths are **open**, so since  the hub
**refuses to boot** unless keyless operation is declared with
`HUB_ALLOW_UNAUTHENTICATED=true`. Keyless remains supported (single-host
regtest, a hub reachable only on a private network or behind an authenticating
proxy) but it has to be a stated choice rather than the result of a forgotten
variable. `xchain-node` sets the declaration automatically when it deploys a hub
with no key in the host env, except on mainnet, where the refusal stands.

**Production requirement:** always set a strong, random `HUB_API_KEY`. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Clients then send it on each request (the indexer reads the same value as
`HUB_API_KEY`, the encoder-facing services as their `*_ENCODER_API_KEY`, etc.).

### `SIGNING_PRIVKEY_HEX` - empty means unsigned P2P messages / no federation identity

`SIGNING_PRIVKEY_HEX` is the Ed25519 private key (a 32-byte seed, encoded as 64
hex characters) that authenticates this hub's P2P messages to the rest of the
validator federation. When the P2P cluster is enabled (see `P2P_VALIDATOR_ADDR`)
but this key is empty, the hub **loads no validator identity**: outbound messages
go out unsigned and this hub has no verifiable identity among its peers. Nothing
fails loudly - the hub simply never participates as an authenticated validator,
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
> non-empty value throws at startup - only the **empty** case is silent.

---

## Core API

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_PORT` | **Yes** | - | TCP port the REST/JSON-RPC API binds to. The hub will not start without it. |
| `HUB_HOST` | No | `0.0.0.0` | Bind interface. |
| `HUB_DB_KEEPALIVE_INTERVAL` | No | `30000` | DB keep-alive ping interval (ms). |

## Security

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_API_KEY` | **Prod** | _empty_ | API key required on write requests and WS upgrades when set. **Empty means the hub refuses to boot unless `HUB_ALLOW_UNAUTHENTICATED=true` - see above.** |
| `HUB_ALLOW_UNAUTHENTICATED` | No | _unset_ | Declares that this hub knowingly runs with an unauthenticated write surface. Only consulted when `HUB_API_KEY` is empty. |
| `HUB_CONSENSUS_INPUT_ALERT_AFTER` | No | `3` | Consecutive consensus-input fetch failures before the hub alerts and `/health` reports degraded. |
| `HUB_RATE_LIMIT_RPM` | No | `100` | Requests per minute per client. |
| `CORS_ORIGIN` | No | `false` | Allowed CORS origin; `false` disables cross-origin requests. |

## Database (MariaDB)

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_DB_HOST` | **Yes** | - | MariaDB host. |
| `HUB_DB_PORT` | **Yes** | - | MariaDB port. |
| `HUB_DB_NAME` | **Yes** | - | Database name. |
| `HUB_DB_USER` | **Yes** | - | Database user. |
| `HUB_DB_PASS` | **Yes** | - | Database password. |
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
| `TELEMETRY_ADMIN_KEY` | No | _empty_ | `x-api-key` gate for the telemetry admin/query surface (empty leaves it fail-closed). Must match the value the dashboard service is configured with. |

## P2P validator cluster

The P2P cluster, PBFT consensus, oracle rounds, cross-chain engine, reorg
handler, governance, and attestation subsystems are **all enabled only when
`P2P_VALIDATOR_ADDR` is set**. Leave it empty for a standalone config-oracle hub.

| Variable | Required | Default | Description |
|---|---|---|---|
| `P2P_VALIDATOR_ADDR` | No | _empty_ | This validator's address. Setting it enables the entire P2P/validator stack. |
| `ORACLE_EPOCH_START` | **If P2P** | - | Unix-ms timestamp anchoring oracle round numbering. Must be identical across all hubs in the federation. The hub exits at startup if P2P is enabled and this is unset. |
| `SIGNING_PRIVKEY_HEX` | **If P2P** | _empty_ | Ed25519 seed (64 hex chars). **Empty = unsigned / no identity - see above.** |
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
| `ATTESTATION_ROUND_TTL_MS` | No | `3600000` (1h) | Time-to-live for in-memory attestation round entries before lazy eviction. |
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
| `ORACLE_PUBLISH_ENABLED` | No | `true` | Operator-local kill switch for the oracle price publisher (mirrors the `*_ENABLED` publisher idiom). `false` skips both publish rounds and queue processing. Also resolves from `p2pConfig`; the env var wins. |

## Reward tracker

| Variable | Required | Default | Description |
|---|---|---|---|
| `BTC_INDEXER_API_URL` | No | _empty_ | Bitcoin indexer endpoint used for reward tracking. |
| `BTC_INDEXER_API_KEY` | No | _empty_ | API key for the Bitcoin indexer. |
| `MAX_INDEXER_LAG_BLOCKS` | No | `200` | Max blocks the indexer's committed tip may trail the decoder before the hub treats the indexer's latest-block response as stale and falls back to graceful degradation, rather than anchoring a consensus snapshot on a lagging tip. |

## Cross-chain / checkpoint confirmation depth

Consensus-affecting confirmation depths. Both also resolve from the hub
`p2pConfig` and fall back to per-coin defaults; the env var is the highest-
precedence override.

| Variable | Required | Default | Description |
|---|---|---|---|
| `XCHAIN_CONFIRMATIONS_<COIN>` | No | per-coin | Cross-chain attestation/swap confirmation depth for `<COIN>` (e.g. `XCHAIN_CONFIRMATIONS_BTC`). Consensus-affecting: read by `CrossChainEngine` / `CrossChainCallEngine`. |
| `CHECKPOINT_CONFIRMATIONS` | No | `6` | State-checkpoint confirmation depth (`StateCheckpointEngine`). Consensus-affecting. |

## State checkpoints (`StateCheckpointEngine`)

Quorum-signed per-chain ledger/actions/contract hash checkpoints, written to
`state_checkpoints` and streamed over the hub-DB mirror. Each variable also
resolves from `p2pConfig`; the env var is the highest-precedence override.

| Variable | Required | Default | Description |
|---|---|---|---|
| `CHECKPOINT_ENABLED` | No | `true` | Enable the checkpoint engine. Set `false` to disable. |
| `CHECKPOINT_INTERVAL_BLOCKS` | No | `6` | BTC blocks between checkpoint cycles. |
| `CHECKPOINT_CHAINS` | No | all coins | Comma-separated chains to checkpoint (subset of the bundled coin list, e.g. `BTC,LTC`). Unknown chains are dropped. |
| `CHECKPOINT_POLL_MS` | No | `60000` | Poll interval (ms) for the checkpoint cycle timer. |
| `CHECKPOINT_ROUND_TIMEOUT_MS` | No | `60000` | Signing-round timeout (ms) before a checkpoint round is abandoned. |
| `CHECKPOINT_COSIGN_TOLERANCE_BLOCKS` | No | `144` | How many blocks behind a checkpoint's `snapshot_block` a follower's own indexer may lag and still co-sign. |

## State-anchor publisher (`StateAnchorPublisher`)

ANCHOR v0/v1/v2 on-chain publishing of finalized checkpoints (published on
DOGE; wallet/encoder settings are in the DOGE oracle publisher section). Each
variable also resolves from `p2pConfig`; the env var wins.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANCHOR_ENABLED` | No | `true` | Enable on-chain anchoring. Set `false` to disable. |
| `ANCHOR_INTERVAL_MS` | No | `86400000` (24h) | Anchor cycle interval (ms). |
| `ANCHOR_CHECKPOINT_EVERY_N` | No | `1` | Anchor only every Nth `checkpoint_seq` (each v0 anchor spends real DOGE; recovery only needs the latest anchored checkpoint). `1` anchors every checkpoint. Deterministic fleet-wide (`seq % N`). |
| `ANCHOR_MATCH_BATCH_SIZE` | No | `200` | Rows per archive-batch query page. |
| `ANCHOR_MAX_BATCH` | No | `1000` | Max rows per archive (v1) anchor batch. |
| `ANCHOR_CHUNK_MAX_BYTES` | No | `6000` | Max payload bytes per on-chain anchor chunk. |
| `ANCHOR_CHUNK_RETRY_MS` | No | `2500` | Delay (ms) between chunk broadcast retries. |
| `ANCHOR_ROUND_TIMEOUT_MS` | No | `120000` | Quorum signing-round timeout (ms). |
| `ANCHOR_AMBIGUOUS_POLL_ATTEMPTS` | No | `3` |  ambiguous-send existence poll: attempts to find a maybe-accepted anchor in the indexer's mined view before deferring. |
| `ANCHOR_AMBIGUOUS_POLL_MS` | No | `5000` | Delay (ms) between ambiguous-send poll attempts. |
| `ANCHOR_ELECTION_TOLERANCE_BLOCKS` | No | `36` | Failover ladder: BTC blocks of elected-publisher silence before the next-ranked validator's publish slot unlocks. |
| `ANCHOR_REWARD_PER_PUBLISH` | No | `10.00000000` | XCHAIN reward recorded per anchor publish (`RewardTracker`). |

## Effector spend policy (`SpendGuard`, )

Every hub effector that spends real coin on-chain runs behind a shared
`SpendGuard`: a balance floor, a rolling per-window spend ceiling (hard-clamped
at the $2000 review admission ceiling), and a per-capability runtime pause. The
knobs below take a per-effector `<PREFIX>`; the four prefixes are
`ORACLE_PUBLISH`, `ATTEST`, `ANCHOR`, and `FULLNODE`. Each variable also
resolves from `p2pConfig`; the env var wins. The spend ceiling is
default-enabled: unset config yields the $2000 clamp, never "off".

| Variable | Required | Default | Description |
|---|---|---|---|
| `<PREFIX>_MAX_SPEND_USD_CENTS_PER_WINDOW` | No | `200000` ($2000) | Rolling per-window spend budget in USD cents. Clamped to `<= 200000`; an operator can only lower it. |
| `<PREFIX>_EST_SPEND_USD_CENTS` | No | `100` ($1) | Per-broadcast cost estimate charged against the window budget when the caller does not supply a real fee. |
| `<PREFIX>_MAX_PUBLISHES_PER_WINDOW` | No | `0` (off) | Optional per-window broadcast **count** cap (defense in depth alongside the USD budget). `<=0` disables the count cap. |
| `<PREFIX>_SPEND_WINDOW_MS` | No | `3600000` (1h) | Rolling window length (ms) for both the count and USD ceilings. |
| `<PREFIX>_MIN_BALANCE` | No | `0` | Wallet floor (native coin). A balance below the floor, or an unreadable (null) balance, skips the spend fail-closed. |

Runtime pause is operator-driven via JSON-RPC (auth-gated): `pauseeffectorspend`
/ `resumeeffectorspend` take `{ label }` (the effector's guard label, e.g.
`OraclePublisher`), and `geteffectorspendstatus` lists every effector's live
state. A pause halts the effector's primary/leader spend path immediately, with
no restart.

## Cross-chain DEX / XCALL relay (`CrossChainDexEngine`)

Match discovery over the chain-specific indexer DBs plus PBFT finalization.
The confirmation-depth variables are **consensus-affecting** (they gate when an
offer/call is eligible for matching). Each variable also resolves from
`p2pConfig`; the env var wins.

| Variable | Required | Default | Description |
|---|---|---|---|
| `XDEX_POLL_MS` | No | `15000` | Poll interval (ms) for match/relay discovery. |
| `XDEX_MIN_CONFIRMATIONS` | No | per-coin | Flat confirmation-depth override applied to every coin. Consensus-affecting. |
| `XDEX_MIN_CONFIRMATIONS_<COIN>` | No | per-coin (BTC `6`, LTC `12`, DOGE `60`) | Per-coin confirmation depth (e.g. `XDEX_MIN_CONFIRMATIONS_DOGE`). Takes precedence over the flat variable. Consensus-affecting. |
| `XDEX_SEED_LOCAL_VALIDATOR` | Regtest only | `false` | `1`/`true` seeds `capability_snapshots` with this hub's own identity so single-node regtest stacks can finalize without an indexer-backed snapshot. Ignored off regtest. |
| `XDEX_SNAPSHOT_BLOCK` | Regtest only | _unset_ | Fixed deterministic snapshot-block anchor for regtest drills (also read by `StateCheckpointEngine` / `CrossChainCallEngine`). Ignored off regtest. |

## Genesis / regtest binding

Regtest-only genesis overrides (ignored on mainnet/testnet, which use the frozen
bundled values). Consensus-relevant: they bind the local chain's genesis anchor.

| Variable | Required | Default | Description |
|---|---|---|---|
| `XCHAIN_GENESIS_BLOCK` | Regtest only | per-coin | Genesis block height for a regtest chain. |
| `XCHAIN_GENESIS_LEDGER_HASH` | Regtest only | per-coin | Genesis ledger-hash pin for a regtest chain. |
| `XCHAIN_GENESIS_DUMP_HASH` | Regtest only | per-coin | Genesis dump-hash pin for a regtest chain. |

## Fee destination override

| Variable | Required | Default | Description |
|---|---|---|---|
| `XCHAIN_FEE_DESTINATION_<COIN>_<NETWORK>` | Regtest only | bundled | Overrides the native-fee destination address for `<COIN>` on `<NETWORK>`. **Honored on regtest only**: on mainnet/testnet it is ignored (logged) because `FEE_DESTINATION` is consensus-pinned and an env override would escape the freeze and fork the block-hashed ledger. |

## Full-node challenge

Full-node challenge/proof configuration. Each key resolves from its `FULLNODE_*`
env var, else the bundled per-coin `FULLNODE` block.

| Variable | Required | Default | Description |
|---|---|---|---|
| `FULLNODE_ENABLED` | No | `true` | Enable the full-node challenge round. |
| `FULLNODE_CHALLENGE_INTERVAL_BLOCKS` | No | `144` | Blocks between challenge rounds. |
| `FULLNODE_POLL_MS` | No | `30000` | Poll interval (ms) for the challenge-round timer. |
| `FULLNODE_COLLECT_MS` | No | `20000` | Answer-collection window (ms) after a challenge is issued. |
| `FULLNODE_COLLECT_DEPTH_BLOCKS` | No | `3` | Blocks after the challenge block at which answer collection closes. |
| `FULLNODE_CONFIRM_DEPTH` | No | per-coin | Confirmation depth for challenge proofs. |
| `FULLNODE_PROOF_WINDOW_BLOCKS` | No | per-coin | Blocks a challenged node has to submit a proof. |
| `FULLNODE_VERDICT_ACCEPT_WINDOW_BLOCKS` | No | per-coin | Blocks to accept a verdict. |
| `FULLNODE_REWARD_PASS_WINDOW_BLOCKS` | No | per-coin | Blocks in the reward-pass window. |
| `FULLNODE_MIN_PASS_RATE_BPS` | No | per-coin | Minimum pass rate (basis points). |
| `FULLNODE_REWARD_SHARE` | No | per-coin | Reward share for passing full nodes. |
| `FULLNODE_GENESIS_VERIFIERS` | No | per-coin | Comma-separated genesis verifier pubkeys (lowercased). |
| `FULLNODE_BTC_RPC` | If enabled | _empty_ | Bitcoin RPC endpoint the full-node capability probes. |

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
| `LLM_PROVIDER_ENABLED` | No | `true` | Operator-local kill switch for this paid provider. `false` stops `fetch()`/`agree()` from dialing any billed vendor; authoritative and immediate, and survives a governance hotReload. Governance can also pause federation-wide via `additional_config.enabled`. Either source disabling pauses the provider. |
| `LLM_MAX_BUDGET_USD` | No | _unset_ (no cap) | Per-call USD spend ceiling for the `claude_spawn` transport (plumbed to `--max-budget-usd`). A positive number caps each call; unset, non-numeric, or non-positive means no budget. The env var wins over governance `additional_config.max_budget_usd` when both are positive. |
