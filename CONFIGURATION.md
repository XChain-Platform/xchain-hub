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

When it is unset or empty those paths are **open**, so the hub
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
| `HUB_RATE_LIMIT_RPM` | No | `100` | Requests per minute per client IP. Over the limit the hub answers `429` with a JSON-RPC error body (code `-32029`) naming the limit, the window and the wait, alongside `Retry-After` and `RateLimit-*` headers. |
| `HUB_RATE_LIMIT_EXEMPT_LOCAL` | No | `true` | Exempts loopback and private-range (RFC1918 / IPv6 ULA / link-local) callers from the per-IP limit, so a node's own indexer can rebuild price history from the chain at the shipped default instead of needing the limit raised by hand. Keyed on the post-`trust proxy` client IP, so a public caller behind a private-IP proxy is still limited. Set `false` to enforce the cap on every caller. |
| `HUB_MAX_RPC_BATCH` | No | `20` | Maximum JSON-RPC calls in one batch array. The router dispatches every element concurrently while the rate limit above charges the whole batch one token, so an uncapped batch amplifies one request into hundreds of DB-touching handlers. Over the cap the hub answers `400` with JSON-RPC error `-32600`. An unparseable or non-positive value keeps the default. |
| `CORS_ORIGIN` | No | `false` | Allowed CORS origin(s); unset disables cross-origin requests. `*` allows any origin, or give one origin or a comma-separated allowlist matched per-origin (browser wallet shells each send a different origin). A stray `*` inside a list is not a wildcard, so the grant fails closed. |

## Database (MariaDB)

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_DB_HOST` | **Yes** | - | MariaDB host. |
| `HUB_DB_PORT` | **Yes** | - | MariaDB port. |
| `HUB_DB_NAME` | **Yes** | - | Database name. |
| `HUB_DB_USER` | **Yes** | - | Database user. |
| `HUB_DB_SECRET` | **Yes** | - | Database password. Deprecated name `HUB_DB_PASS` is still read; see below. |
| `DB_QUERY_TIMEOUT` | No | `30000` | Per-query timeout (ms). |

### Secret variable names end in `_SECRET`

Automatic secret redaction, in terminals, CI logs and assistant transcripts,
keys on the variable **name** and matches `_SECRET` / `_KEY` / `_TOKEN`. A name
like `HUB_DB_PASS` matches nothing, so the value prints in full every time
someone reads the env file. In 2026-07 exactly that happened to a regtest hub.

Three hub secrets therefore accept a `_SECRET` name, with the historical name
kept as a deprecated fallback so no running deployment breaks:

| Preferred | Deprecated |
|---|---|
| `HUB_DB_SECRET` | `HUB_DB_PASS` |
| `XCHAIN_PRICE_INDEXER_DB_SECRET` | `XCHAIN_PRICE_INDEXER_DB_PASS` |
| `SIGNING_PRIVKEY_SECRET` | `SIGNING_PRIVKEY_HEX` |

The hub logs a warning at startup for each secret still supplied under the
deprecated name. Setting both names to different values is a startup error, not
a precedence rule: that shape is a half-finished rename, and picking a winner is
how a hub keeps authenticating with the credential it was supposed to rotate
away from. Renaming does not un-leak anything by itself: a credential that has
already been read out loud still has to be rotated.

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

## Metrics and log shipping

The shared observability module (`src/observability/`, vendored byte-identically
into the other services) adds a Prometheus scrape endpoint and a structured log
shim. Both are OFF unless set here: with no variables the hub registers no extra
route, starts no timer and opens no socket. Full reference, including the metric
names exported, is in `src/observability/README.md`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `METRICS_ENABLED` | No | _off_ | Serve the Prometheus scrape endpoint. |
| `METRICS_PATH` | No | `/metrics` | Scrape path. |
| `METRICS_TOKEN` | No | _empty_ | Require `Authorization: Bearer <token>` on the scrape. Set this (or keep the path behind the fronting proxy) on any internet-reachable box. |
| `METRICS_HTTP` | No | `true` when metrics are on | Per-request counters and a latency histogram. Set `0` for endpoint-only. |
| `LOG_FORMAT` | No | `text` | `json` emits one NDJSON record per log line. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn` or `error`. |
| `LOG_SHIP_ENABLED` | No | _off_ | POST batched NDJSON to a collector. Needs `LOG_SHIP_URL` too; either alone stays off. |
| `LOG_SHIP_URL` | No | _empty_ | Collector endpoint (http/https). |
| `LOG_SHIP_TOKEN` | No | _empty_ | Bearer token for the collector. Never logged or echoed. |
| `LOG_SHIP_BATCH_SIZE` | No | `100` | Lines per POST. |
| `LOG_SHIP_INTERVAL_MS` | No | `5000` | Flush interval. |
| `LOG_SHIP_MAX_BUFFER` | No | `5000` | Bounded buffer; the oldest lines are dropped and counted, never grown without limit. |
| `LOG_SHIP_TIMEOUT_MS` | No | `5000` | Per-batch POST timeout. |

