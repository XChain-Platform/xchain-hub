/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - API
 *
 * This file parses in environmental variables and starts up the hub instance
 * As the process entry it keeps the boot-time env reads, the auth tier sets and every
 * require the unit suites stub; the middleware, route families and server live under
 * src/api/ and receive all of that through the one object apiContext() builds.
 *
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

// Before anything else logs. The env-validation failures immediately below are
// exactly the lines an operator needs levelled and timestamped, and
// installObservability does not run until startApi installs the middleware.
const { patchConsole } = require('./observability');
patchConsole({ service: 'xchain-hub', version: require('../package.json').version });

// The hub relies on per-tick .catch() and has no uncaughtException handler at
// all, so a throw outside a promise chain exits with node's default stderr dump
// and nothing a collector can key on.
const { installCrashHandlers } = require('./consensus/diagnostics');
installCrashHandlers({ service: 'xchain-hub' });

const { resolveSecretEnv } = require('./secret_env');
const { requireDbSecret, refuseUnsafeAuthPosture, refuseInvalidNetwork } = require('./api/boot_guard');
const hubConfig = require('./config');

const REQUIRED_ENV = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_PORT'];
const { getLogger } = require('./observability');
const logger = getLogger();
for(const key of REQUIRED_ENV){
    if(!hubConfig.env()[key]){
        logger.error('Missing required environment variable: ' + key);
        process.exit(1);
    }
}

// The DB password accepts two names, HUB_DB_SECRET (preferred) and the deprecated
// HUB_DB_PASS; src/api/boot_guard.js resolves it and refuses the boot without it.
const HUB_DB_SECRET = requireDbSecret(logger);

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const XChainHub  = require('./XChainHub');
const jsonRouter = require('express-json-rpc-router');
const http      = require('http');
const WebSocket = require('ws');
const axios     = require('axios');   // hub-to-indexer RPC (attestation request lookups)
const geoip     = require('geoip-lite');   // self-contained country/region DB; we read only country + region
// The SAME replacer HubDbBroadcaster.js signs its WS frames with, imported rather than
// copied: a bootstrap REST read and a streamed WS row must serialize a BIGINT column
// identically, or a consumer that switches between the two feeds sees the same value
// change JS type mid-stream. Importing is what makes that identity structural.
const { bigIntReplacer } = require('./lib/bigint_replacer.js');
const { parseCorsOrigin } = require('./api/cors_origin.js');
const { parseExemptLocal } = require('./lib/rate_limit_policy.js');
const { resolveMaxBatch, makeRpcBatchGuard } = require('./peers/rpc_batch_guard.js');   // JSON-RPC batch cardinality cap
// #1299: single source of truth for the co-sign/slash deviation band (no re-declared 0.05 literal).
// #2653: oracle round-interval/submission-window defaults shared with OracleRound.js and XChainHub.js.
const { ORACLE_DEVIATION_THRESHOLD, DEFAULT_ORACLE_ROUND_INTERVAL_MS,
        DEFAULT_ORACLE_SUBMISSION_WINDOW_MS } = require('./constants');
const { installMiddleware } = require('./api/middleware');
const { buildRpcController } = require('./api/rpc');
const { mountSnapshotRoutes } = require('./api/rest/hub_db_snapshot');
const { mountTelemetryRoutes } = require('./api/rest/telemetry');
const { mountRegistryRoutes } = require('./api/rest/registry');
const { startServer } = require('./api/server');

const HUB_PORT = hubConfig.HUB_PORT;
const HUB_HOST = hubConfig.HUB_HOST || '0.0.0.0';
const HUB_DB_KEEPALIVE_INTERVAL = parseInt(hubConfig.HUB_DB_KEEPALIVE_INTERVAL) || 30000;

