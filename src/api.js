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

const HUB_PORT = process.env.HUB_PORT;
const HUB_HOST = process.env.HUB_HOST || '0.0.0.0';

// Security constants
const HUB_API_KEY        = process.env.HUB_API_KEY || '';
const HUB_API_RATE_LIMIT = parseInt(process.env.HUB_API_RATE_LIMIT) || 100;
const CORS_ORIGIN        = process.env.CORS_ORIGIN || false;

const ALLOWED_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);
const WRITE_METHODS  = new Set([
    'updateconfig', 'registervalidator', 'syncvalidators',
    'propose', 'vote', 'requestattestation', 'reportreorg', 'initiateswap'
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

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}));

    // Start the server
    app.listen(HUB_PORT, HUB_HOST, () => {
        console.log('Hub API listening on ' + HUB_HOST + ':' + HUB_PORT);
    });
}

startApi();