## P2P validator cluster

The P2P cluster, PBFT consensus, oracle rounds, cross-chain engine, reorg
handler, governance, and attestation subsystems are **all enabled only when
`P2P_VALIDATOR_ADDR` is set**. Leave it empty for a standalone config-oracle hub.

| Variable | Required | Default | Description |
|---|---|---|---|
| `P2P_VALIDATOR_ADDR` | No | _empty_ | This validator's address. Setting it enables the entire P2P/validator stack. |
| `ORACLE_EPOCH_START` | **If P2P** | - | Unix-ms timestamp anchoring oracle round numbering. Must be identical across all hubs in the federation. The hub exits at startup if P2P is enabled and this is unset. |
| `SIGNING_PRIVKEY_SECRET` | **If P2P** | _empty_ | Ed25519 seed (64 hex chars). Deprecated name `SIGNING_PRIVKEY_HEX` is still read. **Empty = unsigned / no identity - see above.** |
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

## Stake-share monitor (`StakeShareWatcher`)

Watches this operator's own share of active stake against the `STAKE_WEIGHTED_QUORUM`
commit gate (`3*tally > 2*S`) and warns while rounds are still finalizing.

The gate counts community stake in its denominator whether or not that stake ever
signs, so a federation whose share has drifted to two thirds halts the moment one more
staker appears, and the round before gives no warning at all. On 2026-09-01 that cost
testnet 18 hours of dead price rounds, found by a tester rather than by a monitor.