// HUB_API_KEY gates the write/WS-subscribe surface: set, those paths fail closed
// (401) without a valid key. Unset, the hub REFUSES TO BOOT unless keyless
// operation is declared with HUB_ALLOW_UNAUTHENTICATED; see the posture
// block below.
const HUB_API_KEY        = hubConfig.HUB_API_KEY || '';
// Explicit declaration that this hub runs keyless (private network, fronting
// proxy, single-host regtest). It exists so a blind hard-require of HUB_API_KEY
// does not crash-loop managed deploys the way the same over-tightening did to the
// indexer (771880c) and the encoder (e2bf7c4) pre-launch: xchain-node's
// ConfigService sets this var for a managed deploy that has no key in its host
// env, so keyless stays possible but is always a stated choice, never a default.
const HUB_ALLOW_UNAUTHENTICATED = (hubConfig.HUB_ALLOW_UNAUTHENTICATED || '').toLowerCase() === 'true';
const HUB_RATE_LIMIT_RPM = parseInt(hubConfig.HUB_RATE_LIMIT_RPM) || 100;
// Loopback and private-range callers skip the per-IP cap by default. The
// caller this protects is the node's OWN indexer replaying a batch-bearing chain: it
// pushes one pushpricebatch per batch block as fast as it reads blocks, blows 100/min
// in seconds, and without this exemption needs HUB_RATE_LIMIT_RPM=60000 set by hand before
// recovery runs at all. Keyed on req.ip (post-trust-proxy), so a public client arriving through a
// private-IP reverse proxy is still throttled; see src/lib/rate_limit_policy.js.
// Set HUB_RATE_LIMIT_EXEMPT_LOCAL=false to cap every caller including those.
const HUB_RATE_LIMIT_EXEMPT_LOCAL = parseExemptLocal(hubConfig.HUB_RATE_LIMIT_EXEMPT_LOCAL);
// A comma-separated ALLOWLIST, not a single origin: the hub is called
// cross-origin by several wallet shells at once. parseCorsOrigin is what makes
// that work - handing `cors` the raw string echoes it verbatim to every caller
// and is accepted by no browser. See src/lib/corsOrigin.js.
const CORS_ORIGIN        = parseCorsOrigin(hubConfig.CORS_ORIGIN);

// Usage telemetry (anonymous install pings from xchain-node operators).
// Enabled by default on the central hub; an operator's local hub can refuse pings
// by setting TELEMETRY_ENABLED=false. Rows older than TELEMETRY_RETENTION_DAYS are pruned daily.
const TELEMETRY_ENABLED        = (hubConfig.TELEMETRY_ENABLED || 'true').toLowerCase() !== 'false';
const TELEMETRY_RETENTION_DAYS = parseInt(hubConfig.TELEMETRY_RETENTION_DAYS) || 90;
// Secret salt for the one-way IP hash. The connecting IP is NEVER stored; at ingest we
// derive a coarse country/region and a keyed HMAC, then discard the IP. Without a salt set,
// ip_hash is left null (we never store an unsalted hash, which would be trivially reversible).
const TELEMETRY_IP_SALT        = hubConfig.TELEMETRY_IP_SALT || '';
// Gate for the per-install detail endpoint (GET /telemetry/operators). Unlike the
// aggregate summary, that endpoint exposes per-server data (ip_hash/region/what-runs-where),
// so it is fail-closed: without this key set, the endpoint returns 401 for everyone.
const TELEMETRY_ADMIN_KEY      = hubConfig.TELEMETRY_ADMIN_KEY || '';

const coins          = require('./coins');

// Per-network { coin -> consensusHash } of the bundled canonical coin files,
// computed once at load. Served on getallconfigs so a consumer can compare the
// hub's consensus config against its OWN bundled hashes (transport-integrity
// check); the consumer still trusts only its own pinned files, never the hub.
const COIN_CONSENSUS_HASHES = {};
for(const net of coins.NETWORKS) COIN_CONSENSUS_HASHES[net] = coins.consensusHashes(net);
const WRITE_METHODS  = new Set([
    'updateconfig', 'registervalidator', 'rotatevalidator', 'deregistervalidator', 'syncvalidators',
    'propose', 'proposeslashpenalty', 'vote', 'requestattestation', 'reportreorg', 'initiateswap',
    'pushchaintip', 'pushpriceround', 'pushpricebatch', 'pushattestbatch', 'pushoracleprice',
    'pushpricereorg', 'pushxcallreorg', 'retractattestbatch',
    'pushdexreorg', 'pushbridgereorg', 'anchorflush', 'pauseeffectorspend', 'resumeeffectorspend'
]);

