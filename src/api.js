/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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

const HUB_PORT = process.env.HUB_PORT;
const HUB_HOST = process.env.HUB_HOST || '0.0.0.0';

// Security constants
const HUB_API_KEY        = process.env.HUB_API_KEY || '';
const HUB_API_RATE_LIMIT = parseInt(process.env.HUB_API_RATE_LIMIT) || 100;
const CORS_ORIGIN        = process.env.CORS_ORIGIN || false;

const ALLOWED_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);
const WRITE_METHODS  = new Set([
    'updateconfig', 'registervalidator', 'syncvalidators',
    'propose', 'vote', 'requestattestation', 'reportreorg', 'initiateswap',
    'pushchaintip', 'pushpriceround', 'pushoracleprice'
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
    P2P_HEARTBEAT_INTERVAL: parseInt(process.env.P2P_HEARTBEAT_INTERVAL) || 15000,
    P2P_RECONNECT_BASE:     parseInt(process.env.P2P_RECONNECT_BASE) || 2000,
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

    // Create the app
    const app = express();

    // Security and parsing middleware
    app.use(helmet());
    app.use(express.json());
    app.use(cors({ origin: CORS_ORIGIN }));
    app.use(rateLimit({
        windowMs: 60 * 1000,
        max: HUB_API_RATE_LIMIT,
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

        // Health check
        async ping() {
            return {status: "success"};
        },

        // Get all service configs
        async getallconfigs() {
            try {
                let configs = await hub.getAllConfigs();
                return configs;
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
            return oracle.getSubmissionsInfo();
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

    // Periodic ping to detect dead WebSocket connections
    const pingInterval = setInterval(() => {
        if (!hub.hubDbBroadcaster) return;
        for (let ws of hub.hubDbBroadcaster.subscribers) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.ping(); } catch (e) { /* ignore */ }
            }
        }
    }, 30000);

    server.listen(HUB_PORT, HUB_HOST, () => {
        console.log('Hub API listening on ' + HUB_HOST + ':' + HUB_PORT);
        console.log('Hub DB sync WebSocket available at ws://' + HUB_HOST + ':' + HUB_PORT + '/hub-db/subscribe');
    });

    // Graceful shutdown
    process.on('SIGTERM', () => { clearInterval(pingInterval); server.close(); });
}

startApi();