Without `HUB_OPERATOR_STAKE_SOURCES` (or its per-chain form) the hub cannot tell its own
stake from anyone else's and the monitor **stays off**, saying so loudly at boot. Read
the result on `/health` (`stake_share`), from the `getstakeshare` RPC, or from the
`xchain_stake_share_*` gauges. Alert on `xchain_stake_share_stakes_to_halt <= 1` or
`xchain_stake_share_meets_gate == 0`; it never flips `/health` to 503, because it is a
forecast about the federation rather than a sickness of this process.

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_OPERATOR_STAKE_SOURCES_<COIN>` | No | `` | Comma-separated staking addresses this operator controls **on that chain** (`_BTC`, `_LTC`, `_DOGE`). The correct form: staking addresses are chain-specific. |
| `HUB_OPERATOR_STAKE_SOURCES` | No | `` | Union fallback applied to every watched chain, for a single-chain deployment. |
| `HUB_STAKE_SHARE_CHAINS` | No | every registered coin | Chains to watch, comma-separated ticks. |
| `HUB_STAKE_SHARE_CAPABILITIES` | No | `price,oracle_publish` | Capabilities to watch. These two gate the price rail: one the round's commit quorum, the other the publisher election that puts the result on chain. |
| `HUB_STAKE_SHARE_POLL_MS` | No | `300000` | Poll cadence. Stake moves at block cadence and the warning has hours of lead time. |
| `HUB_STAKE_SHARE_CRITICAL_STAKES` | No | `1` | Margin, in new stakes, that counts as CRITICAL (alerting). `1` means "the next community staker halts rounds". One stake is sized as the largest third-party stake already on that chain, floored at the capability MIN_STAKE. |
| `HUB_STAKE_SHARE_WARN_STAKES` | No | `2` | Margin, in new stakes, that counts as WARNING (logged, not alerting). |

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
| `ATTEST_PUBLISHED_REQUESTS_RETENTION_MS` | No | `7776000000` (90d) | Retention window for the durable `attest_published_requests` marker table, swept after any sweep pass that follows a publish; `0` disables. Only CONFIRMED rows are ever deleted: a `sent_at IS NULL` row is the quarantine marker for a request whose on-chain state is unknown after a crash, and it is kept forever for an operator to reconcile. The window is floored at the longest live provider `deadline_window_blocks` (past which no path can surface the request again) and never touches a request still on the WAL, so lowering it below that floor changes nothing. |
| `ATTESTATION_TIMEOUT` | No | `60000` | Attestation timeout (ms). |
| `ATTESTATION_ROUND_TTL_MS` | No | `3600000` (1h) | Time-to-live for in-memory attestation round entries before lazy eviction. |
| `REORG_TIMEOUT` | No | `60000` | Reorg-handler timeout (ms). |
| `REORG_ALLOW_UNRECORDED_OLDHASH` | No | unset (fail closed) | Escape hatch. When a reorg IS recorded at the claimed height but its orphaned hash was never recorded, this hub abstains rather than co-sign, because it cannot verify the claimed `oldHash`. Set to `1` to restore the previous behaviour and accept such claims; it logs loudly every time it does. Leaving it unset costs abstention only at heights whose orphaned hash is missing (measured 2026-07-29: 3 of 171 recorded orphaned blocks on mainnet, DOGE 6280198 and 6279100, LTC 3137602). |

## Attestation relay (`AttestationRelay`)

Attestation staking lives on Bitcoin, so an ATTEST request made on an origin
chain (LTC, DOGE) is relayed to BTC as a v3 request and the finalized answer is
relayed back to the origin chain as a v4 response. The relay therefore needs a
broadcast rail on **every** origin chain it serves, not just on the home chain.

The per-origin-chain variables below are read **dynamically** (`process.env[coin
+ '_ENCODER_URL']` and friends), which is why they do not appear in any static
env-var scan: nothing but this table will remind you they exist. `<COIN>` is any
allowed coin other than `BTC`, so today `LTC` and `DOGE`. Each also resolves
from `p2pConfig`; the env var wins.

**Leaving an origin chain's rail unconfigured does not fail loudly.** The v4 is
still consensus-finalized and then **held forever**, behind one startup warning
(`no <COIN> broadcast rail`). Responses are held rather than dropped, so the
recovery is to configure the rail and restart, but nothing re-warns in the
meantime. Check `attest_relay` on `/health` to see the hold: a rising
`awaiting_broadcast` with a flat `responses_relayed` is this misconfiguration.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ATTEST_RELAY_ENABLED` | No | `0` (off) | Opt-in switch, not a kill switch: a fleet that has merely deployed the relay code runs nothing until this is `1`. |
| `ATTEST_RELAY_POLL_MS` | No | `15000` | Poll interval (ms) for the request and response legs. |
| `ATTEST_RELAY_QUEUE_PATH` | No | `./data/attest-relay-queue.jsonl` | On-disk at-most-once write-ahead log for both legs. A duplicate v3 is rejected on-chain, so replaying one only burns a real fee; this file is what stops a restart from doing that. |
| `ATTEST_RELAY_FAILOVER_MS` | No | `1200000` (20m) | Wall-clock silence per rank before a non-leader broadcasts a round it already co-signed. Rank 0 sends immediately, rank 1 waits one window, and so on. |
| `ATTEST_RELAY_EVICT_GRACE_BLOCKS` | No | `144` | Origin-chain blocks past a request's own `deadline_block`, on top of that chain's confirmation depth, before the relay forgets the request's at-most-once records and compacts them out of the queue file. Raising it keeps records longer; lowering it below the origin indexer's expiry lag risks re-relaying a request and burning a fee, so a garbage or negative value falls back to the default. |
| `<COIN>_ENCODER_URL` | If relaying to `<COIN>` | _empty_ | xchain-encoder endpoint used to build the v4 response transaction on origin chain `<COIN>` (e.g. `LTC_ENCODER_URL`). Empty means no rail: see the hold warning above. |
| `<COIN>_ENCODER_API_KEY` | No | _empty_ | API key for that origin chain's encoder. |
| `<COIN>_ADDRESS` | If relaying to `<COIN>` | _empty_ | Wallet address on `<COIN>` that pays for and publishes v4 responses (e.g. `LTC_ADDRESS`). |
| `<COIN>_PUBKEY_HEX` | If relaying to `<COIN>` | _empty_ | Public key (hex) for that address. |
| `<COIN>_INDEXER_API_URL` | If relaying to `<COIN>` | _empty_ | Indexer endpoint the relay reads `<COIN>`-origin ATTEST requests from. Also accepted as `<COIN>_INDEXER_URL`, or pushed via `xchain-node updateconfig`. A chain with no indexer URL is skipped every tick, with a startup warning. |
| `<COIN>_INDEXER_API_KEY` | No | _empty_ | API key for that indexer. |