// Interim credential scoping: the reorg-retraction rails feed row:deleted
// broadcasts that durably delete quorum-signed relay rows fleet-wide, a strictly
// more destructive tier than the other writes sharing the bulk HUB_API_KEY. When
// HUB_REORG_API_KEY is set, these three methods require THAT key and the bulk key
// no longer authorizes them (and the reorg key authorizes nothing else), so a
// bulk-key compromise cannot fabricate retractions. Unset = legacy behavior
// (bulk-key gated), rolling-deploy safe. Full fix (2f+1 co-signed retractions)
// rides the shared flag-day set.
//
// pushpricebatch (PRICE v0, spec section 5.7 / decision D22) is deliberately
// NOT in this set: it is a FORWARD write that delivers new signed rounds, the
// same role pushpriceround already plays outside the retraction tier. Its own
// retraction path is pushpricereorg below; a batch push carries no
// destructive row:deleted broadcast of its own.
//
// retractattestbatch (ATTEST v5/v6, spec section 6.3 / frontier row 55) IS in this
// set even though it deletes nothing and only clears a display link: it is issued by
// the same rollback.js retraction block as its siblings and travels on the same
// HubClient credential, so leaving it in the bulk tier would mean an operator who
// scoped HUB_REORG_API_KEY had one retraction rail still answering to the bulk key.
const REORG_WRITE_METHODS = new Set(['pushpricereorg', 'pushxcallreorg', 'pushdexreorg', 'pushbridgereorg', 'retractattestbatch']);

const HUB_REORG_API_KEY   = hubConfig.HUB_REORG_API_KEY || '';

// Read methods whose RESPONSE is mesh-internal, keyed like writes when
// HUB_API_KEY is set: getallconfigs returns every service's connection
// parameters (hosts, ports, DB names, users), so it must never be publicly
// readable. This is the app-side half of retiring the hub.xchain.io Apache
// IP-allowlist lockdown (2026-06-26): once every mesh caller sends x-api-key,
// the vhost can proxy POST publicly and this tier carries the policy. Escape
// hatch for a staged rollout or emergency rollback: HUB_SENSITIVE_READ_AUTH=0
// disables enforcement for these methods only (writes stay keyed). The escape
// hatch does NOT reach the credential tier below: passwords stay keyed even
// when the hatch is open.
// getrollcallstatus is here for a different reason than getallconfigs: it carries
// no credential, but it reports how many validators have answered a given ROLLCALL
// epoch, and an epoch's signer count is a PRE-EVICTION TARGETING surface. A caller
// polling every hub can tell which keys are close to the K-epoch absence streak
// before the chain evicts them, which is a map of who to knock over. The ledger
// facts themselves (last_rolled_epoch, absent_streak) are deliberately NOT served
// here at all; they live on the BTC indexer, where they are authoritative.
const SENSITIVE_READ_METHODS = new Set(['getallconfigs', 'getrollcallstatus']);const SENSITIVE_READ_AUTH = hubConfig.HUB_SENSITIVE_READ_AUTH !== '0';

// Credential tier key; src/api/auth_gate.js says what it protects and the rollout order.
const HUB_CONFIG_SECRETS_API_KEY = hubConfig.HUB_CONFIG_SECRETS_API_KEY || '';

// Parse optional P2P config (P2P is enabled when P2P_VALIDATOR_ADDR is set)
const P2P_VALIDATOR_ADDR = hubConfig.P2P_VALIDATOR_ADDR || '';
// HUB_NETWORK names the deployment network (mainnet|testnet|regtest) for the consensus
// and ingest gates; src/api/boot_guard.js says when it is required and what it must name.
const HUB_NETWORK = (hubConfig.HUB_NETWORK || '').toLowerCase();

