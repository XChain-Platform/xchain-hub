/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - API
 *
 * This file parses in environmental variables and starts up the hub instance
 *
 ********************************************************************/

// Load environment variables
const dotenv = require('dotenv');
dotenv.config();

// Validate required environment variables
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
const geoip     = require('geoip-lite');   // self-contained country/region DB; we read only country + region

const HUB_PORT = process.env.HUB_PORT;
const HUB_HOST = process.env.HUB_HOST || '0.0.0.0';
const HUB_DB_KEEPALIVE_INTERVAL = parseInt(process.env.HUB_DB_KEEPALIVE_INTERVAL) || 30000;

// Security constants
const HUB_API_KEY        = process.env.HUB_API_KEY || '';
const HUB_RATE_LIMIT_RPM = parseInt(process.env.HUB_RATE_LIMIT_RPM) || 100;
const CORS_ORIGIN        = process.env.CORS_ORIGIN || false;

// Usage telemetry (anonymous install pings from xchain-node operators).
// Enabled by default on the central hub; an operator's local hub can refuse pings
// by setting TELEMETRY_ENABLED=false. Rows older than TELEMETRY_RETENTION_DAYS are pruned daily.
const TELEMETRY_ENABLED        = (process.env.TELEMETRY_ENABLED || 'true').toLowerCase() !== 'false';
const TELEMETRY_RETENTION_DAYS = parseInt(process.env.TELEMETRY_RETENTION_DAYS) || 90;
// Secret salt for the one-way IP hash. The connecting IP is NEVER stored — at ingest we
// derive a coarse country/region and a keyed HMAC, then discard the IP. Without a salt set,
// ip_hash is left null (we never store an unsalted hash, which would be trivially reversible).
const TELEMETRY_IP_SALT        = process.env.TELEMETRY_IP_SALT || '';
// Gate for the per-install detail endpoint (GET /telemetry/operators). Unlike the
// aggregate summary, that endpoint exposes per-server data (ip_hash/region/what-runs-where),
// so it is fail-closed: without this key set, the endpoint returns 401 for everyone.
const TELEMETRY_ADMIN_KEY      = process.env.TELEMETRY_ADMIN_KEY || '';

const ALLOWED_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);
const WRITE_METHODS  = new Set([
    'updateconfig', 'registervalidator', 'syncvalidators',
    'propose', 'vote', 'requestattestation', 'reportreorg', 'initiateswap',
    'pushchaintip', 'pushpriceround', 'pushoracleprice', 'pushpricereorg'
]);

function validateChain(chain) {
    if (!ALLOWED_CHAINS.has(chain))
        return { error: 'chain must be one of: BTC, LTC, DOGE' };
    return null;
}

function validateLimit(limit) {
    if (limit !== undefined && limit !== null) {
        let n = parseInt(limit);
        if (!Number.isInteger(n) || n <= 0 || n > 1000)
            return { error: 'limit must be a positive integer no greater than 1000' };
    }
    return null;
}