The home (BTC) rail reuses the **BTC attestation publisher** variables above
(`BTC_ENCODER_URL`, `BTC_ADDRESS`, `BTC_PUBKEY_HEX`, `BTC_INDEXER_API_URL`).
Origin rails are deliberately kept separate from it: an operator broadcast hook
configured for one chain would put an LTC payload on BTC, where it is rejected
outright after burning a real BTC fee. Spend limits come from the shared
`SpendGuard` under the `ATTEST` prefix (see **Effector spend policy**), and
confirmation depths from `XCHAIN_CONFIRMATIONS_<COIN>`.

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
| `ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS` | No | `12960` | Retention window (in rounds, ~90 days at the default round interval) for the durable `oracle_published_rounds` marker table; `0` disables pruning. Only confirmed rows (`sent_at` set) are pruned, and never a round still on the publish queue: intent-only quarantine rows awaiting operator reconciliation are kept forever. Also resolves from `p2pConfig`; the env var wins. |
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
| `XCHAIN_CONFIRMATIONS_<COIN>` | No | per-coin | Cross-chain attestation/swap confirmation depth for `<COIN>` (e.g. `XCHAIN_CONFIRMATIONS_BTC`). Consensus-affecting: read by `CrossChainEngine`, `CrossChainCallEngine`, `AttestationRelay` and `StateAnchorPublisher`. **May only RAISE the depth on mainnet and testnet**: a below-default value is clamped back up to the per-coin default, because a validator co-signing at a shallower depth accepts source actions the rest of the federation still considers reorg-able. Only regtest, the single-operator drill network, honours a lowered value. |
| `CHECKPOINT_CONFIRMATIONS` | No | `6` | State-checkpoint confirmation depth (`StateCheckpointEngine`). Consensus-affecting. |

## Cross-chain attestation persistence (`CrossChainEngine`)

A commit-quorum-finalized cross-chain attestation used to be **destroyed** by a
single transient DB error: the store's `.catch` deleted the round, and both
`_handleCommit` and `_checkCommitQuorum` return early once the id is gone, so no
later COMMIT could re-drive persistence. The store is now retried with bounded
exponential backoff (the `INSERT` upserts on `attestation_id`, so re-running it
is safe), and on exhaustion the round is **retained** with its finalize flag
reset so a retransmitted COMMIT re-drives it.

Both values must be strictly positive integers; anything else falls back to the
default with a startup warning. Keep the total retry budget well inside
`ATTESTATION_TIMEOUT`, because the round timer is the terminal backstop.

| Variable | Required | Default | Description |
|---|---|---|---|
| `XCHAIN_ATTEST_STORE_RETRIES` | No | `4` | Attempts to persist a quorum-finalized cross-chain attestation before giving up. `1` disables retrying. |
| `XCHAIN_ATTEST_STORE_RETRY_MS` | No | `100` | Base backoff (ms) between those attempts; doubles per attempt, capped at 2000ms. |

**Residual risk.** Retention is not durability. Once retries are exhausted the
round survives only until its own timer fires (`ATTESTATION_TIMEOUT` on the
initiating hub, twice that on a follower), so a DB outage outlasting that window
with no further COMMIT due still loses the attestation locally while peers keep
it. Closing that gap needs cross-hub reconciliation (a `FINAL_SYNC`-style state
transfer, as `CrossChainDexConsensus` already does), which is not built.

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
| `CHECKPOINT_STALL_LOG_MS` | No | `3600000` (1h) | Throttle window (ms) for the "checkpoint cadence STALLED" warning. The poll runs far faster than the cadence, so the reason is logged at most once per window; the `cadence_stalls` counter carries the true rate. |

## State-anchor publisher (`StateAnchorPublisher`)

ANCHOR v7/v1/v2 on-chain publishing of finalized checkpoints (published on
DOGE; wallet/encoder settings are in the DOGE oracle publisher section). Each
variable also resolves from `p2pConfig`; the env var wins.