// Refuse an undeclared keyless write surface, then a bad ORACLE_EPOCH_START or HUB_NETWORK.
refuseUnsafeAuthPosture({ logger, HUB_API_KEY, HUB_ALLOW_UNAUTHENTICATED, P2P_VALIDATOR_ADDR, SENSITIVE_READ_AUTH });
refuseInvalidNetwork({ logger, hubConfig, P2P_VALIDATOR_ADDR, HUB_NETWORK });
const p2pConfig = P2P_VALIDATOR_ADDR ? {
    HUB_NETWORK:            HUB_NETWORK,
    P2P_PORT:               parseInt(hubConfig.P2P_PORT) || 10001,
    P2P_HOST:               hubConfig.P2P_HOST || '0.0.0.0',
    SEED_NODES:             (hubConfig.SEED_NODES || '').split(',').map(s => s.trim()).filter(s => s),
    P2P_VALIDATOR_ADDR:     P2P_VALIDATOR_ADDR,
    SIGNING_PRIVKEY_HEX:    resolveSecretEnv('SIGNING_PRIVKEY_HEX') || '',
    REQUIRE_SIGNATURES:     (hubConfig.REQUIRE_SIGNATURES || 'true').toLowerCase() !== 'false',
    P2P_HEARTBEAT_INTERVAL:    parseInt(hubConfig.P2P_HEARTBEAT_INTERVAL) || 15000,
    P2P_DEDUP_PRUNE_INTERVAL:  parseInt(hubConfig.P2P_DEDUP_PRUNE_INTERVAL) || 30000,
    P2P_WS_PING_INTERVAL:      parseInt(hubConfig.P2P_WS_PING_INTERVAL) || 30000,
    // Transport signer-set refresh poll (Option A auth follows on-chain validator
    // key rotation). Read at XChainHub.js:155; without it wired here the env knob
    // never reached p2pConfig and the interval was permanently pinned to 30000.
    P2P_SIGNER_SET_REFRESH_MS: parseInt(hubConfig.P2P_SIGNER_SET_REFRESH_MS) || 30000,
    P2P_RECONNECT_BASE:        parseInt(hubConfig.P2P_RECONNECT_BASE) || 2000,
    P2P_RECONNECT_MAX:      parseInt(hubConfig.P2P_RECONNECT_MAX) || 60000,
    // Per-IP inbound cap (anti-DoS, PeerManager). The default of 3 is too low
    // for co-located federations (N validators on one IP need N-1 inbound
    // slots each); without this line the env knob never reaches PeerManager.
    P2P_MAX_CONNECTIONS_PER_IP: parseInt(hubConfig.P2P_MAX_CONNECTIONS_PER_IP) || 3,
    P2P_MSG_DEDUP_TTL:      parseInt(hubConfig.P2P_MSG_DEDUP_TTL) || 60000,
    P2P_MAX_PAYLOAD:        parseInt(hubConfig.P2P_MAX_PAYLOAD) || 1048576,
    // XCHAIN derived-price source. Read-only access to THIS validator's own
    // BTC indexer database; XCHAIN is listed on no exchange, so the pair is computed
    // from realized on-chain fills rather than fetched. Unset = this hub abstains from
    // XCHAIN/USD and submits the 36 API pairs exactly as before, which is a supported
    // state: holding the price capability implies this access, and a validator without
    // it simply does not submit the pair.
    //
    // The window/buffer/bootstrap/volume overrides exist for regtest and e2e only. They
    // are CONSENSUS-UNIFORM values (constants.js): a hub running different ones computes
    // a different XCHAIN/BTC leg and lands outside the co-sign deviation band, so on a
    // real network they must be left unset and moved only by a coordinated flag-day.
    // That rule is now ENFORCED rather than merely stated: XchainPriceSource honors these
    // four only when HUB_NETWORK is regtest and logs a set-but-IGNORED warning otherwise.
    // They are still forwarded raw so the gate and its warning live at the single read.
    XCHAIN_PRICE_INDEXER_DB_HOST: hubConfig.XCHAIN_PRICE_INDEXER_DB_HOST || '',
    XCHAIN_PRICE_INDEXER_DB_PORT: hubConfig.XCHAIN_PRICE_INDEXER_DB_PORT || '',
    XCHAIN_PRICE_INDEXER_DB_NAME: hubConfig.XCHAIN_PRICE_INDEXER_DB_NAME || '',
    XCHAIN_PRICE_INDEXER_DB_USER: hubConfig.XCHAIN_PRICE_INDEXER_DB_USER || '',
    XCHAIN_PRICE_INDEXER_DB_PASS: resolveSecretEnv('XCHAIN_PRICE_INDEXER_DB_PASS') || '',
    XCHAIN_PRICE_INDEXER_DB_COIN: hubConfig.XCHAIN_PRICE_INDEXER_DB_COIN || 'BTC',
    XCHAIN_PRICE_WINDOW_BLOCKS:       hubConfig.XCHAIN_PRICE_WINDOW_BLOCKS || '',
    XCHAIN_PRICE_CONFIRMATION_BUFFER: hubConfig.XCHAIN_PRICE_CONFIRMATION_BUFFER || '',
    XCHAIN_PRICE_BOOTSTRAP_SATS:      hubConfig.XCHAIN_PRICE_BOOTSTRAP_SATS || '',
    XCHAIN_PRICE_MIN_BTC_VOLUME:      hubConfig.XCHAIN_PRICE_MIN_BTC_VOLUME || '',

    ORACLE_EPOCH_START:     parseInt(hubConfig.ORACLE_EPOCH_START),
    ORACLE_ROUND_INTERVAL:  parseInt(hubConfig.ORACLE_ROUND_INTERVAL) || DEFAULT_ORACLE_ROUND_INTERVAL_MS,
    ORACLE_SUBMISSION_WINDOW: parseInt(hubConfig.ORACLE_SUBMISSION_WINDOW) || DEFAULT_ORACLE_SUBMISSION_WINDOW_MS,
    // Per-round cap on collected peer submissions (anti-flood, OracleRound.js).
    // Passed through UNPARSED for the same reason as the retention knob below:
    // OracleRound.js owns the parse, the range check and the 200 default, so a
    // `parseInt(...) || 200` here would fork the default into two places and let
    // the api.js copy silently eat any value the consumer treats specially.
    // Same dead-knob class as P2P_SIGNER_SET_REFRESH_MS above: without this line
    // the env var never reached p2pConfig and the cap was pinned to the default.
    ORACLE_MAX_SUBMISSIONS_PER_ROUND: hubConfig.ORACLE_MAX_SUBMISSIONS_PER_ROUND,
    // Retention window (in rounds) for the diagnostic oracle_submissions table.
    // Passed through UNPARSED on purpose: OracleRound.js:88 does its own parseInt +
    // range validation and owns the 12960-round default, and it honours an explicit
    // 0 as "disable pruning" - which a `parseInt(...) || DEFAULT` here would eat.
    // Same class as P2P_SIGNER_SET_REFRESH_MS above: without this line the env knob
    // never reached p2pConfig and retention was permanently pinned to the default.
    ORACLE_SUBMISSIONS_RETENTION_ROUNDS: hubConfig.ORACLE_SUBMISSIONS_RETENTION_ROUNDS,
    // Attestation round cadence (AttestationRound.js:100, AttestationConsensus.js:295).
    // Same dead-knob class as P2P_SIGNER_SET_REFRESH_MS above: without these two lines
    // the env vars never reached p2pConfig and a real api.js child stayed pinned to the
    // 15s poll / 120s round-timeout defaults regardless of what the operator set.
    ATTESTATION_POLL_MS:            hubConfig.ATTESTATION_POLL_MS,
    ATTESTATION_ROUND_TIMEOUT_MS:   hubConfig.ATTESTATION_ROUND_TIMEOUT_MS,
    ORACLE_REWARD_PER_ROUND: hubConfig.ORACLE_REWARD_PER_ROUND || '10.00000000',
    SLASH_DEVIATION_THRESHOLD: hubConfig.SLASH_DEVIATION_THRESHOLD || String(ORACLE_DEVIATION_THRESHOLD),
    SLASH_MISSED_ROUNDS_THRESHOLD: hubConfig.SLASH_MISSED_ROUNDS_THRESHOLD || '30',
    COINGECKO_API_KEY:      hubConfig.COINGECKO_API_KEY || '',
    COINMARKETCAP_API_KEY:  hubConfig.COINMARKETCAP_API_KEY || '',
    PRICE_FETCH_TIMEOUT:    parseInt(hubConfig.PRICE_FETCH_TIMEOUT) || 10000
} : null;

