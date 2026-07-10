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

const REQUIRED_ENV = ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT'];
for(const key of REQUIRED_ENV){
    if(!process.env[key]){
        console.error('Missing required environment variable: ' + key);
        process.exit(1);
    }
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

const HUB_PORT = process.env.HUB_PORT;
const HUB_HOST = process.env.HUB_HOST || '0.0.0.0';
const HUB_DB_KEEPALIVE_INTERVAL = parseInt(process.env.HUB_DB_KEEPALIVE_INTERVAL) || 30000;

// HUB_API_KEY is optional, matching the other services: unset disables the
// write/WS-subscribe gate (single-host / regtest / managed deploys); when
// configured, those paths fail closed (401) without a valid key. Hard-requiring
// it at boot crash-loops every xchain-node-managed deployment (ConfigService
// injects no such var and HubConnector sends no key; the same over-tightening
// that hit the indexer (771880c) and encoder (e2bf7c4) pre-launch).
const HUB_API_KEY        = process.env.HUB_API_KEY || '';
// Explicit escape hatch for running keyless. A blind hard-require of HUB_API_KEY
// crash-loops xchain-node-managed single-host deploys (no key injected), so we
// only fail closed in validator mode (below) and let the operator opt into
// keyless validator operation with this flag rather than refusing outright.
const HUB_ALLOW_UNAUTHENTICATED = (process.env.HUB_ALLOW_UNAUTHENTICATED || '').toLowerCase() === 'true';
const HUB_RATE_LIMIT_RPM = parseInt(process.env.HUB_RATE_LIMIT_RPM) || 100;
const CORS_ORIGIN        = process.env.CORS_ORIGIN || false;

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
const ALLOWED_CHAINS = new Set(coins.ALLOWED_COINS);

// Per-network { coin -> consensusHash } of the bundled canonical coin files,
// computed once at load. Served on getallconfigs so a consumer can compare the
// hub's consensus config against its OWN bundled hashes (transport-integrity
// check); the consumer still trusts only its own pinned files, never the hub.
const COIN_CONSENSUS_HASHES = {};
for(const net of coins.NETWORKS) COIN_CONSENSUS_HASHES[net] = coins.consensusHashes(net);
const WRITE_METHODS  = new Set([
    'updateconfig', 'registervalidator', 'rotatevalidator', 'deregistervalidator', 'syncvalidators',
    'propose', 'vote', 'requestattestation', 'reportreorg', 'initiateswap',
    'pushchaintip', 'pushpriceround', 'pushoracleprice', 'pushpricereorg', 'pushxcallreorg',
    'pushdexreorg', 'anchorflush'
]);

// Read methods whose RESPONSE is mesh-internal, keyed like writes when
// HUB_API_KEY is set: getallconfigs returns every service's connection
// parameters including DB user/pass, so it must never be publicly readable.
// This is the app-side half of retiring the hub.xchain.io Apache IP-allowlist
// lockdown (2026-06-26): once every mesh caller sends x-api-key, the vhost can
// proxy POST publicly and this tier carries the policy. Escape hatch for a
// staged rollout or emergency rollback: HUB_SENSITIVE_READ_AUTH=0 disables
// enforcement for these methods only (writes stay keyed).
const SENSITIVE_READ_METHODS = new Set(['getallconfigs']);
const SENSITIVE_READ_AUTH = process.env.HUB_SENSITIVE_READ_AUTH !== '0';

function validateChain(chain) {
    if (!ALLOWED_CHAINS.has(chain))
        return { error: 'chain must be one of: BTC, LTC, DOGE' };
    return null;
}

function validateLimit(limit) {
    if (limit !== undefined && limit !== null) {
        let n = parseInt(limit);
        if (!Number.isInteger(n) || n <= 0 || n > 10000)
            return { error: 'limit must be a positive integer no greater than 10000' };
    }
    return null;
}

function validateSince(since) {
    if (since !== undefined && since !== null && since !== '') {
        let n = parseInt(since);
        if (!Number.isFinite(n) || n < 0)
            return { error: 'since_id must be a non-negative integer' };
    }
    return null;
}

// Default oracle round interval (10 min). Declared here (before the p2pConfig
// object literal that references it) so the const is in scope at evaluation time.
// OracleRound.js keeps its own copy with a cross-ref comment; both must stay in sync.
const DEFAULT_ORACLE_ROUND_INTERVAL_MS = 600000;

// Parse optional P2P config (P2P is enabled when P2P_VALIDATOR_ADDR is set)
const P2P_VALIDATOR_ADDR = process.env.P2P_VALIDATOR_ADDR || '';

// Write-method auth posture. A keyless validator is dangerous: it would let any
// caller drive consensus-affecting writes, so in validator mode we fail closed at
// boot unless the operator explicitly opts into keyless operation. Non-validator
// (config-server) hubs keep the historical loud-warn-and-allow behaviour so
// xchain-node-managed single-host deploys (which inject no key) still start.
if(!HUB_API_KEY){
    if(P2P_VALIDATOR_ADDR && !HUB_ALLOW_UNAUTHENTICATED){
        console.error('FATAL: HUB_API_KEY is not set in validator mode. Write methods would be UNAUTHENTICATED, letting anyone drive consensus-affecting writes. Set HUB_API_KEY, or set HUB_ALLOW_UNAUTHENTICATED=true to explicitly run keyless.');
        process.exit(1);
    }
    console.warn('WARNING: HUB_API_KEY is not set. Write methods and WebSocket subscriptions are UNAUTHENTICATED. Set a strong key for any shared or public-facing deployment.');
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
    SIGNING_PRIVKEY_HEX:    process.env.SIGNING_PRIVKEY_HEX || '',
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
    ORACLE_EPOCH_START:     parseInt(process.env.ORACLE_EPOCH_START),
    ORACLE_ROUND_INTERVAL:  parseInt(process.env.ORACLE_ROUND_INTERVAL) || DEFAULT_ORACLE_ROUND_INTERVAL_MS,
    ORACLE_SUBMISSION_WINDOW: parseInt(process.env.ORACLE_SUBMISSION_WINDOW) || 180000,
    ORACLE_REWARD_PER_ROUND: process.env.ORACLE_REWARD_PER_ROUND || '10.00000000',
    SLASH_DEVIATION_THRESHOLD: process.env.SLASH_DEVIATION_THRESHOLD || '0.05',
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
        process.env.HUB_DB_PASS,
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
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: HUB_RATE_LIMIT_RPM,
        standardHeaders: true,
        legacyHeaders: false
    }));

    // API key enforcement for write methods and sensitive reads (only when a
    // key is configured; see the HUB_API_KEY and SENSITIVE_READ_METHODS notes
    // above). Everything not in either set is the public read tier, protected
    // only by the per-IP rate limit.
    app.use((req, res, next) => {
        if (!HUB_API_KEY) return next();
        // A JSON-RPC batch arrives as an array of call objects; a single call as
        // one object. express-json-rpc-router dispatches every element of an
        // array body, so the gate must inspect ALL of them: require a key if ANY
        // element invokes a write or sensitive-read method. Reading req.body.method
        // off an array leaves it undefined, which is how a batch previously smuggled
        // gated methods past the check unauthenticated.
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let gated = calls.some(call => {
            let method = call && call.method;
            return method && (WRITE_METHODS.has(method.toLowerCase()) ||
                (SENSITIVE_READ_AUTH && SENSITIVE_READ_METHODS.has(method.toLowerCase())));
        });
        if (gated) {
            let provided = req.headers['x-api-key'] || '';
            let a = Buffer.from(provided), b = Buffer.from(HUB_API_KEY);
            if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
                return res.status(401).json({
                    jsonrpc: '2.0', id: (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null,
                    error: { code: -32001, message: 'Unauthorized' }
                });
            }
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

            let anchorStats = hub.stateAnchorPublisher ? hub.stateAnchorPublisher.getAnchorStats() : null;
            let attestStats = hub.attestationPublisher ? hub.attestationPublisher.getPublisherStats() : null;

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
            if (anchorStats) healthResult.anchor = anchorStats;
            if (attestStats) healthResult.attest = attestStats;
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
        // the rows so a write racing the two reads is re-delivered, never skipped.
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

        async getoraclesubmissions(){
            let oracle = hub.getOracle();
            if(!oracle) return {error: "oracle not active"};
            return await oracle.getSubmissionsInfo();
        },

        // status is optional and additive: omitted/'finalized' preserves the
        // historical finalized-only contract; 'all' includes skipped/disputed
        // rows for health/monitoring consumers (dashboard oracle-feed parity).
        async getpricesnapshots({limit, status}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if (status !== undefined && status !== 'finalized' && status !== 'all')
                return {error: "status must be 'finalized' or 'all'"};
            try {
                let snapshots = await hub.getPriceSnapshots(limit || 50, status);
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
            try {
                await hub.db.setChainTip(coin, network, parseInt(block_height), parseInt(block_time));
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
            try {
                let attestation = await hub.requestAttestation(source_chain, source_action_index, dest_chain);
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
            try {
                await hub.initiateSwap(source_chain, parseInt(source_action_index), dest_chain, dest_action_index ? parseInt(dest_action_index) : null);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error initiating swap"};
            }
        },

        async getswap({source_chain, source_action_index}){
            if(!source_chain || !source_action_index)
                return {error: "source_chain and source_action_index are required"};
            try {
                let swap = await hub.getSwap(source_chain, parseInt(source_action_index));
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
            try {
                let cc = hub.getCrossChain();
                if(!cc) return {error: "cross-chain engine not active"};
                let att = await cc.getAttestation(source_chain, source_action_index);
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
            res.status(500).json({ error: err.message || 'snapshot error' });
        }
    });

    app.get('/hub-db/snapshot/oracle_prices', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT * FROM oracle_prices WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'oracle_prices', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            res.status(500).json({ error: err.message || 'snapshot error' });
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
            res.status(500).json({ error: err.message || 'snapshot error' });
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
            res.status(500).json({ error: err.message || 'snapshot error' });
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
            res.status(500).json({ error: err.message || 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/state_checkpoints: full snapshot of state_checkpoints table.
    // Explicit column list: anchor_txid is hub-side audit metadata and is NOT mirrored
    // (the indexer mirror schema has no such column).
    app.get('/hub-db/snapshot/state_checkpoints', async (req, res) => {
        try {
            if (req.query.limit) { let limErr = validateLimit(req.query.limit); if (limErr) return res.status(400).json(limErr); }
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            if (req.query.since_id) { let sinceErr = validateSince(req.query.since_id); if (sinceErr) return res.status(400).json(sinceErr); }
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT id, chain, network, block_index, block_hash, ledger_hash, actions_hash, ' +
                'contract_hash, checkpoint_seq, snapshot_block, validator_signatures, created_at ' +
                'FROM state_checkpoints WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'state_checkpoints', rows: rows, count: rows.length, watermark: Math.floor(Date.now() / 1000), schema_version: HUB_SCHEMA_VERSION });
        } catch (err) {
            res.status(500).json({ error: err.message || 'snapshot error' });
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
            res.status(500).json({ error: err.message || 'telemetry summary error' });
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
            res.status(500).json({ error: err.message || 'telemetry operators error' });
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
        setTimeout(pruneTelemetry, 60 * 1000);
        telemetryCleanupInterval = setInterval(pruneTelemetry, 24 * 60 * 60 * 1000);
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
                server.close(resolve);
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            });

            // Release hub-owned resources: P2P, consensus/oracle timers, capability +
            // stake-poll timers, config watcher, and the MariaDB pool.
            await hub.close();
        } catch (e) {
            console.error('Error during shutdown:', e);
        } finally {
            clearTimeout(forceTimer);
            process.exit(0);
        }
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
}

startApi();