// Parse optional P2P config (P2P is enabled when P2P_VALIDATOR_ADDR is set)
const P2P_VALIDATOR_ADDR = process.env.P2P_VALIDATOR_ADDR || '';
if (P2P_VALIDATOR_ADDR && !process.env.ORACLE_EPOCH_START) {
    console.error('Missing required environment variable: ORACLE_EPOCH_START (Unix ms timestamp anchoring oracle round numbering; all hubs must share the same value)');
    process.exit(1);
}
const p2pConfig = P2P_VALIDATOR_ADDR ? {
    P2P_PORT:               parseInt(process.env.P2P_PORT) || 10001,
    P2P_HOST:               process.env.P2P_HOST || '0.0.0.0',
    SEED_NODES:             (process.env.SEED_NODES || '').split(',').map(s => s.trim()).filter(s => s),
    P2P_VALIDATOR_ADDR:     P2P_VALIDATOR_ADDR,
    SIGNING_PRIVKEY_HEX:    process.env.SIGNING_PRIVKEY_HEX || '',
    REQUIRE_SIGNATURES:     (process.env.REQUIRE_SIGNATURES || 'true').toLowerCase() !== 'false',
    P2P_HEARTBEAT_INTERVAL:    parseInt(process.env.P2P_HEARTBEAT_INTERVAL) || 15000,
    P2P_DEDUP_PRUNE_INTERVAL:  parseInt(process.env.P2P_DEDUP_PRUNE_INTERVAL) || 30000,
    P2P_WS_PING_INTERVAL:      parseInt(process.env.P2P_WS_PING_INTERVAL) || 30000,
    P2P_RECONNECT_BASE:        parseInt(process.env.P2P_RECONNECT_BASE) || 2000,
    P2P_RECONNECT_MAX:      parseInt(process.env.P2P_RECONNECT_MAX) || 60000,
    P2P_MSG_DEDUP_TTL:      parseInt(process.env.P2P_MSG_DEDUP_TTL) || 60000,
    P2P_MAX_PAYLOAD:        parseInt(process.env.P2P_MAX_PAYLOAD) || 1048576,
    ORACLE_EPOCH_START:     parseInt(process.env.ORACLE_EPOCH_START),
    ORACLE_ROUND_INTERVAL:  parseInt(process.env.ORACLE_ROUND_INTERVAL) || 600000,
    ORACLE_SUBMISSION_WINDOW: parseInt(process.env.ORACLE_SUBMISSION_WINDOW) || 180000,
    ORACLE_REWARD_PER_ROUND: process.env.ORACLE_REWARD_PER_ROUND || '10.00000000',
    SLASH_DEVIATION_THRESHOLD: process.env.SLASH_DEVIATION_THRESHOLD || '0.05',
    SLASH_MISSED_ROUNDS_THRESHOLD: process.env.SLASH_MISSED_ROUNDS_THRESHOLD || '30',
    COINGECKO_API_KEY:      process.env.COINGECKO_API_KEY || '',
    COINMARKETCAP_API_KEY:  process.env.COINMARKETCAP_API_KEY || '',
    PRICE_FETCH_TIMEOUT:    parseInt(process.env.PRICE_FETCH_TIMEOUT) || 10000
} : null;