// Timeout for DB / oracle-freshness probe Promises inside ping, health, and the
// oracle-staleness check. A single constant prevents silent per-probe drift.
const DB_PROBE_TIMEOUT_MS = 2000;

// Lightweight in-process counters for the config-fetch path. These reset on
// restart (no persistence needed: operators watch them as a live signal, not a
// historical log). Surfaced on /health as body-only telemetry (config_fetch:
// {served, errors}). They are deliberately NOT wired into the healthy/503 status:
// a config-fetch error must not flip the hub out of federation rotation (the DB
// probe and oracle staleness drive degraded). An alerting probe that cares about
// config-serve failures compares config_fetch.errors across two scrapes (a delta;
// the counts are cumulative-since-restart), rather than keying off the HTTP status.
const configFetchCounters = { served: 0, errors: 0 };

// What the parts under src/api/ read from this file, gathered once per boot: the hub,
// the boot-time env reads above and the modules the unit suites stub. A part never
// requires a stubbed module itself: proxyquire swaps requires only inside the module it
// loads, so a part that did would bind the real module and its suite would test nothing.
function apiContext(hub) {
    return {
        hub, logger, hubConfig, p2pConfig, bigIntReplacer, COIN_CONSENSUS_HASHES, configFetchCounters,
        DB_PROBE_TIMEOUT_MS, HUB_NETWORK, HUB_PORT, HUB_HOST, HUB_DB_KEEPALIVE_INTERVAL,
        HUB_API_KEY, HUB_REORG_API_KEY, HUB_CONFIG_SECRETS_API_KEY, SENSITIVE_READ_AUTH,
        WRITE_METHODS, REORG_WRITE_METHODS, SENSITIVE_READ_METHODS,
        CORS_ORIGIN, HUB_RATE_LIMIT_RPM, HUB_RATE_LIMIT_EXEMPT_LOCAL,
        TELEMETRY_ENABLED, TELEMETRY_RETENTION_DAYS, TELEMETRY_IP_SALT, TELEMETRY_ADMIN_KEY,
        express, helmet, cors, rateLimit, http, WebSocket, axios, geoip,
    };
}