One ANCHOR v7 per network per cycle carries every chain's newest un-anchored
checkpoint as a SECTION, so a cycle runs one election, one publisher
attestation round and one DOGE spend rather than one of each per chain. The
superseded per-chain wires (v0/v3/v4/v5) are gone. The archive leg (v1 head, v2
continuation chunks) is unchanged.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANCHOR_ENABLED` | No | `true` | Enable on-chain anchoring. Set `false` to disable. |
| `ANCHOR_INTERVAL_MS` | No | `86400000` (24h) | Anchor cycle interval (ms). |
| `ANCHOR_CHECKPOINT_EVERY_N` | No | `1` | Anchor only every Nth checkpoint round (each bundle spends real DOGE; recovery only needs the latest anchored checkpoint). `1` anchors every checkpoint. Eligibility is the checkpoint ORDINAL, `FLOOR(checkpoint_seq / CHECKPOINT_INTERVAL_BLOCKS) % N`, because `checkpoint_seq` is the round's BTC `snapshot_block` and the cadence latch advances it by exactly one interval per round: a raw `seq % N` would be a residue class pinned by the seed, not a sample, and for any N sharing a factor with the interval (2 or 3 against the default 6) the federation would either anchor every cadence or anchor nothing at all, permanently. Deterministic fleet-wide, so N and `CHECKPOINT_INTERVAL_BLOCKS` must both be uniform across the federation. Not a cadence control: `ANCHOR_INTERVAL_MS` is. |
| `ANCHOR_MATCH_BATCH_SIZE` | No | `200` | Rows per archive-batch query page. |
| `ANCHOR_MAX_BATCH` | No | `1000` | Max rows per archive (v1) anchor batch. |
| `ANCHOR_CHUNK_MAX_BYTES` | No | `6000` | Max payload bytes per on-chain anchor chunk. |
| `ANCHOR_CHUNK_RETRY_MS` | No | `2500` | Delay (ms) between chunk broadcast retries. |
| `ANCHOR_ROUND_TIMEOUT_MS` | No | `120000` | Quorum signing-round timeout (ms). |
| `ANCHOR_AMBIGUOUS_POLL_ATTEMPTS` | No | `3` | Ambiguous-send existence poll: attempts to find a maybe-accepted anchor in the indexer's mined view before deferring. |
| `ANCHOR_AMBIGUOUS_POLL_MS` | No | `5000` | Delay (ms) between ambiguous-send poll attempts. |
| `ANCHOR_ELECTION_TOLERANCE_BLOCKS` | No | `36` | Failover ladder: BTC blocks of elected-publisher silence before the next-ranked validator's publish slot unlocks. |
| `ANCHOR_STARTUP_FLUSH_MS` | No | `60000` (1m) | Delay before the one normal (leader) flush a hub runs after start. The interval timer first fires a full `ANCHOR_INTERVAL_MS` after start and the rank wake is failover-only, so without this a hub restarted more often than once per interval never anchored anything. Idempotent across a rolling restart. `0` disables. |
| `ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS` | No | `false` | Whether an anchor may be funded from this address's own unconfirmed change. Off, each anchor stands on its own fee rate (Dogecoin Core 1.14 miners score a transaction alone, so a child never lifts a stuck parent); a flush with no confirmed output defers with `NO_CONFIRMED_UTXO` and the next rank wake retries it as a normal flush. Archive chunks always spend the head's change by design. Set `true` only on venues that mine on demand. |
| `ANCHOR_CONFIRM_CHECK_MS` | No | `300000` (5m) | How often the confirmation watchdog re-reads the publisher address to see which of this hub's own anchor broadcasts have mined. `0` disables. |
| `ANCHOR_CONFIRM_STALE_MS` | No | `1800000` (30m) | Age past which a still-unconfirmed anchor broadcast is logged as `UNCONFIRMED_ANCHOR` on every watchdog pass. Nothing is re-broadcast or fee-bumped. |
| `ANCHOR_RANK_WAKE_MS` | No | `900000` (15m) | How often a BACKUP re-checks whether its failover rank has unlocked, between `ANCHOR_INTERVAL_MS` ticks. The wake flush runs in failover-only mode, so it never publishes an election this hub leads and a healthy leader keeps its interval and size-trigger cadence. |
| `ANCHOR_ANNOUNCE_RETRY_MS` | No | `300000` | How often a receiver re-verifies queued `XANC_V0_DONE` announcements. The publisher announces at 0 confirmations, so peers queue the announcement and stamp `anchor_txid` once the anchor is buried `XCHAIN_CONFIRMATIONS_DOGE` deep. That knob governs the hub's stamp/attest gate only; the BTC indexer's anchor-reward mint gate applies a frozen ledger depth (`ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS`, equal to the per-coin DOGE default) that no environment variable moves. On regtest, where a lowered override is honoured, the hub therefore attests before the indexer will mint and BTC block processing defers until the anchor reaches the frozen depth. |
| `ANCHOR_ANNOUNCE_RETRY_TTL_MS` | No | `21600000` | How long a queued announcement is retried before it is dropped, so a never-mined (evicted or replaced) anchor tx cannot suppress a needed re-anchor forever. |
| `ANCHOR_ANNOUNCE_QUEUE_MAX` | No | `500` | Max queued announcements per hub; the oldest entry is evicted past this. |
| `ANCHOR_INTENT_TTL_MS` | No | `21600000` | How long a durable broadcast intent (`anchor_published_checkpoints`) HOLDS its checkpoint when no anchor has mined for it. The publisher arms the marker before the send and stamps `anchor_txid` after it, so a crash in between is the one state where DOGE may have paid with nothing recording it; the hold stops the next flush rebuilding a second transaction from different UTXOs. Same `~6x` the 60-conf DOGE window bound as `ANCHOR_ANNOUNCE_RETRY_TTL_MS`, past which a send that never relayed is not coming back and holding the row costs more than re-broadcasting it. |
| `ANCHOR_MARKER_RETENTION_MS` | No | `7776000000` (90d) | Retention window for the two durable anchor marker tables (`anchor_published_checkpoints`, `anchor_published_archives`), swept at the end of each publishing flush; `0` disables. Only CONFIRMED rows are ever deleted: a surviving `sent_at IS NULL` row is the ambiguous-send record, the only durable trace that DOGE may already have paid, and it is kept forever. The cutoff is measured on `intent_at` and floored at a multiple of `ANCHOR_INTENT_TTL_MS`, so it can never reach a marker still inside its hold window; lowering this below that floor changes nothing. |
| `ANCHOR_REWARD_PER_PUBLISH` | No | `10.00000000` | XCHAIN reward recorded per anchor publish (`RewardTracker`). One `anchor_bundle` reward per BUNDLE (not per chain), keyed on the bundle's snapshot block. At/above the anchor-reward flag-day the frozen consensus amount is used instead, so this knob only applies below it. |

### Why those magnitudes (before you retune them)

None of these is consensus data, so two hubs on different values still produce
mutually verifiable anchors. Three of them do encode a real bound, and the full
derivation lives in
[ANCHOR.md](https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/actions/anchor.md)
("Where the publisher constants come from"), mirrored in the `StateAnchorPublisher`
constructor comment and pinned by
`test/unit/StateAnchorPublisher.constant-derivations.test.js`. In short:

- **`ANCHOR_CHUNK_MAX_BYTES` = 6000** reserves head room under the protocol's
  8192-byte `MAX_ACTION_DATA_LENGTH` ceiling, because chunk 0 shares the v1/v6
  action with the checkpoint prefix (~322 B) and the signature lists (194 B per
  `(PUBKEY, SIG)` pair, doubled on a v6). The ~1870 B left over is about nine
  signature pairs on a v1, or 4+4 on a v6. **Lower this as the federation
  grows:** a 5+5 v6 quorum needs ~5860 or less, a 7+7 quorum ~5080. Going over
  the ceiling is not a loud failure; the decoder silently drops the action.
- **The v7 bundle budget is 8189 bytes** (`MAX_ACTION_DATA_LENGTH` 8192 less the
  3-byte push prefix) and is NOT an env knob: it is the on-chain ceiling. What
  consumes it is the federation's signer count, since a section costs ~420 B plus
  194 B per `(PUBKEY, SIG)` pair and the publisher tail ~67 B plus 194 B per
  attesting signer. Measured capacity: **6 chains at 4 signers, 5 at 5, 3 at 7.**
  Past it the publisher SPLITS the cycle chain-ascending into as many bundles as
  fit, each electing at its own snapshot block, and logs one line per split. A
  single section that cannot fit even with a zero-signature tail is refused
  loudly and counted in `getanchorstatus.bundlesOversize`; it is never sent,
  because the decoder drops an oversize action silently rather than rejecting it.
- **`ANCHOR_MATCH_BATCH_SIZE` = 200** is an early-flush latency trigger, and
  **`ANCHOR_MAX_BATCH` = 1000** is the per-cycle DOGE spend bound. Archive rows
  are signature-dominated and do not compress (~0.55 KB of gzip+base64 per
  settled match), so 1000 rows is ~550 KB, ~93 chunks, ~93 DOGE transactions in
  one cycle; 200 rows is ~19.
- **`ANCHOR_ELECTION_TOLERANCE_BLOCKS` = 36** is ~6h of BTC blocks per failover
  rank, now applied to the BUNDLE rather than to each row. Blocks, not wall clock, so every hub agrees on the unlock without clock
  sync. The ordering is what matters: signing round (120s) + DOGE burial (60
  confs, ~1h) << 36 blocks (~6h) << `ANCHOR_INTERVAL_MS` (24h), which keeps a
  slow leader from being overtaken while still giving ranks 1-3 a slot (~6/12/18h)
  inside one publishing cycle. Roughly 6 to 144 blocks preserves both bounds; a
  wrong value costs duplicate DOGE or delayed anchoring, never a divergence.
- **`ANCHOR_RANK_WAKE_MS` = 900000** is what makes that ladder reachable. Rank is
  evaluated only inside a flush, so with flushes on the 24h interval plus size
  triggers, a backup's ~6h unlock was noticed only by phase luck and a dead rank 0
  stranded work for a cycle. The wake sits inside the same ordering (120s signing
  round << 15 min << 36 blocks), and it publishes only where this hub is a BACKUP,
  so a slow-but-healthy leader is still never overtaken by it.

### What `getanchorstatus` counts

- **`anchorsPublished`** counts BUNDLES, one per network per cycle. It kept its
  name through the v7 change, so a figure recorded before the change counted
  anchors (one per chain) and is not comparable with one recorded after.
- **`sectionsAnchored`** counts the CHAINS those bundles carried, which is the
  quantity the old `anchorsPublished` reported. A healthy three-chain federation
  on a daily cadence advances `anchorsPublished` by 1 and `sectionsAnchored` by 3
  per cycle; the two moving at the same rate means the cycle is anchoring one
  chain at a time and the rest of the chains are not producing checkpoints.
- **`bundlesOversize`** counts sections REFUSED for exceeding the 8189-byte
  budget on their own. Any non-zero value means a checkpoint is not on chain at
  all and the federation's signer count (or the section width) has to come down;
  it never self-clears.

## Effector spend policy (`SpendGuard`)

Every hub effector that spends real coin on-chain runs behind a shared
`SpendGuard`: a balance floor, a rolling per-window spend ceiling (hard-clamped
at the $2000 AML admission ceiling), and a per-capability runtime pause. The
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
| `<PREFIX>_SPEND_STATE_PATH` | No | `./data/spend-state/<label>.json` | Durable copy of the live spend window, armed at the effector's `start()`. Without it both ceilings are memory-only, so every restart hands the effector its full allowance back and a crash-loop spends one window's budget per restart. A relative path resolves once against the cwd the hub booted in; a corrupt or unreadable file is read as a SPENT window, never an empty one. |

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
| `FULLNODE_SPEND_LOG_PATH` | No | `./data/fullnode-verdict.spend.jsonl` | Durable spend-audit JSONL for the fee-bearing NODEPROOF verdict send. An intent line is fsync'd before the broadcast and the broadcast is gated on that write, so an unwritable path defers the verdict rather than spending with no record. |

## ROLLCALL presence proofs (`RollcallRound`)

Validator liveness. Every hub signs a canonical bound to a BTC epoch block's
`ledger_hash`, gossips the signature, and an elected leader lands the collected
signatures on DOGE as a `ROLLCALL` action; the BTC indexer closes the epoch and
evicts sources absent for K consecutive rolled epochs. Publishing reuses the DOGE
oracle-publisher rail (`DOGE_ADDRESS`, `DOGE_ENCODER_URL`, `HUB_SIGNER_MODULE`,
`DOGE_LOW_BALANCE_THRESHOLD`) and the shared `SpendGuard`, so there is no second
wallet and no second key.

**The consensus constants are not here and have no env surface.** The epoch
cadence, accept window, proof delay, DOGE maturity, K, the streak lookback, the
publish reward and the activation heights live in `src/rollcall_activation.js`,
byte-identical to the indexer's copy, because the hub signs what the indexer
judges and a one-sided edit forks the fleet at the epoch boundary. Only the three
publish tunables below are policy: no chain rule reads any of them, so two hubs on
different values still produce roll calls each other's indexers accept.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ROLLCALL_ENABLED` | No | `true` | Enable the roll-call round. `false` stops this hub signing, which over K rolled epochs is what eviction means; it is not a way to reduce cost. |
| `ROLLCALL_POLL_MS` | No | `30000` | Poll interval (ms) for the round timer. |
| `ROLLCALL_PUBLISH_DELAY_BLOCKS` | No | `12` (regtest `1`) | BTC blocks after the epoch before the elected leader may publish, so peers' signatures have arrived before the first action is paid for. |
| `ROLLCALL_ELECTION_TOLERANCE_BLOCKS` | No | `36` (regtest `3`) | Failover ladder step: BTC blocks of leader silence before the next-ranked publisher's slot unlocks. Deliberately a SEPARATE knob from `ANCHOR_ELECTION_TOLERANCE_BLOCKS`, so changing the roll-call cadence cannot re-inert the anchor ladder. |
| `ROLLCALL_SELF_PUBLISH_BLOCKS` | No | `100` (regtest `9`) | BTC blocks after the epoch at which a hub whose OWN signature is still not on chain publishes a one-signature roll call itself. The censorship escape hatch, not the liveness failover; the ladder above is that. The regtest pair is 3 and 9 rather than 2 and 6 because a deadline of 6 sits exactly on the canonical reorg buffer, so it would already have expired on a round's first tick and no sweeper would ever get a turn. |
| `ROLLCALL_SPEND_LOG_PATH` | No | `./data/rollcall-publish.spend.jsonl` | Durable spend-audit JSONL for the fee-bearing publish. An intent line is fsync'd before the broadcast and the broadcast is gated on that write, so an unwritable path defers the publish rather than spending with no record, and a restart cannot re-publish an epoch a prior process already committed. |
| `ROLLCALL_SIGN_LOG_PATH` | No | `./data/rollcall-signatures.jsonl` | Durable store of this hub's own epoch signatures, so a restart inside the accept window re-emits the SAME signature instead of falling silent for an epoch it had already answered. |