async function startApi(){
    // Start the hub
    const hub = new XChainHub(
        process.env.HUB_DB_HOST,
        process.env.HUB_DB_PORT,
        process.env.HUB_DB_NAME,
        process.env.HUB_DB_USER,
        process.env.HUB_DB_PASS,
        p2pConfig
    );
    await hub.start();

    // Start P2P layer (no-op if p2pConfig is null)
    await hub.startP2P();

    // Start PBFT consensus (no-op if P2P is not active)
    await hub.startConsensus();

    // Start oracle round system (no-op if P2P is not active)
    await hub.startOracle();

    // Start cross-chain attestation engine (no-op if P2P is not active)
    await hub.startCrossChain();

    // Start reorg handler (no-op if P2P is not active)
    await hub.startReorgHandler();

    // Start governance engine (no-op if P2P is not active)
    await hub.startGovernance();

    // Start the External Attestation Framework subsystems (no-op if P2P is not active).
    // Sits after governance so ProviderRegistry's hot-reload hook can attach.
    await hub.startAttestation();

    // Start the capability registry: runs per-capability self-tests, polls the
    // indexer for this validator's on-chain stake, and maintains qualification.
    // Previously this was never called, leaving self-tests, stake tracking, and
    // qualification dormant. HUB_CAPABILITY_CONFIG points at the JSON config that
    // supplies MIN_STAKE thresholds and the per-capability self-test config blocks.
    await hub.startCapabilities(process.env.HUB_CAPABILITY_CONFIG || null);

    // Create the app
    const app = express();

    // The hub sits behind Apache (and Cloudflare proxy is OFF for it), so honour
    // X-Forwarded-For to recover the real client IP. For telemetry the IP is only
    // used transiently to derive a coarse country/region + keyed hash and is never
    // stored. If a future deployment exposes the hub directly, req.ip falls back to
    // the socket address.
    app.set('trust proxy', true);

    // Security and parsing middleware
    app.use(helmet());
    app.use(express.json());
    app.use(cors({ origin: CORS_ORIGIN }));
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: HUB_RATE_LIMIT_RPM,
        standardHeaders: true,
        legacyHeaders: false
    }));

    // API key enforcement for write methods
    app.use((req, res, next) => {
        if (!HUB_API_KEY) return next();
        let method = req.body && req.body.method;
        if (method && WRITE_METHODS.has(method.toLowerCase())) {
            let provided = req.headers['x-api-key'] || '';
            if (provided !== HUB_API_KEY) {
                return res.status(401).json({
                    jsonrpc: '2.0', id: req.body.id || null,
                    error: { code: -32001, message: 'Unauthorized' }
                });
            }
        }
        next();
    });

    // JSON-RPC methods
    const jsonRpcController = {

        // Health check — probes the DB pool so a broken connection is surfaced here
        async ping(params, {res}) {
            try {
                await Promise.race([
                    hub.db.doQuery('SELECT 1', []),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
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
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
                ]);
                dbOk = true;
            } catch (err) {
                dbOk = false;
            }
            let dbCircuit = hub.db ? hub.db.circuitState : null;
            let healthy = dbOk && dbCircuit !== 'open';

            // Oracle freshness. DB liveness alone can't reveal an oracle that has
            // stopped finalizing rounds (e.g. a price-feed outage), and a restart
            // wipes the in-memory skip counters — so without this a probe hitting
            // /health would see a clean bill of health during a stale-feed window.
            // Surface the age of the most recent finalized round so probes can
            // detect staleness without the heavier diagnostics RPC. Only evaluated
            // on oracle-running (P2P-enabled) hubs; a config-only hub mints no rounds.
            let oracleAgeS     = null;
            let oracleStale    = false;
            let oracleThresholdS = null;
            if (dbOk && p2pConfig) {
                try {
                    let roundIntervalMs = p2pConfig.ORACLE_ROUND_INTERVAL || 600000;
                    // Default to 2x the round interval; an operator can override for
                    // slow-start environments via ORACLE_STALENESS_THRESHOLD_S.
                    oracleThresholdS = parseInt(process.env.ORACLE_STALENESS_THRESHOLD_S)
                        || Math.round((roundIntervalMs * 2) / 1000);
                    let rows = await Promise.race([
                        hub.db.doQuery(
                            "SELECT UNIX_TIMESTAMP() - UNIX_TIMESTAMP(MAX(created_at)) AS age_s " +
                            "FROM price_snapshots WHERE status = 'finalized'", []),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
                    ]);
                    // age_s is null when no round has ever finalized (fresh node) —
                    // treat that as not-stale so a slow first round doesn't 503.
                    if (rows && rows.length && rows[0].age_s != null) {
                        oracleAgeS  = Number(rows[0].age_s);
                        oracleStale = oracleAgeS > oracleThresholdS;
                    }
                } catch (err) {
                    // Non-fatal — DB health is still reported if the oracle probe fails
                }
            }
            if (oracleStale) healthy = false;

            if(!healthy) res.status(503);
            return {
                status:    healthy ? "healthy" : "degraded",
                db:        dbOk,
                dbCircuit: dbCircuit,
                oracle_last_finalized_age_s:  oracleAgeS,
                oracle_stale:                 oracleStale,
                oracle_staleness_threshold_s: oracleThresholdS
            };
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
                let watermark = await hub.getConfigWatermark();
                let configs   = await hub.getAllConfigs(since);
                let seq       = await hub.getLastSeq();
                return {configs, seq, watermark};
            } catch (err) {
                return {error: "there was an error trying to get all configs"};
            }
        },

        // Update service configs
        async updateconfig({config}){
            try {
                await hub.addParametersFromJson(config);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to update a config"};
            }
        },

        // Get oracle submission status (diagnostics)
        async getoraclesubmissions(){
            let oracle = hub.getOracle();
            if(!oracle) return {error: "oracle not active"};
            return await oracle.getSubmissionsInfo();
        },

        // Get recent finalized price snapshots
        async getpricesnapshots({limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                let snapshots = await hub.getPriceSnapshots(limit || 50);
                return snapshots;
            } catch (err) {
                return {error: "error fetching price snapshots"};
            }
        },

        // Get latest finalized price for a coin pair
        async getprice({coin_pair}){
            if(!coin_pair) return {error: "coin_pair is required"};
            try {
                let price = await hub.getPrice(coin_pair);
                return price || {error: "no price data for " + coin_pair};
            } catch (err) {
                return {error: "error fetching price"};
            }
        },

        // Push a chain tip update from an indexer (used to anchor oracle rounds to BTC block height)
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

        // Push a validated PRICE v0 round from an indexer (cross-chain aggregation)
        // Indexer has already verified PBFT signatures locally; hub deduplicates by round_number.
        async pushpriceround({source_chain, round, timestamp, pairs, sigs, action_index, block_index}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(round === undefined || round === null) return {error: "round is required"};
            if(!Array.isArray(pairs)) return {error: "pairs must be an array"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                let result = await hub.priceAggregator.receiveValidatedRound(source_chain, {
                    round:        round,
                    timestamp:    timestamp,
                    pairs:        pairs,
                    sigs:         sigs,
                    action_index: action_index,
                    block_index:  block_index
                });
                return result;
            } catch (err) {
                return {error: err.message || "error processing price round"};
            }
        },

        // Push a validated PRICE v1 user oracle price from an indexer
        async pushoracleprice({source_chain, source_address, coin, tick, fiat, value, fee, memo, block_time, action_index}){
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
                    action_index:   action_index
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
        async pushpricereorg({source_chain, from_action_index}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                return await hub.priceAggregator.retractFromActionIndex(source_chain, from_action_index);
            } catch (err) {
                return {error: err.message || "error retracting prices"};
            }
        },

        // Register a validator (Phase 2C bootstrap)
        async registervalidator({signing_pubkey, addr}){
            try {
                await hub.registerValidator(signing_pubkey, addr);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to register a validator"};
            }
        },

        // Sync validators from external staking data
        async syncvalidators({validators}){
            try {
                await hub.syncValidators(validators);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error syncing validators"};
            }
        },

        // Get active validator list
        async getvalidators(){
            try {
                return await hub.getValidators();
            } catch (err) {
                return {error: "error fetching validators"};
            }
        },

        // Get detailed validator status
        async getvalidatorstatus({signing_pubkey}){
            if(!signing_pubkey) return {error: "signing_pubkey is required"};
            try {
                let status = await hub.getValidatorStatus(signing_pubkey);
                return status || {error: "validator not found"};
            } catch (err) {
                return {error: "error fetching validator status"};
            }
        },

        // Get attestation round throughput counters for this validator
        async getattestationstats(){
            if(!hub.attestationRound) return {error: "attestation subsystem not active"};
            return hub.attestationRound.getStats();
        },

        // Get fee quote (gas → XCHAIN → native coin)
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

        // Submit a governance proposal
        async propose({parameter, current_value, proposed_value, rationale}){
            if(!parameter || !proposed_value)
                return {error: "parameter and proposed_value are required"};
            try {
                return await hub.propose(parameter, current_value || '', proposed_value, rationale);
            } catch (err) {
                return {error: err.message || "error creating proposal"};
            }
        },

        // Cast a governance vote
        async vote({proposal_id, vote}){
            if(!proposal_id || !vote)
                return {error: "proposal_id and vote (approve/reject) are required"};
            try {
                return await hub.vote(proposal_id, vote);
            } catch (err) {
                return {error: err.message || "error casting vote"};
            }
        },

        // Get governance proposals
        async getproposals({status}){
            try {
                return await hub.getProposals(status);
            } catch (err) {
                return {error: "error fetching proposals"};
            }
        },

        // Get a specific proposal with votes
        async getproposal({proposal_id}){
            if(!proposal_id) return {error: "proposal_id is required"};
            try {
                let result = await hub.getProposal(proposal_id);
                return result || {error: "proposal not found"};
            } catch (err) {
                return {error: "error fetching proposal"};
            }
        },

        // Request a cross-chain attestation
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

        // Get cross-chain attestations
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

        // Report a blockchain reorg for cross-chain propagation
        async reportreorg({chain, reorg_height, timestamp}){
            if(!chain || !reorg_height || !timestamp)
                return {error: "chain, reorg_height, and timestamp are required"};
            let chainErr = validateChain(chain);
            if (chainErr) return chainErr;
            let rh = parseInt(reorg_height);
            if (!Number.isInteger(rh) || rh < 0)
                return {error: "reorg_height must be a non-negative integer"};
            try {
                await hub.reportReorg(chain, rh, parseInt(timestamp));
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error reporting reorg"};
            }
        },

        // Get reorg history
        async getreorghistory({limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getReorgHistory(limit);
            } catch (err) {
                return {error: "error fetching reorg history"};
            }
        },

        // Initiate a cross-chain SWAP
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

        // Get a specific swap
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

        // Get swaps by status
        async getswaps({status, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getSwaps(status, limit);
            } catch (err) {
                return {error: "error fetching swaps"};
            }
        },

        // Get a specific attestation
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

    // Hub DB sync channel — REST snapshot endpoints (read-only, public read)
    // Indexers running in distributed mode bootstrap their local hub DB by fetching these snapshots
    // before subscribing to the WebSocket channel for live updates.

    // GET /hub-db/snapshot/price_snapshots — full snapshot of price_snapshots table
    app.get('/hub-db/snapshot/price_snapshots', async (req, res) => {
        try {
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT * FROM price_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'price_snapshots', rows: rows, count: rows.length });
        } catch (err) {
            res.status(500).json({ error: err.message || 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/oracle_prices — full snapshot of oracle_prices table
    app.get('/hub-db/snapshot/oracle_prices', async (req, res) => {
        try {
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT * FROM oracle_prices WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'oracle_prices', rows: rows, count: rows.length });
        } catch (err) {
            res.status(500).json({ error: err.message || 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/cross_chain_matches — full snapshot of cross_chain_matches table
    app.get('/hub-db/snapshot/cross_chain_matches', async (req, res) => {
        try {
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT * FROM cross_chain_matches WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'cross_chain_matches', rows: rows, count: rows.length });
        } catch (err) {
            res.status(500).json({ error: err.message || 'snapshot error' });
        }
    });

    // GET /hub-db/snapshot/capability_snapshots — full snapshot of capability_snapshots table
    app.get('/hub-db/snapshot/capability_snapshots', async (req, res) => {
        try {
            let limit = req.query.limit ? Math.min(parseInt(req.query.limit), 10000) : 10000;
            let since = req.query.since_id ? parseInt(req.query.since_id) : 0;
            let rows = await hub.db.doQuery(
                'SELECT * FROM capability_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?',
                [since, limit]
            );
            res.json({ table: 'capability_snapshots', rows: rows, count: rows.length });
        } catch (err) {
            res.status(500).json({ error: err.message || 'snapshot error' });
        }
    });

    // POST /telemetry — anonymous usage ping receiver for xchain-node operators.
    // The connecting IP is NEVER stored. At ingest we derive a coarse country/region and a
    // keyed one-way hash from it, then discard the IP. The body is never trusted for IP.
    // Fire-and-forget: always returns quickly; a bad body or DB hiccup never errors the client.
    const TELEMETRY_EVENTS = new Set(['install', 'update', 'start', 'heartbeat']);
    const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

    if (TELEMETRY_ENABLED && !TELEMETRY_IP_SALT)
        console.log('Telemetry: TELEMETRY_IP_SALT not set — ip_hash will be null (country/region still recorded)');

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

    // GET /telemetry/summary — anonymous, aggregate-only census of node operators.
    // Returns DISTRIBUTION COUNTS ONLY (by version / OS / country / arch / running
    // module). Never returns install_id, ip_hash, region, or any per-install row —
    // only group tallies derived from the latest ping per install in the window.
    // Read-only; safe to expose to the operator dashboard.
    app.get('/telemetry/summary', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ enabled: false });
        try {
            // Bounded integer window (sanitised → safe to inline; not a bound param
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
            // empty coin/network and are skipped — they aren't chain-specific.
            // Component-per-chain distribution: count installs running each
            // (module, coin, network) combo — e.g. how many run xchain-indexer on
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

    // GET /telemetry/operators — per-install (per-server) detail. UNLIKE the aggregate
    // summary this returns identifying-ish data (ip_hash, region, exactly what each
    // server runs), so it is fail-closed behind TELEMETRY_ADMIN_KEY (x-api-key header).
    // Intended for the operator's own auth-gated dashboard, never public consumption.
    app.get('/telemetry/operators', async (req, res) => {
        if (!TELEMETRY_ENABLED) return res.json({ enabled: false });
        if (!TELEMETRY_ADMIN_KEY || (req.headers['x-api-key'] || '') !== TELEMETRY_ADMIN_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        try {
            let days = req.query.days ? parseInt(req.query.days, 10) : 30;
            if (!Number.isFinite(days) || days < 1) days = 30;
            if (days > 365) days = 365;

            // Latest ping per install in the window — the current state of each server.
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

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}));

    // Start the server using an explicit http.Server so we can attach a WebSocket upgrade handler
    const server = http.createServer(app);

    // Hub DB sync channel — WebSocket server for live row updates
    // Subscribers receive { type: 'row:inserted', table, row } events whenever the hub
    // inserts a new price_snapshots or oracle_prices row.
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        // Authenticate using the same hub API key used for write methods
        if (HUB_API_KEY) {
            let authHeader = request.headers['authorization'];
            if (!authHeader || authHeader !== 'Bearer ' + HUB_API_KEY) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
        }
        // Only accept upgrades to the /hub-db/subscribe path
        if (!request.url || !request.url.startsWith('/hub-db/subscribe')) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            if (hub.hubDbBroadcaster) {
                hub.hubDbBroadcaster.addSubscriber(ws);
            } else {
                try { ws.close(1011, 'Hub DB broadcaster not ready'); } catch (e) { /* ignore */ }
            }
        });
    });

    // Daily telemetry retention sweep — prune pings older than the retention window.
    // Runs once shortly after startup, then every 24h. No-op when telemetry is disabled.
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

    // Periodic ping to detect dead WebSocket connections
    const pingInterval = setInterval(() => {
        if (!hub.hubDbBroadcaster) return;
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

    // Graceful shutdown — release every timer, socket, and the DB pool, then exit.
    // Previously this only called server.close(), which leaves the MariaDB pool (and
    // hub timers) keeping the event loop alive, so the process never actually exited.
    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;          // ignore a second signal
        shuttingDown = true;
        console.log('Received ' + signal + ' — shutting down hub...');

        // Stop the periodic work owned by this file.
        clearInterval(pingInterval);
        if (telemetryCleanupInterval) clearInterval(telemetryCleanupInterval);

        // Backstop: if any close hangs, exit anyway rather than linger forever.
        const forceTimer = setTimeout(() => {
            console.error('Shutdown timed out after 10s — forcing exit');
            process.exit(1);
        }, 10000);
        forceTimer.unref();

        try {
            // Close hub-db WebSocket subscribers + the WS server.
            if (hub.hubDbBroadcaster) {
                for (let ws of hub.hubDbBroadcaster.subscribers) {
                    try { ws.close(1001, 'shutting down'); } catch (e) { /* ignore */ }
                }
            }
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