// Returned directly, never through a promise, which would adopt a stubbed hub as a thenable.
function createHub(){
    return new XChainHub(
        hubConfig.HUB_DB_HOST,
        hubConfig.HUB_DB_PORT,
        hubConfig.HUB_DB_NAME,
        hubConfig.HUB_DB_USER,
        HUB_DB_SECRET,
        p2pConfig,
        // Standalone-mode network. Inert in validator mode, where p2pConfig.HUB_NETWORK
        // carries the identical value and wins; this is the only path by which a hub with
        // no p2pConfig at all can learn which network its ingest gates should resolve on.
        { network: HUB_NETWORK }
    );
}

// Brings every subsystem up in dependency order.
async function startSubsystems(hub){
    await hub.start();

    await hub.startP2P();
    await hub.startConsensus();
    await hub.startOracle();
    await hub.startCrossChain();
    await hub.startReorgHandler();
    await hub.startGovernance();

    // Sits after governance so ProviderRegistry's hot-reload hook can attach.
    await hub.startAttestation();

    // Start the capability registry: runs per-capability self-tests, polls the
    // indexer for this validator's on-chain stake, and maintains qualification.
    // Previously this was never called, leaving self-tests, stake tracking, and
    // qualification dormant. HUB_CAPABILITY_CONFIG points at the JSON config that
    // supplies MIN_STAKE thresholds and the per-capability self-test config blocks.
    await hub.startCapabilities(hubConfig.HUB_CAPABILITY_CONFIG || null);

    // Start sampling the per-table per-chain admission height watermark.
    // The broadcaster is constructed with (p2pConfig, db) and holds no hub handle, so the
    // hub is attached here, after the anchor publisher exists: the watermark reads this
    // hub's own per-chain admission tips and the anchor rail's deferred reward-attest queue
    // through it. Without the attach the hub publishes an empty heights object, which every
    // consumer reads as not satisfied, so a failed attach defers barriers rather than
    // over-claiming.
    if (hub.hubDbBroadcaster && typeof hub.hubDbBroadcaster.attachAdmissionSource === 'function')
        hub.hubDbBroadcaster.attachAdmissionSource(hub);
}

// Registration order is the request path: middleware and auth gate, REST routes, then JSON-RPC.
async function startApi(){
    const hub = createHub();
    await startSubsystems(hub);
    const ctx = apiContext(hub);

    const app = express();
    const observability = installMiddleware(app, ctx);
    const jsonRpcController = buildRpcController(ctx);
    mountSnapshotRoutes(app, ctx);
    mountTelemetryRoutes(app, ctx);
    mountRegistryRoutes(app, ctx);

    // Bound JSON-RPC batch cardinality (src/peers/rpc_batch_guard.js). The router below runs
    // Promise.all over every element of a batch array while the per-IP rate limiter at
    // the top of this stack charges the whole batch ONE token, so a single ~100 KB body
    // fans out into ~1,400 concurrent handlers on the shared DB pool. Mounted here, in
    // front of the router rather than globally, so it governs the dispatcher that
    // amplifies and cannot reject a REST route's array body; the limiter has already
    // charged its token by this point, so an oversize batch is never free.
    // Default 20, matching encoder/decoder/utxo-tracker. No hub caller batches at all
    // (every connector sends one call object), so the cap breaks no existing client.
    app.use(makeRpcBatchGuard(resolveMaxBatch(hubConfig.HUB_MAX_RPC_BATCH, 20)));

    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({methods: jsonRpcController}));

    startServer(app, ctx, observability);
}

startApi();