### Why those magnitudes (before you retune them)

The ordering is what binds, and
`test/unit/RollcallRound.invariants.test.js` pins both halves of it for every
network's defaults:

- **`PUBLISH_DELAY` < `SELF_PUBLISH` < `ACCEPT_WINDOW - 24`.** The 24 BTC blocks
  of margin cover the DOGE landing plus a Dogecoin miner's two-hour timestamp
  slack, so a self-publish issued at the last moment still lands inside the window
  the BTC close cuts. Push `SELF_PUBLISH` past that margin and the escape hatch
  publishes into an epoch that has stopped counting.
- **At least three ranks unlock inside the accept window.** The epoch height is
  FIXED while the tip advances through the window, so `since` grows to the full
  `ACCEPT_WINDOW` and `floor(144 / 36) = 4` ranks come up. (The anchor ladder is
  inert on its bundle rail for the opposite reason: a checkpoint's `snapshot_block`
  chases the tip, so its `since` never grows.) Raising the tolerance past a third
  of the window leaves a dead leader with no sweeper, which costs the epoch.

Cost is about **0.006 DOGE per one-chunk roll call** (two transactions at ~0.003
DOGE each, because every ROLLCALL is a two-phase P2SH publish). There is no
fee-bump and no RBF anywhere in the hub, by design: a fee spike that keeps every
action out of the window costs the epoch, and an unrolled epoch counts for nobody
and evicts nobody. The dashboard alerts on consecutive unrolled epochs.

