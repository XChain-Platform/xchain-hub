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
 *
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

// Before anything else logs. The env-validation failures immediately below are
// exactly the lines an operator needs levelled and timestamped, and
// installObservability does not run until ~380 lines further down.
const { patchConsole } = require('./observability');
patchConsole({ service: 'xchain-hub', version: require('../package.json').version });

// The hub relies on per-tick .catch() and has no uncaughtException handler at
// all, so a throw outside a promise chain exits with node's default stderr dump
// and nothing a collector can key on.
const { installCrashHandlers, noteShutdown } = require('./consensusDiagnostics');
installCrashHandlers({ service: 'xchain-hub' });

const { resolveSecretEnv, deprecatedSecretEnvNames } = require('./secret-env');

const REQUIRED_ENV = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_PORT'];
for(const key of REQUIRED_ENV){
    if(!process.env[key]){
        console.error('Missing required environment variable: ' + key);
        process.exit(1);
    }
}

// The DB password is checked apart from the list above because it accepts two
// names: HUB_DB_SECRET (preferred) and the deprecated HUB_DB_PASS. See
// src/secret-env.js for why the name matters.
let HUB_DB_SECRET;
try {
    HUB_DB_SECRET = resolveSecretEnv('HUB_DB_PASS');
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
if(!HUB_DB_SECRET){
    console.error('Missing required environment variable: HUB_DB_SECRET (deprecated name: HUB_DB_PASS)');
    process.exit(1);
}
for(const { legacy, preferred } of deprecatedSecretEnvNames()){
    console.warn('Deprecated env var name ' + legacy + ': rename it to ' + preferred +
        '. Automatic secret redaction keys on the variable name, and ' + legacy +
        ' is not a name it matches, so anything that reads this env file prints the value in full.');
}

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const XChainHub  = require('./XChainHub');
const jsonRouter = require('express-json-rpc-router');
const http      = require('http');
const WebSocket = require('ws');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const geoip     = require('geoip-lite');   // self-contained country/region DB; we read only country + region
const { HUB_SCHEMA_VERSION } = require('./hub-schema-version');   // stamped on every mirror snapshot so a stale indexer rejects a mismatch
const { buildOraclePricesSnapshotQuery } = require('./oraclePricesSnapshotQuery');   // page (indexer bootstrap) vs latest-per-feed (dashboard) query selection
const { evaluateAuthPosture } = require('./lib/auth_posture.js');   // boot refuses on an undeclared unauthenticated write surface
const { parseCorsOrigin } = require('./lib/corsOrigin.js');
// The per-IP cap answers in JSON-RPC and stands down for the hub's own
// stack, so chain-only price recovery works at shipped defaults.
const { buildRateLimitOptions, parseExemptLocal } = require('./lib/rate_limit_policy.js');
const { resolveMaxBatch, makeRpcBatchGuard } = require('./rpcBatchGuard.js');   // JSON-RPC batch cardinality cap
// #1299: single source of truth for the co-sign/slash deviation band (no re-declared 0.05 literal).
// #2653: oracle round-interval/submission-window defaults shared with OracleRound.js and XChainHub.js.
const { ORACLE_DEVIATION_THRESHOLD, DEFAULT_ORACLE_ROUND_INTERVAL_MS,
        DEFAULT_ORACLE_SUBMISSION_WINDOW_MS } = require('./constants');

const HUB_PORT = process.env.HUB_PORT;
const HUB_HOST = process.env.HUB_HOST || '0.0.0.0';
const HUB_DB_KEEPALIVE_INTERVAL = parseInt(process.env.HUB_DB_KEEPALIVE_INTERVAL) || 30000;

// HUB_API_KEY gates the write/WS-subscribe surface: set, those paths fail closed
// (401) without a valid key. Unset, the hub REFUSES TO BOOT unless keyless
// operation is declared with HUB_ALLOW_UNAUTHENTICATED; see the posture
// block below.
const HUB_API_KEY        = process.env.HUB_API_KEY || '';
// Explicit declaration that this hub runs keyless (private network, fronting
// proxy, single-host regtest). It exists so a blind hard-require of HUB_API_KEY
// does not crash-loop managed deploys the way the same over-tightening did to the
// indexer (771880c) and the encoder (e2bf7c4) pre-launch: xchain-node's
// ConfigService sets this var for a managed deploy that has no key in its host
// env, so keyless stays possible but is always a stated choice, never a default.
const HUB_ALLOW_UNAUTHENTICATED = (process.env.HUB_ALLOW_UNAUTHENTICATED || '').toLowerCase() === 'true';
const HUB_RATE_LIMIT_RPM = parseInt(process.env.HUB_RATE_LIMIT_RPM) || 100;
// Loopback and private-range callers skip the per-IP cap by default. The
// caller this protects is the node's OWN indexer replaying a batch-bearing chain: it
// pushes one pushpricebatch per batch block as fast as it reads blocks, blows 100/min
// in seconds, and without this exemption needs HUB_RATE_LIMIT_RPM=60000 set by hand before
// recovery runs at all. Keyed on req.ip (post-trust-proxy), so a public client arriving through a
// private-IP reverse proxy is still throttled; see src/lib/rate_limit_policy.js.
// Set HUB_RATE_LIMIT_EXEMPT_LOCAL=false to cap every caller including those.
const HUB_RATE_LIMIT_EXEMPT_LOCAL = parseExemptLocal(process.env.HUB_RATE_LIMIT_EXEMPT_LOCAL);
// A comma-separated ALLOWLIST, not a single origin: the hub is called
// cross-origin by several wallet shells at once. parseCorsOrigin is what makes
// that work - handing `cors` the raw string echoes it verbatim to every caller
// and is accepted by no browser. See src/lib/corsOrigin.js.
const CORS_ORIGIN        = parseCorsOrigin(process.env.CORS_ORIGIN);

// Usage telemetry (anonymous install pings from xchain-node operators).
// Enabled by default on the central hub; an operator's local hub can refuse pings
// by setting TELEMETRY_ENABLED=false. Rows older than TELEMETRY_RETENTION_DAYS are pruned daily.
const TELEMETRY_ENABLED        = (process.env.TELEMETRY_ENABLED || 'true').toLowerCase() !== 'false';
const TELEMETRY_RETENTION_DAYS = parseInt(process.env.TELEMETRY_RETENTION_DAYS) || 90;
// Secret salt for the one-way IP hash. The connecting IP is NEVER stored; at ingest we
// derive a coarse country/region and a keyed HMAC, then discard the IP. Without a salt set,
// ip_hash is left null (we never store an unsalted hash, which would be trivially reversible).
const TELEMETRY_IP_SALT        = process.env.TELEMETRY_IP_SALT || '';
// Gate for the per-install detail endpoint (GET /telemetry/operators). Unlike the
// aggregate summary, that endpoint exposes per-server data (ip_hash/region/what-runs-where),
// so it is fail-closed: without this key set, the endpoint returns 401 for everyone.
const TELEMETRY_ADMIN_KEY      = process.env.TELEMETRY_ADMIN_KEY || '';

const coins          = require('./coins');
const SpendGuard     = require('./lib/spend_guard.js');   // per-capability effector-spend pause registry
const { installObservability } = require('./observability');   // default-off /metrics + structured log shim
const { installHubOracleMetrics } = require('./hubMetrics');   // item a98d6746: oracle-round heartbeat gauges
const ALLOWED_CHAINS = new Set(coins.ALLOWED_COINS);

// Per-network { coin -> consensusHash } of the bundled canonical coin files,
// computed once at load. Served on getallconfigs so a consumer can compare the
// hub's consensus config against its OWN bundled hashes (transport-integrity
// check); the consumer still trusts only its own pinned files, never the hub.
const COIN_CONSENSUS_HASHES = {};
for(const net of coins.NETWORKS) COIN_CONSENSUS_HASHES[net] = coins.consensusHashes(net);
const WRITE_METHODS  = new Set([
    'updateconfig', 'registervalidator', 'rotatevalidator', 'deregistervalidator', 'syncvalidators',
    'propose', 'proposeslashpenalty', 'vote', 'requestattestation', 'reportreorg', 'initiateswap',
    'pushchaintip', 'pushpriceround', 'pushpricebatch', 'pushoracleprice', 'pushpricereorg', 'pushxcallreorg',
    'pushdexreorg', 'anchorflush', 'pauseeffectorspend', 'resumeeffectorspend'
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
const REORG_WRITE_METHODS = new Set(['pushpricereorg', 'pushxcallreorg', 'pushdexreorg']);

// The ONLY rpc methods reachable on the public P2P-port feed (PeerManager
// setFeedHandlers). This is the complete set an indexer sends to its hub
// (xchain-indexer src/hub_client.js): what landed on its chain, and the
// retractions when a reorg takes it back. Every one is a WRITE_METHODS or
// REORG_WRITE_METHODS member, so the x-api-key tiers apply to them here exactly as
// on the private port; this set only narrows WHICH methods that port will consider.
// Adding to it widens a public attack surface: a method belongs here only if an
// indexer must call it and it is signature- or content-validated hub-side.
const FEED_RPC_METHODS = new Set([
    'pushchaintip', 'pushpriceround', 'pushpricebatch', 'pushoracleprice',
    'pushpricereorg', 'pushxcallreorg', 'pushdexreorg'
]);
const HUB_REORG_API_KEY   = process.env.HUB_REORG_API_KEY || '';

// Read methods whose RESPONSE is mesh-internal, keyed like writes when
// HUB_API_KEY is set: getallconfigs returns every service's connection
// parameters including DB user/pass, so it must never be publicly readable.
// This is the app-side half of retiring the hub.xchain.io Apache IP-allowlist
// lockdown (2026-06-26): once every mesh caller sends x-api-key, the vhost can
// proxy POST publicly and this tier carries the policy. Escape hatch for a
// staged rollout or emergency rollback: HUB_SENSITIVE_READ_AUTH=0 disables
// enforcement for these methods only (writes stay keyed).
// getrollcallstatus is here for a different reason than getallconfigs: it carries
// no credential, but it reports how many validators have answered a given ROLLCALL
// epoch, and an epoch's signer count is a PRE-EVICTION TARGETING surface. A caller
// polling every hub can tell which keys are close to the K-epoch absence streak
// before the chain evicts them, which is a map of who to knock over. The ledger
// facts themselves (last_rolled_epoch, absent_streak) are deliberately NOT served
// here at all; they live on the BTC indexer, where they are authoritative.
const SENSITIVE_READ_METHODS = new Set(['getallconfigs', 'getrollcallstatus']);
const SENSITIVE_READ_AUTH = process.env.HUB_SENSITIVE_READ_AUTH !== '0';

function validateChain(chain) {
    if (!ALLOWED_CHAINS.has(chain))
        return { error: 'chain must be one of: BTC, LTC, DOGE' };
    return null;
}

// Strict, because parseInt admits anything with an integer PREFIX: '50junk' passed as
// 50, '1e3' as 1 and '50.5' as 50, and several of the ~16 call sites forward the
// ORIGINAL value into a `LIMIT ?` bind rather than the parsed one. The queries stayed
// bounded and parameterized, but the public limit contract differed per caller. One
// helper guards every call site, so tightening it here repairs all of them.
function validateLimit(limit) {
    if (limit !== undefined && limit !== null) {
        let err = { error: 'limit must be a positive integer no greater than 10000' };
        let n;
        if (typeof limit === 'number')                                 n = limit;
        else if (typeof limit === 'string' && /^[0-9]+$/.test(limit))  n = Number(limit);
        else                                                           return err;
        if (!Number.isInteger(n) || n <= 0 || n > 10000)
            return err;
    }
    return null;
}

// Same digit-only shape validateLimit enforces, for the other external integer
// fields. Returns the exact integer, or null when the value is not a bare integer:
// callers still own the sign/range check, since the legal band differs per field.
function strictInt(value) {
    let n;
    if (typeof value === 'number')                                 n = value;
    else if (typeof value === 'string' && /^[0-9]+$/.test(value))  n = Number(value);
    else                                                           return null;
    return Number.isInteger(n) ? n : null;
}

function validateSince(since) {
    if (since !== undefined && since !== null && since !== '') {
        // Empty string stays "unset" here (unlike limit), so the guard sits inside
        // the presence check rather than replacing it.
        let n = strictInt(since);
        if (n === null || n < 0)
            return { error: 'since_id must be a non-negative integer' };
    }
    return null;
}

// Parse optional P2P config (P2P is enabled when P2P_VALIDATOR_ADDR is set)
const P2P_VALIDATOR_ADDR = process.env.P2P_VALIDATOR_ADDR || '';

// Write-method auth posture. Keyless, every write method is callable by
// anyone who can reach the port, on a validator AND on a config-oracle hub. The
// decision itself lives in lib/auth_posture.js so it is unit-testable; here we
// only log it and refuse the boot. Keyless operation is still available, but it
// must be DECLARED (HUB_ALLOW_UNAUTHENTICATED=true) rather than being what you
// get by forgetting a variable.
const bootPosture = evaluateAuthPosture({
    apiKey:               HUB_API_KEY,
    allowUnauthenticated: HUB_ALLOW_UNAUTHENTICATED,
    validatorMode:        !!P2P_VALIDATOR_ADDR,
    sensitiveReadAuth:    SENSITIVE_READ_AUTH
});
for(const line of bootPosture.warnings) console.warn(line);
if(bootPosture.refuse){
    console.error(bootPosture.fatal);
    process.exit(1);
}

if (P2P_VALIDATOR_ADDR && !process.env.ORACLE_EPOCH_START) {
    console.error('Missing required environment variable: ORACLE_EPOCH_START (Unix ms timestamp anchoring oracle round numbering; all hubs must share the same value)');
    process.exit(1);
}
// HUB_NETWORK names the deployment network (mainnet|testnet|regtest) for the hub's
// consensus gates, notably STAKE_WEIGHTED_QUORUM, whose activation height is per
// network. Consensus-critical, so it is REQUIRED in validator mode and validated
// (no silent default: a wrong/blank value would mis-gate the quorum rule). Must
// match the INDEXER_NETWORK of the chains this hub federates.
const HUB_NETWORK = (process.env.HUB_NETWORK || '').toLowerCase();
if (P2P_VALIDATOR_ADDR && !['mainnet', 'testnet', 'regtest'].includes(HUB_NETWORK)) {
    console.error('Missing/invalid required environment variable: HUB_NETWORK (must be one of mainnet|testnet|regtest; names the deployment network for consensus activation gating; must match the indexers this hub federates)');
    process.exit(1);
}
const p2pConfig = P2P_VALIDATOR_ADDR ? {
    HUB_NETWORK:            HUB_NETWORK,
    P2P_PORT:               parseInt(process.env.P2P_PORT) || 10001,
    P2P_HOST:               process.env.P2P_HOST || '0.0.0.0',
    SEED_NODES:             (process.env.SEED_NODES || '').split(',').map(s => s.trim()).filter(s => s),
    P2P_VALIDATOR_ADDR:     P2P_VALIDATOR_ADDR,
    SIGNING_PRIVKEY_HEX:    resolveSecretEnv('SIGNING_PRIVKEY_HEX') || '',
    REQUIRE_SIGNATURES:     (process.env.REQUIRE_SIGNATURES || 'true').toLowerCase() !== 'false',
    P2P_HEARTBEAT_INTERVAL:    parseInt(process.env.P2P_HEARTBEAT_INTERVAL) || 15000,
    P2P_DEDUP_PRUNE_INTERVAL:  parseInt(process.env.P2P_DEDUP_PRUNE_INTERVAL) || 30000,
    P2P_WS_PING_INTERVAL:      parseInt(process.env.P2P_WS_PING_INTERVAL) || 30000,
    // Transport signer-set refresh poll (Option A auth follows on-chain validator
    // key rotation). Read at XChainHub.js:155; without it wired here the env knob
    // never reached p2pConfig and the interval was permanently pinned to 30000.
    P2P_SIGNER_SET_REFRESH_MS: parseInt(process.env.P2P_SIGNER_SET_REFRESH_MS) || 30000,
    P2P_RECONNECT_BASE:        parseInt(process.env.P2P_RECONNECT_BASE) || 2000,
    P2P_RECONNECT_MAX:      parseInt(process.env.P2P_RECONNECT_MAX) || 60000,
    // Per-IP inbound cap (anti-DoS, PeerManager). The default of 3 is too low
    // for co-located federations (N validators on one IP need N-1 inbound
    // slots each); without this line the env knob never reaches PeerManager.
    P2P_MAX_CONNECTIONS_PER_IP: parseInt(process.env.P2P_MAX_CONNECTIONS_PER_IP) || 3,
    P2P_MSG_DEDUP_TTL:      parseInt(process.env.P2P_MSG_DEDUP_TTL) || 60000,
    P2P_MAX_PAYLOAD:        parseInt(process.env.P2P_MAX_PAYLOAD) || 1048576,
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
    XCHAIN_PRICE_INDEXER_DB_HOST: process.env.XCHAIN_PRICE_INDEXER_DB_HOST || '',
    XCHAIN_PRICE_INDEXER_DB_PORT: process.env.XCHAIN_PRICE_INDEXER_DB_PORT || '',
    XCHAIN_PRICE_INDEXER_DB_NAME: process.env.XCHAIN_PRICE_INDEXER_DB_NAME || '',
    XCHAIN_PRICE_INDEXER_DB_USER: process.env.XCHAIN_PRICE_INDEXER_DB_USER || '',
    XCHAIN_PRICE_INDEXER_DB_PASS: resolveSecretEnv('XCHAIN_PRICE_INDEXER_DB_PASS') || '',
    XCHAIN_PRICE_INDEXER_DB_COIN: process.env.XCHAIN_PRICE_INDEXER_DB_COIN || 'BTC',
    XCHAIN_PRICE_WINDOW_BLOCKS:       process.env.XCHAIN_PRICE_WINDOW_BLOCKS || '',
    XCHAIN_PRICE_CONFIRMATION_BUFFER: process.env.XCHAIN_PRICE_CONFIRMATION_BUFFER || '',
    XCHAIN_PRICE_BOOTSTRAP_SATS:      process.env.XCHAIN_PRICE_BOOTSTRAP_SATS || '',
    XCHAIN_PRICE_MIN_BTC_VOLUME:      process.env.XCHAIN_PRICE_MIN_BTC_VOLUME || '',

    ORACLE_EPOCH_START:     parseInt(process.env.ORACLE_EPOCH_START),
    ORACLE_ROUND_INTERVAL:  parseInt(process.env.ORACLE_ROUND_INTERVAL) || DEFAULT_ORACLE_ROUND_INTERVAL_MS,
    ORACLE_SUBMISSION_WINDOW: parseInt(process.env.ORACLE_SUBMISSION_WINDOW) || DEFAULT_ORACLE_SUBMISSION_WINDOW_MS,
    // Per-round cap on collected peer submissions (anti-flood, OracleRound.js).
    // Passed through UNPARSED for the same reason as the retention knob below:
    // OracleRound.js owns the parse, the range check and the 200 default, so a
    // `parseInt(...) || 200` here would fork the default into two places and let
    // the api.js copy silently eat any value the consumer treats specially.
    // Same dead-knob class as P2P_SIGNER_SET_REFRESH_MS above: without this line
    // the env var never reached p2pConfig and the cap was pinned to the default.
    ORACLE_MAX_SUBMISSIONS_PER_ROUND: process.env.ORACLE_MAX_SUBMISSIONS_PER_ROUND,
    // Retention window (in rounds) for the diagnostic oracle_submissions table.
    // Passed through UNPARSED on purpose: OracleRound.js:88 does its own parseInt +
    // range validation and owns the 12960-round default, and it honours an explicit
    // 0 as "disable pruning" - which a `parseInt(...) || DEFAULT` here would eat.
    // Same class as P2P_SIGNER_SET_REFRESH_MS above: without this line the env knob
    // never reached p2pConfig and retention was permanently pinned to the default.
    ORACLE_SUBMISSIONS_RETENTION_ROUNDS: process.env.ORACLE_SUBMISSIONS_RETENTION_ROUNDS,
    ORACLE_REWARD_PER_ROUND: process.env.ORACLE_REWARD_PER_ROUND || '10.00000000',
    SLASH_DEVIATION_THRESHOLD: process.env.SLASH_DEVIATION_THRESHOLD || String(ORACLE_DEVIATION_THRESHOLD),
    SLASH_MISSED_ROUNDS_THRESHOLD: process.env.SLASH_MISSED_ROUNDS_THRESHOLD || '30',
    COINGECKO_API_KEY:      process.env.COINGECKO_API_KEY || '',
    COINMARKETCAP_API_KEY:  process.env.COINMARKETCAP_API_KEY || '',
    PRICE_FETCH_TIMEOUT:    parseInt(process.env.PRICE_FETCH_TIMEOUT) || 10000
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

async function startApi(){
    const hub = new XChainHub(
        process.env.HUB_DB_HOST,
        process.env.HUB_DB_PORT,
        process.env.HUB_DB_NAME,
        process.env.HUB_DB_USER,
        HUB_DB_SECRET,
        p2pConfig
    );
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
    await hub.startCapabilities(process.env.HUB_CAPABILITY_CONFIG || null);

    const app = express();

    // The hub sits behind Apache on the same host (Cloudflare proxy is OFF for
    // it), so honour X-Forwarded-For to recover the real client IP, but only
    // from a trusted proxy. `true` would trust ANY client-supplied XFF, letting
    // callers spoof their IP past the per-IP rate limiter (express-rate-limit's
    // ERR_ERL_PERMISSIVE_TRUST_PROXY warning). The default trusts loopback plus
    // private-range peers: a containerized hub sees the host reverse proxy as
    // the docker bridge IP (uniquelocal), a native hub sees it as loopback;
    // both recover the real client IP. Exposed directly to the internet, a
    // forged XFF is ignored (public socket address) and req.ip is the socket
    // address. HUB_TRUST_PROXY overrides for other topologies: `false`, a hop
    // count (e.g. `1`), or an address/CIDR list per the express docs. For
    // telemetry the IP is only used transiently to derive a coarse
    // country/region + keyed hash and is never stored.
    let trustProxy = process.env.HUB_TRUST_PROXY || 'loopback, uniquelocal';
    if (trustProxy === 'true')       trustProxy = true;
    else if (trustProxy === 'false') trustProxy = false;
    else if (/^\d+$/.test(trustProxy)) trustProxy = parseInt(trustProxy);
    app.set('trust proxy', trustProxy);

    app.use(helmet());
    app.use(express.json());
    app.use(cors({ origin: CORS_ORIGIN }));
    // Per-IP cap. The options (JSON-RPC 429 body, loopback/private exemption) live in
    // src/lib/rate_limit_policy.js so they are unit-testable; api.js self-starts on
    // require, so nothing declared inline here could ever be asserted against.
    let rateLimitedLogged = 0;
    app.use(rateLimit(buildRateLimitOptions({
        rpm:         HUB_RATE_LIMIT_RPM,
        windowMs:    60 * 1000,
        exemptLocal: HUB_RATE_LIMIT_EXEMPT_LOCAL,
        // One line per minute at most: a throttled client retries hard by definition, and
        // logging every rejection turns a burst into its own outage.
        onLimited: (facts) => {
            let now = Date.now();
            if(now - rateLimitedLogged < facts.windowMs) return;
            rateLimitedLogged = now;
            console.warn('Hub API rate limit: a caller exceeded ' + facts.limit +
                ' req/' + Math.round(facts.windowMs / 1000) + 's; raise HUB_RATE_LIMIT_RPM if this is legitimate traffic');
        }
    })));
    console.log('Hub API rate limit: ' + HUB_RATE_LIMIT_RPM + ' req/min per IP' +
        (HUB_RATE_LIMIT_EXEMPT_LOCAL
            ? ' (loopback and private-range callers exempt; HUB_RATE_LIMIT_EXEMPT_LOCAL=false to enforce)'
            : ' (enforced for every caller, including loopback and private-range)'));

    // Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set, so a hub deploy
    // gains no new listening surface by accident. See src/observability/README.md.
    let hubVersion = '';
    try { hubVersion = require('../package.json').version; } catch { /* version label is cosmetic */ }
    const observability = installObservability(app, {
        service: 'xchain-hub',
        version: hubVersion,
        network: process.env.HUB_NETWORK || ''
    });

    // Oracle-round heartbeat (item a98d6746). Round freshness was reachable only
    // through getoraclesubmissions and /health, which are the same DB/RPC path,
    // so a regression in that monitoring path hid a wedged round loop from every
    // surface at once. No-ops when metrics are off, and resolves the oracle
    // lazily at scrape time (startOracle runs later; a config-only hub has none).
    installHubOracleMetrics(observability, hub);

    // API key enforcement for write methods and sensitive reads (only when a
    // key is configured; see the HUB_API_KEY and SENSITIVE_READ_METHODS notes
    // above). Everything not in either set is the public read tier, protected
    // only by the per-IP rate limit.
    app.use((req, res, next) => {
        if (!HUB_API_KEY && !HUB_REORG_API_KEY) return next();
        // A JSON-RPC batch arrives as an array of call objects; a single call as
        // one object. express-json-rpc-router dispatches every element of an
        // array body, so the gate must inspect ALL of them: require a key if ANY
        // element invokes a write or sensitive-read method. Reading req.body.method
        // off an array leaves it undefined, which is how a batch previously smuggled
        // gated methods past the check unauthenticated.
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let timingEqual = (provided, expected) => {
            let a = Buffer.from(provided), b = Buffer.from(expected);
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        };
        let provided = req.headers['x-api-key'] || '';
        let unauthorized = () => res.status(401).json({
            jsonrpc: '2.0', id: (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null,
            error: { code: -32001, message: 'Unauthorized' }
        });
        // With HUB_REORG_API_KEY set, the retraction rails answer ONLY to
        // it (a batch mixing reorg and non-reorg gated methods can never satisfy
        // both tiers with the single x-api-key header a request carries; callers
        // do not mix tiers). Unset, they stay in the bulk tier below.
        if (HUB_REORG_API_KEY) {
            let reorgGated = calls.some(call => {
                let method = call && call.method;
                return method && REORG_WRITE_METHODS.has(method.toLowerCase());
            });
            if (reorgGated && !timingEqual(provided, HUB_REORG_API_KEY)) return unauthorized();
        }
        if (HUB_API_KEY) {
            let gated = calls.some(call => {
                let method = call && call.method;
                if (!method) return false;
                let m = method.toLowerCase();
                // Reorg methods moved to their own tier above; the reorg key
                // must not authorize anything else, and the bulk key must no
                // longer authorize retractions.
                if (HUB_REORG_API_KEY && REORG_WRITE_METHODS.has(m)) return false;
                return WRITE_METHODS.has(m) ||
                    (SENSITIVE_READ_AUTH && SENSITIVE_READ_METHODS.has(m));
            });
            if (gated && !timingEqual(provided, HUB_API_KEY)) return unauthorized();
        }
        next();
    });

    // Public-port method allowlist. A request stamped by PeerManager arrived on the
    // PUBLIC P2P port (see setFeedHandlers), where the only callers are indexers
    // mirroring this validator and reporting what landed on their chain. Hold those
    // to FEED_RPC_METHODS: every other method (config and validator administration,
    // governance, slashing, swaps, anchor flush, effector spend, and every read)
    // stays reachable only on the private API port.
    //
    // These are the whole indexer->hub vocabulary (xchain-indexer src/hub_client.js),
    // and they are not a back door: each is a WRITE_METHODS/REORG_WRITE_METHODS
    // member that has just cleared the x-api-key gate above exactly as it would on
    // the private port, and each payload is validated and signature-checked before
    // anything is stored. Refusing them would leave a validator unable to learn that
    // its own published batch landed, which is what stops its publisher pruning and
    // keeps the takeover rail disarmed.
    //
    // Runs AFTER the key gate deliberately: an unauthenticated caller gets the same
    // 401 it would get anywhere, so this port answers "not available" only to a
    // caller already holding the key, and does not become an oracle for which
    // methods a hub implements.
    app.use((req, res, next) => {
        if (!req.xchainFeedOrigin) return next();
        if (req.method === 'GET') return next();     // snapshot reads, already path-scoped
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let allowed = calls.length > 0 && calls.every((call) => {
            let method = call && call.method;
            return typeof method === 'string' && FEED_RPC_METHODS.has(method.toLowerCase());
        });
        if (!allowed) {
            return res.status(404).json({
                jsonrpc: '2.0', id: (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null,
                error: { code: -32601, message: 'Method not available on this port' }
            });
        }
        next();
    });

    const jsonRpcController = {

        async ping(params, {res}) {
            try {
                await Promise.race([
                    hub.db.doQuery('SELECT 1', []),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
                ]);
                return {status: "success", db: true};
            } catch (err) {
                res.status(503);
                return {status: "degraded", db: false};
            }
        },

        // Like ping, but also reports the DB circuit-breaker state. The breaker
        // trips open after repeated connection failures and rejects queries during
        // its cooldown; exposing it lets an operator distinguish a healthy hub from
        // one that is up but stalled waiting on a tripped database connection.
        async health(params, {res}) {
            let dbOk = false;
            try {
                await Promise.race([
                    hub.db.doQuery('SELECT 1', []),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
                ]);
                dbOk = true;
            } catch (err) {
                dbOk = false;
            }
            let dbCircuit = hub.db ? hub.db.circuitState : null;
            let healthy = dbOk && dbCircuit !== 'open';

            // Oracle freshness. DB liveness alone can't reveal an oracle that has
            // stopped finalizing rounds (e.g. a price-feed outage), and a restart
            // wipes the in-memory skip counters; without this a probe hitting
            // /health would see a clean bill of health during a stale-feed window.
            // Surface the age of the most recent finalized round so probes can
            // detect staleness without the heavier diagnostics RPC. Only evaluated
            // on oracle-running (P2P-enabled) hubs; a config-only hub mints no rounds.
            let oracleAgeS     = null;
            let oracleStale    = false;
            let oracleThresholdS = null;
            if (dbOk && p2pConfig) {
                try {
                    let roundIntervalMs = p2pConfig.ORACLE_ROUND_INTERVAL || DEFAULT_ORACLE_ROUND_INTERVAL_MS;
                    // Default to 2x the round interval; an operator can override for
                    // slow-start environments via ORACLE_STALENESS_THRESHOLD_S.
                    oracleThresholdS = parseInt(process.env.ORACLE_STALENESS_THRESHOLD_S)
                        || Math.round((roundIntervalMs * 2) / 1000);
                    let rows = await Promise.race([
                        hub.db.doQuery(
                            "SELECT UNIX_TIMESTAMP() - UNIX_TIMESTAMP(MAX(created_at)) AS age_s " +
                            "FROM price_snapshots WHERE status = 'finalized'", []),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
                    ]);
                    // age_s is null when no round has ever finalized (fresh node);
                    // treat that as not-stale so a slow first round doesn't 503.
                    if (rows && rows.length && rows[0].age_s != null) {
                        oracleAgeS  = Number(rows[0].age_s);
                        oracleStale = oracleAgeS > oracleThresholdS;
                    }
                } catch (err) {
                    // Non-fatal: DB health is still reported if the oracle probe fails
                }
            }
            if (oracleStale) healthy = false;

            // Consensus-input reachability. The snapshot fetches that lock
            // a round's validator set fail CLOSED, so a hub that cannot reach its BTC
            // indexer stops participating in every capability / attestation /
            // config-change round while its process and port stay perfectly healthy.
            // Reporting "healthy" through that is the fail-open-observability bug the
            // 2026-06-24 review flagged, so a sustained failure streak degrades the
            // probe. A config-only hub never fetches consensus input at all (the
            // counters stay zero), so this can only fire where it means something.
            let consensusInput = (hub.capabilitySnapshot && hub.capabilitySnapshot.monitor)
                ? hub.capabilitySnapshot.monitor.snapshot() : null;
            if (consensusInput && consensusInput.alerting) healthy = false;

            let anchorStats = hub.stateAnchorPublisher ? hub.stateAnchorPublisher.getAnchorStats() : null;
            let attestStats = hub.attestationPublisher ? hub.attestationPublisher.getPublisherStats() : null;
            // Attestation relay. The relay drives the v3 request /v4 response
            // legs across chains and until now its only instrument was the process log,
            // so an operator could not see that a finalized v4 was sitting held for want
            // of an origin-chain broadcast rail. The typeof guard is for a hub built
            // before the relay carried getStats(), matching hub_db_stream below.
            let relayStats = (hub.attestationRelay && typeof hub.attestationRelay.getStats === 'function')
                ? hub.attestationRelay.getStats() : null;

            if(!healthy) res.status(503);
            let healthResult = {
                status:    healthy ? "healthy" : "degraded",
                db:        dbOk,
                dbCircuit: dbCircuit,
                oracle_last_finalized_age_s:  oracleAgeS,
                oracle_stale:                 oracleStale,
                oracle_staleness_threshold_s: oracleThresholdS,
                config_fetch: {
                    served: configFetchCounters.served,
                    errors: configFetchCounters.errors
                }
            };
            if (consensusInput) healthResult.consensus_input = consensusInput;
            if (anchorStats) healthResult.anchor = anchorStats;
            if (attestStats) healthResult.attest = attestStats;
            // Telemetry only, never a 503: a relay that is disabled, or holding
            // responses for an unconfigured origin chain, is a configuration fact
            // rather than a sick hub, and 503-ing the config oracle over it would
            // take the federation's config rail down with it.
            if (relayStats) healthResult.attest_relay = relayStats;
            // Hub DB stream heartbeat. Consumers gate their price-sync
            // barriers on this watermark, and until now the cadence was only ever
            // visible from the consumer's own timeout logs. Body-only telemetry,
            // like config_fetch above: a stalled heartbeat is worth alerting on but
            // is not by itself a reason to 503 a hub whose DB and oracle are fine.
            if (hub.hubDbBroadcaster && typeof hub.hubDbBroadcaster.getWatermarkStats === 'function')
                healthResult.hub_db_stream = hub.hubDbBroadcaster.getWatermarkStats();
            return healthResult;
        },

        // Get all service configs, tagged with the last committed PBFT sequence
        // number and the config-table high-water mark. The response is wrapped as
        // { configs, seq, watermark } so consumers can detect a config change that
        // was committed between polls and invalidate their cache. seq is 0 on a
        // fresh node (no commits yet). Consumers that predate this wrapper read the
        // bare map; the wrapper keeps the config tree under `configs` so their
        // coin-key iteration still works once they unwrap.
        //
        // An optional `since_updated_at` param (epoch seconds, echoed from a prior
        // response's `watermark`) turns the call into a delta: only rows changed
        // since that instant are returned, so a quiet poll transfers near-nothing
        // instead of the whole table. Callers that omit it get the full tree, so
        // the change is fully backward-compatible. The watermark is read before
        // the rows, and the cursor second is INCLUSIVE on the next delta
        // (db.getAllConfigs compares `>=`), so a write racing the two reads - or
        // committed after them but stamped in the watermark's second - is
        // re-delivered, never skipped. Consumers must merge idempotently: rows in
        // the cursor second repeat on each poll until a newer write lands (#2265).
        async getallconfigs(params) {
            try {
                let since     = params && params.since_updated_at;
                let seq       = await hub.getLastSeq();
                let watermark = await hub.getConfigWatermark();
                let configs   = await hub.getAllConfigs(since);
                configFetchCounters.served++;
                // coin_consensus_hashes is additive: consumers that predate it ignore
                // the field; new consumers cross-check it against their bundled pins.
                return {configs, seq, watermark, coin_consensus_hashes: COIN_CONSENSUS_HASHES};
            } catch (err) {
                configFetchCounters.errors++;
                return {error: "there was an error trying to get all configs"};
            }
        },

        async updateconfig({config}){
            try {
                await hub.addParametersFromJson(config);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to update a config"};
            }
        },

        // Always 200. {active:false} means this hub runs NO oracle round at all -
        // the documented standalone config-oracle topology (CONFIGURATION.md:
        // P2P_VALIDATOR_ADDR left empty), where startOracle() never mints an
        // OracleRound because there is no peerManager. That is an absent ROLE, not a
        // fault, so it is reported the same structured way getanchorstatus and
        // getoraclepublisherstatus report theirs, and deliberately NOT as an {error}
        // envelope: a health consumer cannot tell an error body apart from a
        // transport failure, so the old shape pinned such a hub at 'degraded' on
        // every poll for its whole life. startOracle() is awaited unguarded in
        // startApi, so a broken oracle subsystem fails the boot rather than
        // reaching here - {active:false} can only mean "no role".
        async getoraclesubmissions(){
            let oracle = hub.getOracle();
            if(!oracle) return {active: false};
            let info = await oracle.getSubmissionsInfo();
            // Publish the authoritative price-age bound alongside the cadence
            // (item #4479). ORACLE_ROUND_INTERVAL is an unbounded deployment
            // knob, so a health consumer deriving freshness from the cadence
            // alone (the dashboard's cadenceThresholds) can call a row 'ok'
            // that getprice already rejects as stale. Reuse _oracleMaxAgeSeconds
            // rather than a literal, so the exposed number can never diverge
            // from what getprice enforces; called without a pair it resolves to
            // the registry default, the correct representative scalar while all
            // registry coins share one bound. Additive: callers that ignore the
            // field are unaffected, and it is null when the registry read fails.
            return {active: true, ...info, oracleMaxPriceAgeSeconds: hub._oracleMaxAgeSeconds()};
        },

        // status is optional and additive: omitted/'finalized' preserves the
        // historical finalized-only contract; 'all' includes skipped/disputed
        // rows for health/monitoring consumers (dashboard oracle-feed parity).
        async getpricesnapshots({limit, status, with_watermark}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if (status !== undefined && status !== 'finalized' && status !== 'all')
                return {error: "status must be 'finalized' or 'all'"};
            try {
                let snapshots = await hub.getPriceSnapshots(limit || 50, status);
                // with_watermark is optional and additive: health consumers (the
                // dashboard's pairHealth) need a server-clock watermark so row age
                // is computed entirely in the hub's clock domain instead of diffing
                // hub block_timestamp against the caller's clock, which folds
                // host/hub skew into the freshness thresholds (same fix the
                // submissions rail already carries via lastSuccessAgeMs, and the
                // REST /hub-db/snapshot sibling via its `watermark`). Omitted =
                // historical bare-array contract, so existing callers are untouched.
                // oracleMaxPriceAgeSeconds rides this rail too (item 5551): the
                // bound the consumer clamps freshness to travelled only on
                // getoraclesubmissions, so it was lost exactly when that rail was
                // down; same _oracleMaxAgeSeconds source as there, never a literal.
                if (with_watermark) {
                    return {
                        watermark: Math.floor(Date.now() / 1000),
                        oracleMaxPriceAgeSeconds: hub._oracleMaxAgeSeconds(),
                        snapshots,
                    };
                }
                return snapshots;
            } catch (err) {
                return {error: "error fetching price snapshots"};
            }
        },

        async getprice({coin_pair}){
            if(!coin_pair) return {error: "coin_pair is required"};
            try {
                // Return an explicit stale/unavailable error rather than an aged-out
                // price (L-5): the hub is advisory, but a consumer cannot tell a stale
                // price from a fresh one, so gate on the same bound the indexer enforces.
                let s = await hub.getPriceStatus(coin_pair);
                if(s.missing) return {error: "no price data for " + coin_pair};
                if(s.stale)   return {error: "oracle price for " + coin_pair + " is stale (age " +
                                             s.ageSeconds + "s exceeds max " + s.maxAgeSeconds + "s)"};
                return s.row;
            } catch (err) {
                return {error: "error fetching price"};
            }
        },

        // Network is optional for back-compat with older indexers; defaults to 'mainnet'.
        async pushchaintip({coin, network, block_height, block_time}){
            if(!coin) return {error: "coin is required"};
            let chainErr = validateChain(coin);
            if (chainErr) return chainErr;
            if(block_height === undefined || block_height === null)
                return {error: "block_height is required"};
            if(block_time === undefined || block_time === null)
                return {error: "block_time is required"};
            // strictInt, not parseInt: '850000junk' and '850000.9' truncated to a
            // plausible 850000 and were written as the tip the staleness gates read.
            let height = strictInt(block_height);
            if (height === null || height < 0)
                return {error: "invalid block_height"};
            let time = strictInt(block_time);
            if (time === null || time < 0)
                return {error: "invalid block_time"};
            try {
                await hub.db.setChainTip(coin, network, height, time);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error pushing chain tip"};
            }
        },

        // Indexer has already verified PBFT signatures locally; hub deduplicates by round_number.
        async pushpriceround({source_chain, round, timestamp, btc_block_height, pairs, sigs, action_index, block_index, push_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(round === undefined || round === null) return {error: "round is required"};
            if(!Array.isArray(pairs)) return {error: "pairs must be an array"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                let result = await hub.priceAggregator.receiveValidatedRound(source_chain, {
                    round:            round,
                    timestamp:        timestamp,
                    btc_block_height: btc_block_height,
                    pairs:            pairs,
                    sigs:         sigs,
                    action_index: action_index,
                    block_index:  block_index,
                    // HUB-RETRACT-4: forward the source rollback generation (was dropped here, so
                    // every row was stamped generation 0 and the reorg fence was inert).
                    push_generation: push_generation
                });
                return result;
            } catch (err) {
                return {error: err.message || "error processing price round"};
            }
        },

        // PRICE batch counterpart to pushpriceround (spec section 5.7): one signed
        // action carries every finalized round in an hourly window as rounds[], keyed
        // by the batch's own first_round/last_round/btc_block_height rather than a
        // single round. block_time is new (not on pushpriceround): the hub's
        // pair-name flag day keys per round on that round's TIMESTAMP, and batching
        // widens the hub/chain clock skew from ~10 min to ~70 min, so the push must
        // carry the landing chain's own clock for that gate to resolve correctly.
        // Indexer has already verified the batch's PBFT signatures locally; the hub
        // re-verifies once via receiveValidatedBatch, then dedupes per round.
        async pushpricebatch({source_chain, first_round, last_round, btc_block_height, rounds, block_time, sigs, action_index, block_index, push_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(first_round === undefined || first_round === null) return {error: "first_round is required"};
            if(last_round === undefined || last_round === null) return {error: "last_round is required"};
            if(!Array.isArray(rounds)) return {error: "rounds must be an array"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                let result = await hub.priceAggregator.receiveValidatedBatch(source_chain, {
                    first_round:      first_round,
                    last_round:       last_round,
                    btc_block_height: btc_block_height,
                    rounds:           rounds,
                    block_time:       block_time,
                    sigs:         sigs,
                    action_index: action_index,
                    block_index:  block_index,
                    // HUB-RETRACT-4 precedent (pushpriceround above): forward the
                    // source rollback generation so the reorg fence is not inert.
                    push_generation: push_generation
                });
                return result;
            } catch (err) {
                return {error: err.message || "error processing price batch"};
            }
        },

        async pushoracleprice({source_chain, source_address, coin, tick, fiat, value, fee, memo, block_time, action_index, push_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(!source_address) return {error: "source_address is required"};
            if(!coin || !tick || !fiat || !value)
                return {error: "coin, tick, fiat, value are required"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                let result = await hub.priceAggregator.receiveOraclePrice(source_chain, {
                    source_address: source_address,
                    coin:           coin,
                    tick:           tick,
                    fiat:           fiat,
                    value:          value,
                    fee:            fee,
                    memo:           memo,
                    block_time:     block_time,
                    action_index:   action_index,
                    // HUB-RETRACT-4: forward the source rollback generation (was dropped here, so
                    // every row was stamped generation 0 and the reorg fence was inert).
                    push_generation: push_generation
                });
                return result;
            } catch (err) {
                return {error: err.message || "error processing oracle price"};
            }
        },

        // Retract price rows after an indexer rolled back PRICE actions in a reorg.
        // The indexer pushes the source chain plus the lowest rolled-back action_index;
        // the hub prunes every price_snapshots / oracle_prices row for that chain whose
        // source action_index is >= that value, then broadcasts the deletions so
        // distributed indexers prune their local copies too.
        // to_action_index (optional) bounds the retraction to a CLOSED range [from, to] for a
        // DEFERRED (queued) retraction, so a row re-published inside the original open-ended range
        // is not wiped (item 5296). Absent => open-ended, the original behavior for live retractions.
        // retraction_generation (optional, item 5308) fences the delete to rows with
        // push_generation <= it; an older indexer omits it and the hub falls back to no-fence.
        async pushpricereorg({source_chain, from_action_index, to_action_index, retraction_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                return await hub.priceAggregator.retractFromActionIndex(source_chain, from_action_index, to_action_index, retraction_generation);
            } catch (err) {
                return {error: err.message || "error retracting prices"};
            }
        },

        // Retract cross_chain_calls relay rows after an indexer rolled back XCALL request
        // actions in a reorg. The indexer pushes its source chain plus the lowest rolled-back
        // action_index; the hub marks the matching relay rows 'retracted' (both phases) and
        // broadcasts deletions so distributed indexers prune their mirrored copies too.
        async pushxcallreorg({source_chain, from_action_index, to_action_index, retraction_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                await hub.crossChainCalls.retractCallsForReorg(source_chain, from_action_index, to_action_index, retraction_generation);
                return {status: "ok", source_chain, from_action_index};
            } catch (err) {
                return {error: err.message || "error retracting cross-chain calls"};
            }
        },

        // Retract cross_chain_matches rows after an indexer rolled back DEX ORDER actions in a
        // reorg. The indexer pushes its source chain plus the lowest rolled-back action_index; the
        // hub marks every match whose retracted leg (a_chain/b_chain) is on that source chain at or
        // above that index 'retracted', restores both legs' remaining capacity, and broadcasts
        // deletions so distributed indexers prune their mirrored cross_chain_matches copies too.
        async pushdexreorg({source_chain, from_action_index, to_action_index, retraction_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.crossChainDex) return {error: "cross-chain dex engine not active"};
            try {
                await hub.crossChainDex.retractMatchesForReorg(source_chain, from_action_index, to_action_index, retraction_generation);
                return {status: "ok", source_chain, from_action_index};
            } catch (err) {
                return {error: err.message || "error retracting cross-chain matches"};
            }
        },

        async registervalidator({signing_pubkey, addr}){
            try {
                await hub.registerValidator(signing_pubkey, addr);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to register a validator"};
            }
        },

        async rotatevalidator({addr, new_signing_pubkey}){
            try {
                await hub.rotateValidator(addr, new_signing_pubkey);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to rotate a validator"};
            }
        },

        async deregistervalidator({signing_pubkey, addr}){
            try {
                await hub.deregisterValidator({signingPubkey: signing_pubkey, addr});
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to deregister a validator"};
            }
        },

        async syncvalidators({validators}){
            try {
                await hub.syncValidators(validators);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error syncing validators"};
            }
        },

        async getvalidators(){
            try {
                return await hub.getValidators();
            } catch (err) {
                return {error: "error fetching validators"};
            }
        },

        async getvalidatorstatus({signing_pubkey}){
            if(!signing_pubkey) return {error: "signing_pubkey is required"};
            try {
                let status = await hub.getValidatorStatus(signing_pubkey);
                return status || {error: "validator not found"};
            } catch (err) {
                return {error: "error fetching validator status"};
            }
        },

        async getattestationstats(){
            if(!hub.attestationRound) return {error: "attestation subsystem not active"};
            return hub.attestationRound.getStats();
        },

        // Get cross-chain call relay backlog depth and lifetime failure counter.
        // pending_relay_count is the number of dispatch rows without a result row
        // (per target chain and total); result_attempt_failures is a process-lifetime
        // count of per-call errors in the relay result poll. Mirrors getattestationstats.
        async getcrosschaincallstats(){
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                return await hub.crossChainCalls.getStats();
            } catch (err) {
                return {error: "error fetching cross-chain call stats"};
            }
        },

        // Surface individual XCALL relay rows (the hub's own cross_chain_calls
        // table), the read companion to getcrosschaincallstats' aggregate counters.
        // getcrosschaincall returns one call's full lifecycle by call_id as
        // {call_id, dispatch, result}; getxcall is a shorter alias (mirrors the
        // explorer's getXcall naming). Read-only, public read tier.
        async getcrosschaincall({call_id}){
            if(!call_id) return {error: "call_id is required"};
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                let call = await hub.getCrossChainCall(call_id);
                return call || {error: "cross-chain call not found"};
            } catch (err) {
                return {error: "error fetching cross-chain call"};
            }
        },

        async getxcall({call_id}){
            if(!call_id) return {error: "call_id is required"};
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                let call = await hub.getCrossChainCall(call_id);
                return call || {error: "cross-chain call not found"};
            } catch (err) {
                return {error: "error fetching cross-chain call"};
            }
        },

        // List XCALL relay rows, newest first, with optional source_chain/target_chain
        // (validated against BTC/LTC/DOGE), status, and phase (dispatch/result) filters.
        async listxcall({source_chain, target_chain, status, phase, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if(source_chain){ let e = validateChain(source_chain); if(e) return e; }
            if(target_chain){ let e = validateChain(target_chain); if(e) return e; }
            if(phase && phase !== 'dispatch' && phase !== 'result')
                return {error: "phase must be 'dispatch' or 'result'"};
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                return await hub.listCrossChainCalls({
                    sourceChain: source_chain, targetChain: target_chain,
                    status, phase, limit
                });
            } catch (err) {
                return {error: "error fetching cross-chain calls"};
            }
        },

        // Get state-checkpoint health: last finalized block per chain and a
        // process-lifetime count of rounds that timed out below quorum.
        // Mirrors getattestationstats / getcrosschaincallstats.
        async getcheckpointstats(){
            if(!hub.stateCheckpoints) return {error: "checkpoint engine not active"};
            try {
                return await hub.stateCheckpoints.getStats();
            } catch (err) {
                return {error: "error fetching checkpoint stats"};
            }
        },

        // Manually trigger an ANCHOR flush (write-auth): publish any pending
        // checkpoint anchors + the pending archive batch now instead of waiting
        // for the interval timer. Election still applies: a hub that isn't the
        // elected publisher for a pending anchor skips it (reflected in the
        // returned summary) rather than publishing out of turn.
        async anchorflush(){
            if(!hub.stateAnchorPublisher) return {error: "anchor publisher not active"};
            try {
                return await hub.stateAnchorPublisher.flush();
            } catch (err) {
                return {error: "anchor flush failed"};
            }
        },

        // ANCHOR publisher status (read, no auth): cumulative anchor counts plus the
        // last-observed DOGE publisher-wallet balance + threshold, for runway
        // monitoring. Always 200 (unlike `health`, which flips to 503 when degraded
        // and would hide the body), so a poller can read the balance independent of
        // overall hub health. Returns {active:false} when no publisher is running.
        async getanchorstatus(){
            if(!hub.stateAnchorPublisher) return { active: false };
            return { active: true, ...hub.stateAnchorPublisher.getAnchorStats() };
        },

        // ROLLCALL publisher status (sensitive read; see SENSITIVE_READ_METHODS).
        // PUBLISHER STATE ONLY, for the newest epoch this hub is tracking: whether we
        // signed it, how many verified signatures we have collected, how many of them
        // we last observed on chain, who leads the election, our own rank, the txids
        // we broadcast, and whether this hub's signer module can publish at all.
        //
        // It reports NO ledger facts. `last_rolled_epoch` and `absent_streak` are the
        // BTC indexer's (getrollcallabsences), where they are authoritative; serving a
        // hub's opinion of them here would give two answers to one question and the
        // wrong one would read as an eviction.
        //
        // Mirrors getanchorstatus: always 200, {active:false} plus a fully-shaped body
        // when no round engine is running, so a poller never has to branch on presence.
        async getrollcallstatus(){
            if(!hub.rollcallRound)
                return { active: false, epoch: null, signed: false, gossiped_count: 0,
                         on_chain_count: null, leader: null, our_rank: -1, txids: [],
                         broadcast_capable: false };
            return { active: true, ...hub.rollcallRound.getStatus() };
        },

        // ORACLE (PRICE v0) publisher status (read, no auth): publish-rail health for
        // the oracle-publish leader rotation - queue depth, lifetime published/abandoned
        // (dead-letter) counts, last-published round + txid, and the last-observed DOGE
        // publisher-wallet balance for runway monitoring. Reports only THIS hub's rail:
        // OraclePublisher implements no takeover, so a peer leader that goes dark moves
        // nothing here and is detected off-hub by the dashboard's publish-coverage rail.
        // Mirrors getanchorstatus: always 200 so a poller can read it independent of
        // overall hub health, {active:false} when no oracle publisher is running.
        async getoraclepublisherstatus(){
            if(!hub.oraclePublisher) return { active: false };
            return { active: true, ...hub.oraclePublisher.getStats() };
        },

        // Effector-spend control surface. Read: every registered SpendGuard
        // (one per on-chain effector: oracle-publish, attest, anchor, full-node) with
        // its pause state, balance floor, and rolling per-window spend ceiling (clamped
        // at the $2000 AML admission ceiling). Read-only, always 200.
        async geteffectorspendstatus(){
            return { effectors: SpendGuard.list() };
        },

        // Per-capability runtime pause (write, auth-gated). Halts a single
        // effector's on-chain spend immediately, INCLUDING its primary/leader path,
        // without a restart. `label` is the guard label (e.g. 'OraclePublisher',
        // 'AttestationPublisher', 'StateAnchorPublisher', 'FullNodeChallengeRound').
        async pauseeffectorspend({label, reason}){
            if(!label) return {error: "label is required"};
            if(!SpendGuard.pauseCapability(label, reason || 'operator pause via RPC'))
                return {error: "no effector registered with label '" + label + "'"};
            return {status: "paused", label};
        },
        async resumeeffectorspend({label}){
            if(!label) return {error: "label is required"};
            if(!SpendGuard.resumeCapability(label))
                return {error: "no effector registered with label '" + label + "'"};
            return {status: "resumed", label};
        },

        async getfeequote({action, chain}){
            if(!action) return {error: "action is required"};
            if(!chain) return {error: "chain is required"};
            let chainErr = validateChain(chain);
            if (chainErr) return chainErr;
            try {
                return await hub.getFeeQuote(action, chain);
            } catch (err) {
                return {error: "error calculating fee quote"};
            }
        },

        // Get per-capability MIN_STAKE thresholds, read live from the
        // CapabilityRegistry (the same hot-reloaded source the hub uses to
        // decide qualification). Read-only; lets clients (e.g. the wallet
        // stake form) show which capabilities a stake amount qualifies for.
        // Capabilities are global governance config, so this is not
        // chain-scoped. `disabled` flags operator-disabled capabilities.
        async getcapabilitythresholds(){
            if(!hub.capabilityRegistry) return {error: "capability registry not active"};
            try {
                let reg = hub.capabilityRegistry;
                let thresholds = reg.getCapabilities().map((cap) => ({
                    capability: cap,
                    min_stake:  reg.getMinStake(cap),
                    disabled:   reg.isDisabledByOperator(cap)
                }));
                return {thresholds};
            } catch (err) {
                return {error: "error fetching capability thresholds"};
            }
        },

        async propose({parameter, current_value, proposed_value, rationale}){
            if(!parameter || !proposed_value)
                return {error: "parameter and proposed_value are required"};
            try {
                return await hub.propose(parameter, current_value || '', proposed_value, rationale);
            } catch (err) {
                return {error: err.message || "error creating proposal"};
            }
        },

        // Create a SLASH_PENALTY governance proposal over a validator's
        // pending slash_proposals evidence. penalty: 'suspend' | 'dismiss'. The
        // evidence hash is computed hub-side; the vote executes the penalty.
        async proposeslashpenalty({validator_pubkey, penalty, rationale}){
            if(!validator_pubkey || !penalty)
                return {error: "validator_pubkey and penalty (suspend/dismiss) are required"};
            try {
                return await hub.proposeSlashPenalty(validator_pubkey, penalty, rationale);
            } catch (err) {
                return {error: err.message || "error creating slash penalty proposal"};
            }
        },

        // List recorded slash proposals (all statuses), optionally filtered by
        // status and/or validator pubkey. Read-only companion to
        // proposeslashpenalty above: that method acts on the evidence, this one
        // publishes that it exists.
        //
        // PUBLIC READ TIER on purpose (not in WRITE_METHODS, not in
        // SENSITIVE_READ_METHODS): the rows carry no credential and no
        // mesh-internal connection state, only who was accused of what and
        // whether governance has ruled. Rows with status 'pending' are
        // UNADJUDICATED accusations, never findings; the status field is on
        // every row so a consumer can say so.
        //
        // The `evidence` blob is NOT served. SlashDetector.getSlashProposals
        // replaces it with evidence_hash before returning, because this POST
        // surface answers any caller: redacting downstream in one consumer
        // would leave the verbatim text readable straight off the hub.
        async getslashproposals({status, validator_pubkey, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if(!hub.slashDetector) return {error: "slash detector not active"};
            try {
                return await hub.slashDetector.getSlashProposals({
                    status, validatorPubkey: validator_pubkey, limit
                });
            } catch (err) {
                // Surface the argument-validation messages (bad status, malformed
                // pubkey) the way proposeslashpenalty does, so a caller can fix its
                // request; the generic fallback covers DB failures.
                return {error: err.message || "error fetching slash proposals"};
            }
        },

        async vote({proposal_id, vote}){
            if(!proposal_id || !vote)
                return {error: "proposal_id and vote (approve/reject) are required"};
            try {
                return await hub.vote(proposal_id, vote);
            } catch (err) {
                return {error: err.message || "error casting vote"};
            }
        },

        async getproposals({status, parameter, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getProposals(status, parameter, limit);
            } catch (err) {
                return {error: "error fetching proposals"};
            }
        },

        // List individual governance votes by proposal and/or voter. Complements
        // getproposal (which bundles one proposal's votes): the explorer's
        // governance pages also need list-by-voter across proposals.
        async getvotes({proposal_id, voter_pubkey, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getVotes({proposalId: proposal_id, voterPubkey: voter_pubkey, limit});
            } catch (err) {
                return {error: "error fetching votes"};
            }
        },

        // List per-validator capability qualification rows, optionally filtered by
        // pubkey and/or capability. Read-only companion to getcapabilitythresholds:
        // thresholds say what a capability requires, this says who currently holds it.
        async getvalidatorcapabilities({signing_pubkey, capability, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if(!hub.capabilityRegistry) return {error: "capability registry not active"};
            try {
                return await hub.getValidatorCapabilities({signingPubkey: signing_pubkey, capability, limit});
            } catch (err) {
                return {error: "error fetching validator capabilities"};
            }
        },

        async getproposal({proposal_id}){
            if(!proposal_id) return {error: "proposal_id is required"};
            try {
                let result = await hub.getProposal(proposal_id);
                return result || {error: "proposal not found"};
            } catch (err) {
                return {error: "error fetching proposal"};
            }
        },

        async requestattestation({source_chain, source_action_index, dest_chain}){
            if(!source_chain || !source_action_index || !dest_chain)
                return {error: "source_chain, source_action_index, and dest_chain are required"};
            let scErr = validateChain(source_chain);
            if (scErr) return scErr;
            let dcErr = validateChain(dest_chain);
            if (dcErr) return dcErr;
            // strictInt, not the engine's parseInt: parseInt takes an integer PREFIX, so
            // '1e3' became 1 and '1000.9' became 1000, and the coerced value is what the
            // attestation id, the stored row and the PROPOSE payload are built from. A
            // caller that named action 1000 got a quorum round opened over action 1
            // instead of an error. Same band initiateswap/getswap enforce for this field;
            // the CrossChainEngine guard stays as the defence-in-depth backstop.
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            try {
                let attestation = await hub.requestAttestation(source_chain, srcIdx, dest_chain);
                return attestation;
            } catch (err) {
                return {error: err.message || "error requesting attestation"};
            }
        },

        async getattestations({status, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                let cc = hub.getCrossChain();
                if(!cc) return {error: "cross-chain engine not active"};
                return await cc.getAttestations(status, limit);
            } catch (err) {
                return {error: "error fetching attestations"};
            }
        },

        async reportreorg({chain, reorg_height, timestamp, old_hash, new_hash}){
            if(!chain || !reorg_height || !timestamp)
                return {error: "chain, reorg_height, and timestamp are required"};
            let chainErr = validateChain(chain);
            if (chainErr) return chainErr;
            let rh = parseInt(reorg_height);
            if (!Number.isInteger(rh) || rh < 0)
                return {error: "reorg_height must be a non-negative integer"};
            // The reporter must supply its observed hash pair at reorg_height; the
            // hub (and every co-signing peer) re-verifies new_hash against its own
            // indexer before any rollback round can start.
            if(!old_hash || !new_hash)
                return {error: "old_hash and new_hash (the block hash observed at reorg_height before and after the reorg) are required"};
            try {
                await hub.reportReorg(chain, rh, parseInt(timestamp), String(old_hash), String(new_hash));
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error reporting reorg"};
            }
        },

        async getreorghistory({limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getReorgHistory(limit);
            } catch (err) {
                return {error: "error fetching reorg history"};
            }
        },

        async initiateswap({source_chain, source_action_index, dest_chain, dest_action_index}){
            if(!source_chain || !source_action_index || !dest_chain)
                return {error: "source_chain, source_action_index, and dest_chain are required"};
            let scErr = validateChain(source_chain);
            if (scErr) return scErr;
            let dcErr = validateChain(dest_chain);
            if (dcErr) return dcErr;
            // The index reaches an INSERT into swap_records unvalidated, so a parseInt
            // prefix ('7junk', '1e3') recorded the swap against a different action than
            // the caller named. Same positive-integer band requestAttestation enforces.
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            let destIdx = null;
            if (dest_action_index) {
                destIdx = strictInt(dest_action_index);
                if (destIdx === null || destIdx <= 0)
                    return {error: "dest_action_index must be a positive integer"};
            }
            try {
                await hub.initiateSwap(source_chain, srcIdx, dest_chain, destIdx);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error initiating swap"};
            }
        },

        async getswap({source_chain, source_action_index}){
            if(!source_chain || !source_action_index)
                return {error: "source_chain and source_action_index are required"};
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            try {
                let swap = await hub.getSwap(source_chain, srcIdx);
                return swap || {error: "swap not found"};
            } catch (err) {
                return {error: "error fetching swap"};
            }
        },

        async getswaps({status, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getSwaps(status, limit);
            } catch (err) {
                return {error: "error fetching swaps"};
            }
        },

        async getattestation({source_chain, source_action_index}){
            if(!source_chain || !source_action_index)
                return {error: "source_chain and source_action_index are required"};
            let scErr = validateChain(source_chain);
            if (scErr) return scErr;
            // source_action_index reaches a BIGINT bind in CrossChainEngine.getAttestation,
            // and MariaDB COERCES a non-integer string on comparison instead of erroring:
            // '1e3' reads as action 1000 and garbage reads as 0, so the caller is answered
            // with a DIFFERENT attestation than it named. Same band getswap enforces.
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            try {
                let cc = hub.getCrossChain();
                if(!cc) return {error: "cross-chain engine not active"};
                let att = await cc.getAttestation(source_chain, srcIdx);
                return att || {error: "attestation not found"};
            } catch (err) {
                return {error: "error fetching attestation"};
            }
        }
    };

    // Hub DB sync channel: REST snapshot endpoints
    // Indexers running in distributed mode bootstrap their local hub DB by fetching these snapshots
    // before subscribing to the WebSocket channel for live updates.
    //
    // Auth (seq 3517): gate every /hub-db/snapshot/* GET behind HUB_API_KEY WHEN
    // IT IS SET, mirroring the JSON-RPC write-method guard above and the WebSocket
    // upgrade guard below. Unset key => unauthenticated (unchanged behavior for a
    // public bootstrap hub / regtest / xchain-node-managed deploys that inject no
    // key); set key => these endpoints fail closed (401) so a production federation
    // can lock its hub-DB mirror to authenticated indexers. The indexer's hub_db_sync
    // bootstrap sends the key as `x-api-key` (matching the write-method header), so
    // we check the same header with the same constant-time compare.
    app.use('/hub-db/snapshot', (req, res, next) => {
        if (!HUB_API_KEY) return next();
        let provided = req.headers['x-api-key'] || '';
        let a = Buffer.from(provided), b = Buffer.from(HUB_API_KEY);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });

    app.get('/hub-db/snapshot/price_snapshots', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT * FROM price_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'price_snapshots', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            console.error('hub snapshot endpoint error:', err);
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    app.get('/hub-db/snapshot/oracle_prices', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            // `latest=1` serves the dashboard's current-per-feed need (MAX(effective_at)
            // per coin/tick/fiat); absent it, the default ascending since_id page-walk
            // (indexer bootstrap) is unchanged. See oraclePricesSnapshotQuery.js.
            let latest = req.query.latest === '1' || req.query.latest === 'true';
            let { sql, params, mode } = buildOraclePricesSnapshotQuery({
                latest,
                since: req.query.since_id ? parseInt(req.query.since_id) : 0,
                limit: req.query.limit ? parseInt(req.query.limit) : undefined,
            });
            let rows = await hub.db.doQuery(sql, params);
            res.json({ table: 'oracle_prices', rows: rows, count: rows.length, mode: mode, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            console.error('hub snapshot endpoint error:', err);
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    app.get('/hub-db/snapshot/cross_chain_matches', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            // Exclude retracted rows: the streaming path DELETEs them on reorg
            // (retractMatchesForReorg marks status='retracted' for the ANCHOR archive and
            // broadcasts a deletion), so a bootstrapping mirror must skip them too or it
            // diverges byte-for-byte from a long-running streamed mirror. status<>'retracted'
            // (not ='finalized') excludes exactly what the stream deletes and keeps every
            // other status the stream retains.
            let rows = await hub.db.doQuery(
                "SELECT * FROM cross_chain_matches WHERE id > ? AND status <> 'retracted' ORDER BY id ASC LIMIT ?",
                [since, limit]
            );
            res.json({ table: 'cross_chain_matches', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            console.error('hub snapshot endpoint error:', err);
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    app.get('/hub-db/snapshot/capability_snapshots', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT * FROM capability_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'capability_snapshots', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            console.error('hub snapshot endpoint error:', err);
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/cross_chain_calls: full snapshot of cross_chain_calls table.
    // Explicit column list: batch_seq/archived_status/anchor_txid are hub-side ANCHOR
    // audit metadata and are NOT mirrored (the indexer mirror schema has no such columns).
    // finalizing_view (signed into the EQUIV canonical) and push_generation (source-chain
    // reorg fence, item 5308) ARE mirror-consumed and MUST be included, or a freshly
    // bootstrapped mirror rebuilds the wrong EQUIV view and mis-fences reorg retractions.
    app.get('/hub-db/snapshot/cross_chain_calls', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            // Exclude retracted rows (see the cross_chain_matches snapshot above): the
            // streaming path DELETEs them on reorg (retractCallsForReorg), so a bootstrapping
            // mirror must skip them to stay byte-identical with streamed mirrors.
            let rows = await hub.db.doQuery(
                'SELECT id, call_id, phase, snapshot_block, network, source_chain, source_action_index, ' +
                'source_contract_index, target_chain, target_contract_index, method, params_json, gas_limit, ' +
                'cross_hops, effective_time, status, finalizing_view, push_generation, result_status, ' +
                "return_payload_b64, validator_signatures, created_at " +
                "FROM cross_chain_calls WHERE id > ? AND status <> 'retracted' ORDER BY id ASC LIMIT ?",
                [since, limit]
            );
            res.json({ table: 'cross_chain_calls', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            console.error('hub snapshot endpoint error:', err);
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/state_checkpoints: full snapshot of state_checkpoints table.
    // Explicit column list: the four SPV root columns (state_root, state_root_version,
    // block_merkle_root, block_merkle_version) are mirror-consumed and MUST be included,
    // or a REST-bootstrapped mirror holds NULL roots while a streamed mirror (WS SELECT *)
    // holds them, and the XCHECKPOINT canonical rebuilt from the bootstrapped row drops
    // the root suffix and fails 2f+1 signature verification post CHECKPOINT_COMMITMENT
    // flag-day. anchor_txid stays excluded: it is hub-side audit metadata and is NOT
    // mirrored (the indexer mirror schema has no such column).
    app.get('/hub-db/snapshot/state_checkpoints', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT id, chain, network, block_index, block_hash, ledger_hash, actions_hash, ' +
                'contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, ' +
                'block_merkle_root, block_merkle_version, validator_signatures, created_at ' +
                'FROM state_checkpoints WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'state_checkpoints', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            console.error('hub snapshot endpoint error:', err);
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/anchor_reward_attestations: full snapshot of the
    // anchor-reward attestation table. Explicit column list (id-parity mirror; the BTC
    // indexer rebuilds the XANCPUB canonical from reward_type/round_reference/snapshot_block/
    // publisher and re-verifies publisher_attestations against its OWN oracle_publish set).
    app.get('/hub-db/snapshot/anchor_reward_attestations', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT id, chain, network, reward_type, round_reference, snapshot_block, ' +
                'publisher, reward_amount, publisher_attestations, doge_anchor_txid, created_at ' +
                'FROM anchor_reward_attestations WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'anchor_reward_attestations', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            console.error('hub snapshot endpoint error:', err);
            res.status(500).json({ error: 'snapshot error' });
        }
    });

    // POST /telemetry: anonymous usage ping receiver for xchain-node operators.
    // The connecting IP is NEVER stored. At ingest we derive a coarse country/region and a
    // keyed one-way hash from it, then discard the IP. The body is never trusted for IP.
    // Fire-and-forget: always returns quickly; a bad body or DB hiccup never errors the client.
    const TELEMETRY_EVENTS = new Set(['install', 'update', 'start', 'heartbeat']);
    const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

    if (TELEMETRY_ENABLED && !TELEMETRY_IP_SALT)
        console.log('Telemetry: TELEMETRY_IP_SALT not set; ip_hash will be null (country/region still recorded)');

    // Normalize, then derive only non-identifying values from the connecting IP. The raw IP
    // is used here and never returned or stored.
    function anonymizeIp(rawIp) {
        let ip = String(rawIp || '').replace(/^::ffff:/, '');   // unwrap IPv4-mapped IPv6
        let geo = null;
        try { geo = geoip.lookup(ip); } catch (e) { geo = null; }
        let country = geo && geo.country ? String(geo.country).slice(0, 2) : null;
        let region  = geo && geo.region  ? String(geo.region).slice(0, 16) : null;
        let ipHash  = TELEMETRY_IP_SALT
            ? crypto.createHmac('sha256', TELEMETRY_IP_SALT).update(ip).digest('hex')
            : null;
        return { country, region, ipHash };
    }

    app.post('/telemetry', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ status: 'disabled' });
        try {
            let b = req.body || {};

            // install_id is the only required field; without it we can't dedupe installs.
            let installId = clampStr(b.install_id, 36);
            if (!installId) return res.status(400).json({ error: 'install_id is required' });

            // Derive country/region/hash from the connection, then the IP is gone.
            let { country, region, ipHash } = anonymizeIp(req.ip || req.socket.remoteAddress);
            let event = TELEMETRY_EVENTS.has(b.event) ? b.event : 'heartbeat';

            // Cap the module list defensively (a real install has well under 100 entries).
            let modules = Array.isArray(b.modules) ? b.modules.slice(0, 100).map(m => ({
                module:  clampStr(m && m.module, 64),
                coin:    clampStr(m && m.coin, 16),
                network: clampStr(m && m.network, 24),
                version: clampStr(m && m.version, 32),
                running: !!(m && m.running)
            })) : [];

            let query = `INSERT INTO telemetry_pings
                         (install_id, country, region, ip_hash, node_version, os_platform, os_release, arch, docker_version, modules, event)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await hub.db.doQuery(query, [
                installId,
                country,
                region,
                ipHash,
                clampStr(b.node_version, 32),
                clampStr(b.os_platform, 32),
                clampStr(b.os_release, 64),
                clampStr(b.arch, 16),
                clampStr(b.docker_version, 32),
                JSON.stringify(modules),
                event
            ]);
            res.json({ status: 'success' });
        } catch (err) {
            // Never surface telemetry failures to the client.
            res.json({ status: 'success' });
        }
    });

    // GET /telemetry/summary: anonymous, aggregate-only census of node operators.
    // Returns DISTRIBUTION COUNTS ONLY (by version / OS / country / arch / running
    // module). Never returns install_id, ip_hash, region, or any per-install row;
    // only group tallies derived from the latest ping per install in the window.
    // Read-only; safe to expose to the operator dashboard.
    app.get('/telemetry/summary', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ enabled: false });
        try {
            // Bounded integer window (sanitised -> safe to inline; not a bound param
            // because MariaDB won't bind inside an INTERVAL literal cleanly).
            let days = req.query.days ? parseInt(req.query.days, 10) : 30;
            if (!Number.isFinite(days) || days < 1) days = 30;
            if (days > 365) days = 365;

            // Latest ping per install within the window. install_id is used only to
            // dedupe + group here; it is dropped before the response.
            let rows = await hub.db.doQuery(
                `SELECT t.install_id, t.country, t.node_version, t.os_platform, t.arch, t.docker_version, t.modules
                   FROM telemetry_pings t
                   JOIN (
                     SELECT install_id, MAX(created_at) AS mx
                       FROM telemetry_pings
                      WHERE created_at > (NOW() - INTERVAL ${days} DAY)
                      GROUP BY install_id
                   ) l ON t.install_id = l.install_id AND t.created_at = l.mx
                  LIMIT 50000`,
                []
            );

            const tally = (arr, key) => {
                const m = new Map();
                for (const v of arr) {
                    const k = (v === null || v === undefined || v === '') ? 'unknown' : String(v);
                    m.set(k, (m.get(k) || 0) + 1);
                }
                return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
            };

            // Running-module distribution: count installs running each module.
            // Chain distribution: count installs running at least one module on each
            // coin/network (e.g. "bitcoin/mainnet"). Shared services (hub/db) carry an
            // empty coin/network and are skipped; they aren't chain-specific.
            // Component-per-chain distribution: count installs running each
            // (module, coin, network) combo, e.g. how many run xchain-indexer on
            // litecoin/testnet. Keyed "coin/network/module" (none contain a slash).
            const moduleCounts = new Map();
            const chainCounts  = new Map();
            const chainModuleCounts = new Map();
            for (const r of rows) {
                let mods = [];
                try { mods = Array.isArray(r.modules) ? r.modules : JSON.parse(r.modules || '[]'); } catch (e) { mods = []; }
                const seenModule = new Set();
                const seenChain  = new Set();
                const seenChainModule = new Set();
                for (const m of mods) {
                    if (!m || !m.running) continue;
                    if (m.module && !seenModule.has(m.module)) {   // count an install once per module
                        seenModule.add(m.module);
                        moduleCounts.set(m.module, (moduleCounts.get(m.module) || 0) + 1);
                    }
                    if (m.coin && m.network) {
                        const chainKey = m.coin + '/' + m.network;
                        if (!seenChain.has(chainKey)) {            // count an install once per coin/network
                            seenChain.add(chainKey);
                            chainCounts.set(chainKey, (chainCounts.get(chainKey) || 0) + 1);
                        }
                        if (m.module) {
                            const cmKey = chainKey + '/' + m.module;
                            if (!seenChainModule.has(cmKey)) {     // count an install once per (chain, module)
                                seenChainModule.add(cmKey);
                                chainModuleCounts.set(cmKey, (chainModuleCounts.get(cmKey) || 0) + 1);
                            }
                        }
                    }
                }
            }

            // Total pings over the window (activity volume, not unique installs).
            let pingRow = await hub.db.doQuery(
                `SELECT COUNT(*) AS c FROM telemetry_pings WHERE created_at > (NOW() - INTERVAL ${days} DAY)`,
                []
            );

            res.json({
                enabled: true,
                window_days: days,
                operators: rows.length,
                pings: pingRow && pingRow[0] ? Number(pingRow[0].c) : null,
                byVersion: tally(rows.map(r => r.node_version), 'node_version'),
                byOs:      tally(rows.map(r => r.os_platform), 'os_platform'),
                byCountry: tally(rows.map(r => r.country), 'country'),
                byArch:    tally(rows.map(r => r.arch), 'arch'),
                byDocker:  tally(rows.map(r => r.docker_version), 'docker_version'),
                modules:   [...moduleCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
                chains:    [...chainCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
                chainModules: [...chainModuleCounts.entries()].map(([key, count]) => {
                    const i = key.indexOf('/'), j = key.indexOf('/', i + 1);
                    return { coin: key.slice(0, i), network: key.slice(i + 1, j), module: key.slice(j + 1), count };
                }).sort((a, b) => a.coin.localeCompare(b.coin) || a.network.localeCompare(b.network) || a.module.localeCompare(b.module)),
            });
        } catch (err) {
            console.error('hub telemetry summary error:', err);
            res.status(500).json({ error: 'telemetry summary error' });
        }
    });

    // GET /telemetry/operators: per-install (per-server) detail. UNLIKE the aggregate
    // summary this returns identifying-ish data (ip_hash, region, exactly what each
    // server runs), so it is fail-closed behind TELEMETRY_ADMIN_KEY (x-api-key header).
    // Intended for the operator's own auth-gated dashboard, never public consumption.
    app.get('/telemetry/operators', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ enabled: false });
        if (!TELEMETRY_ADMIN_KEY) { return res.status(401).json({ error: 'Unauthorized' }); }
        { let a = Buffer.from(req.headers['x-api-key'] || ''), b = Buffer.from(TELEMETRY_ADMIN_KEY);
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(401).json({ error: 'Unauthorized' }); } }
        try {
            let days = req.query.days ? parseInt(req.query.days, 10) : 30;
            if (!Number.isFinite(days) || days < 1) days = 30;
            if (days > 365) days = 365;

            // Latest ping per install in the window: the current state of each server.
            let rows = await hub.db.doQuery(
                `SELECT t.install_id, t.country, t.region, t.ip_hash, t.node_version,
                        t.os_platform, t.os_release, t.arch, t.docker_version, t.modules,
                        t.created_at AS last_seen
                   FROM telemetry_pings t
                   JOIN (
                     SELECT install_id, MAX(created_at) AS mx
                       FROM telemetry_pings
                      WHERE created_at > (NOW() - INTERVAL ${days} DAY)
                      GROUP BY install_id
                   ) l ON t.install_id = l.install_id AND t.created_at = l.mx
                  LIMIT 50000`,
                []
            );

            // first_seen + ping count per install over the window.
            let statRows = await hub.db.doQuery(
                `SELECT install_id, COUNT(*) AS pings, MIN(created_at) AS first_seen
                   FROM telemetry_pings
                  WHERE created_at > (NOW() - INTERVAL ${days} DAY)
                  GROUP BY install_id`,
                []
            );
            const stats = new Map();
            for (const s of statRows) stats.set(s.install_id, s);

            const operators = rows.map(r => {
                let mods = [];
                try { mods = Array.isArray(r.modules) ? r.modules : JSON.parse(r.modules || '[]'); } catch (e) { mods = []; }
                const chains = [...new Set(mods.filter(m => m && m.running && m.coin && m.network).map(m => m.coin + '/' + m.network))].sort();
                const modules = [...new Set(mods.filter(m => m && m.running && m.module).map(m => m.module))].sort();
                const st = stats.get(r.install_id) || {};
                return {
                    install_id:     r.install_id,
                    first_seen:     st.first_seen || null,
                    last_seen:      r.last_seen,
                    pings:          st.pings != null ? Number(st.pings) : null,
                    country:        r.country,
                    region:         r.region,
                    ip_hash:        r.ip_hash,
                    node_version:   r.node_version,
                    os_platform:    r.os_platform,
                    os_release:     r.os_release,
                    arch:           r.arch,
                    docker_version: r.docker_version,
                    chains,
                    modules
                };
            }).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

            res.json({ enabled: true, window_days: days, operators });
        } catch (err) {
            console.error('hub telemetry operators error:', err);
            res.status(500).json({ error: 'telemetry operators error' });
        }
    });

    // Public chain registry for wallet/SDK bootstrap (wallet spec G007 / §9.7).
    // Serves the wallet-authored descriptor snapshot vendored at
    // src/chain-registry.json (synced from the wallet's bundled descriptors by
    // xchain-wallet/bin/sync-chain-registry.mjs; drift-guarded in CI). Public
    // read tier by design: endpoint URLs + UX metadata only, no secrets. When
    // this hub has a signing identity (validator mode) the response also
    // carries an Ed25519 signature so clients can verify before merging:
    //   signature = sign('XCHAIN_CHAIN_REGISTRY_V1|' + generated_at + '|' +
    //                    sha256hex(JSON.stringify(descriptors)))
    let chainRegistryCache = null;
    app.get('/api/v1/chain-registry', (req, res) => {
        try {
            if (!chainRegistryCache) {
                const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'chain-registry.json'), 'utf8'));
                const body = {
                    schema_version: raw.schema_version,
                    generatedAt:    raw.generated_at,
                    descriptors:    raw.descriptors
                };
                try {
                    const identity = hub.getIdentity ? hub.getIdentity() : null;
                    if (identity && identity.getPubkeyHex && identity.sign) {
                        const digest = crypto.createHash('sha256')
                            .update(JSON.stringify(raw.descriptors)).digest('hex');
                        body.signer_pubkey = identity.getPubkeyHex();
                        body.signature = identity.sign(
                            'XCHAIN_CHAIN_REGISTRY_V1|' + raw.generated_at + '|' + digest);
                    }
                } catch (e) { /* standalone hub: served unsigned */ }
                chainRegistryCache = body;
            }
            res.set('Cache-Control', 'public, max-age=300');
            // Public discovery surface consumed cross-origin by browser wallets
            // (web SPA + MV3 extension, which ships no host_permissions). The
            // global CORS_ORIGIN default stays off for everything else.
            res.set('Access-Control-Allow-Origin', '*');
            res.json(chainRegistryCache);
        } catch (err) {
            res.status(500).json({ error: 'chain registry unavailable' });
        }
    });

    // Machine-readable API spec (OpenRPC 1.3.2). Regenerated by docs/openrpc.build.js;
    // test/unit/openrpc-coverage.test.js keeps it in lockstep with jsonRpcController.
    let openrpcSpec = null;
    app.get('/openrpc.json', (req, res) => {
        if (!openrpcSpec)
            openrpcSpec = fs.readFileSync(path.join(__dirname, '../docs/openrpc.json'));
        res.set('Cache-Control', 'public, max-age=3600');
        res.type('application/json').send(openrpcSpec);
    });

    // Bound JSON-RPC batch cardinality (src/rpcBatchGuard.js). The router below runs
    // Promise.all over every element of a batch array while the per-IP rate limiter at
    // the top of this stack charges the whole batch ONE token, so a single ~100 KB body
    // fans out into ~1,400 concurrent handlers on the shared DB pool. Mounted here, in
    // front of the router rather than globally, so it governs the dispatcher that
    // amplifies and cannot reject a REST route's array body; the limiter has already
    // charged its token by this point, so an oversize batch is never free.
    // Default 20, matching encoder/decoder/utxo-tracker. No hub caller batches at all
    // (every connector sends one call object), so the cap breaks no existing client.
    app.use(makeRpcBatchGuard(resolveMaxBatch(process.env.HUB_MAX_RPC_BATCH, 20)));

    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({methods: jsonRpcController}));

    const server = http.createServer(app);

    // Hub DB sync channel: WebSocket server for live row updates
    // Subscribers receive { type: 'row:inserted', table, row } events whenever the hub
    // inserts a new price_snapshots or oracle_prices row.
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        // Authenticate using the same hub API key used for write methods
        // (enforced only when a key is configured; an unconditional fail-closed
        // here 401s every indexer's hub_db_sync subscription on managed deploys,
        // severing the price-sync barrier and the state_checkpoints mirror).
        if (HUB_API_KEY) {
            let authHeader = request.headers['authorization'];
            let _bearer = 'Bearer ' + HUB_API_KEY;
            let _ah = Buffer.from(authHeader || ''), _bh = Buffer.from(_bearer);
            if (!authHeader || _ah.length !== _bh.length || !crypto.timingSafeEqual(_ah, _bh)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        if (!request.url || !request.url.startsWith('/hub-db/subscribe')) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            if (hub.hubDbBroadcaster) {
                hub.hubDbBroadcaster.addSubscriber(ws, request).catch(e =>
                    console.error('HubDbBroadcaster: addSubscriber failed:', e && e.message ? e.message : e));
            } else {
                try { ws.close(1011, 'Hub DB broadcaster not ready'); } catch (e) { /* ignore */ }
            }
        });
    });

    let telemetryCleanupInterval = null;
    if (TELEMETRY_ENABLED) {
        const pruneTelemetry = async () => {
            try {
                let result = await hub.db.doQuery(
                    'DELETE FROM telemetry_pings WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
                    [TELEMETRY_RETENTION_DAYS]
                );
                let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
                if (deleted > 0) console.log('Telemetry retention: pruned ' + deleted + ' rows older than ' + TELEMETRY_RETENTION_DAYS + ' days');
            } catch (e) { /* best-effort; never crash the hub over retention */ }
        };
        // unref so these best-effort retention timers never keep the event loop
        // alive on their own (the listening socket does that in production); this
        // also lets test processes that proxyquire this module exit cleanly.
        setTimeout(pruneTelemetry, 60 * 1000).unref();
        telemetryCleanupInterval = setInterval(pruneTelemetry, 24 * 60 * 60 * 1000);
        telemetryCleanupInterval.unref();
    }

    const pingInterval = setInterval(() => {
        // Also guard subscribers: unit tests wire mock hubs whose broadcaster
        // lacks the set, and an uncaught throw here fails whichever unrelated
        // test file happens to be running when the timer fires.
        if (!hub.hubDbBroadcaster || !hub.hubDbBroadcaster.subscribers) return;
        for (let ws of hub.hubDbBroadcaster.subscribers) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.ping(); } catch (e) { /* ignore */ }
            }
        }
    }, HUB_DB_KEEPALIVE_INTERVAL);
    // Keep-alive ping must not by itself hold the loop open (the listening socket
    // does that in production); prevents proxyquired test instances from hanging.
    pingInterval.unref();

    // Also serve the read-only mirror feed on the PUBLIC P2P port. A validator
    // exposes one public port per network and its JSON-RPC API port is private to
    // the box, so this is the only way an indexer can mirror from the validators
    // themselves rather than from a separate hub standing in for them.
    //
    // The handlers below ARE the ones mounted above: PeerManager delegates a GET
    // under /hub-db/snapshot to this same express app, and a /hub-db/subscribe
    // upgrade back to this server's own upgrade listener (auth, then
    // HubDbBroadcaster). Nothing else on that port reaches either. Fail closed
    // without a key: the snapshot middleware skips its check when HUB_API_KEY is
    // unset, which is tolerable on a loopback-bound API port and is not on a public
    // one, so an unkeyed hub simply keeps the port gossip-only.
    if (hub.peerManager && typeof hub.peerManager.setFeedHandlers === 'function') {
        if (!HUB_API_KEY) {
            console.warn('Hub DB feed NOT served on the P2P port: HUB_API_KEY is unset ' +
                '(fail closed; the port stays gossip-only)');
        } else if (String(process.env.HUB_P2P_FEED_ENABLED || 'true').toLowerCase() === 'false') {
            console.log('Hub DB feed on the P2P port disabled by HUB_P2P_FEED_ENABLED=false');
        } else {
            hub.peerManager.setFeedHandlers(
                app,
                (request, socket, head) => server.emit('upgrade', request, socket, head));
            console.log('Hub DB feed also served on the P2P port ' +
                (hub.p2pConfig && hub.p2pConfig.P2P_PORT ? hub.p2pConfig.P2P_PORT : '') +
                ' (read-only, X-Api-Key required)');
        }
    }

    server.listen(HUB_PORT, HUB_HOST, () => {
        console.log('Hub API listening on ' + HUB_HOST + ':' + HUB_PORT);
        console.log('Hub DB sync WebSocket available at ws://' + HUB_HOST + ':' + HUB_PORT + '/hub-db/subscribe');
    });

    // Graceful shutdown: release every timer, socket, and the DB pool, then exit.
    // Previously this only called server.close(), which leaves the MariaDB pool (and
    // hub timers) keeping the event loop alive, so the process never actually exited.
    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;          // ignore a second signal
        shuttingDown = true;
        console.log('Received ' + signal + '; shutting down hub...');

        // Stop the periodic work owned by this file.
        clearInterval(pingInterval);
        if (telemetryCleanupInterval) clearInterval(telemetryCleanupInterval);

        // Backstop: if any close hangs, exit anyway rather than linger forever.
        const forceTimer = setTimeout(() => {
            console.error('Shutdown timed out after 10s; forcing exit');
            process.exit(1);
        }, 10000);
        forceTimer.unref();

        try {
            // Guarded on its own: a throw here (e.g. a hub built without a live
            // broadcaster) must not skip the HTTP-server close and hub.close() below,
            // or shutdown silently drops the DB-pool drain for every later step.
            try {
                for (let ws of (hub.hubDbBroadcaster && hub.hubDbBroadcaster.subscribers) || []) {
                    try { ws.close(1001, 'shutting down'); } catch (e) { /* ignore */ }
                }
            } catch (e) { /* ignore: subscriber set unavailable */ }
            try { wss.close(); } catch (e) { /* ignore */ }

            // Stop accepting HTTP connections; force-close lingering keep-alives so
            // server.close() resolves promptly (Node >= 18.2).
            await new Promise((resolve) => {
                // server is an http.Server in production, but unit tests proxyquire
                // this module with a mock `http` whose createServer returns a stub
                // that has no close(). Guard so a signal-triggered shutdown drains
                // the DB pool via hub.close() below instead of throwing here.
                if (typeof server.close === 'function') {
                    server.close(resolve);
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                } else {
                    resolve();
                }
            });

            // Release hub-owned resources: P2P, consensus/oracle timers, capability +
            // stake-poll timers, config watcher, and the MariaDB pool.
            await hub.close();
            // Flush any buffered log lines before the process goes away (no-op
            // unless log shipping is enabled).
            await observability.shutdown();
        } catch (e) {
            console.error('Error during shutdown:', e);
        } finally {
            clearTimeout(forceTimer);
            process.exit(0);
        }
    }

    // A SHUTDOWN record is what lets a reader tell an operator-driven restart
    // from a crash: without it both look like a service that stopped emitting.
    process.on('SIGTERM', () => { noteShutdown('SIGTERM'); shutdown('SIGTERM'); });
    process.on('SIGINT',  () => { noteShutdown('SIGINT');  shutdown('SIGINT'); });
}

startApi();