### `HUB_SIGNER_MODULE` must export `broadcast(payload)`

Every ROLLCALL is a two-phase P2SH encoding and the built-in encoder pipeline can
only broadcast the funding transaction of the two, so it fails closed instead. A
signer module exporting only `walletSign` therefore signs roll calls it can never
publish. `validator init` generates a module that exports `broadcast`; a
hand-built one is the gap. `getrollcallstatus.broadcast_capable` reports it and
the `oracle_publish` self-test fails on it, so the condition is visible rather
than showing up as a federation that mysteriously never rolls. A hub without it
still SIGNS and gossips, and the sweepers carry its presence to chain: that is
exactly why there are several of them.

### `getrollcallstatus`

A SENSITIVE read (keyed by `HUB_API_KEY` like `getallconfigs`), always HTTP 200.
It reports this hub's publisher state for the newest epoch it is tracking:
`{epoch, signed, gossiped_count, on_chain_count, leader, our_rank, txids,
broadcast_capable}`. It carries no credential, but a per-epoch signer count is a
pre-eviction targeting surface: a caller polling every hub could tell which keys
are close to the absence streak before the chain acts on it. The ledger facts
(`last_rolled_epoch`, `absent_streak`) are deliberately absent; they belong to the
BTC indexer's `getrollcallabsences`, where they are authoritative.

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
