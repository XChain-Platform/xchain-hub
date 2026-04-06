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
const XChainHub  = require('./XChainHub');
const jsonRouter = require('express-json-rpc-router');

const HUB_PORT = process.env.HUB_PORT;
const HUB_HOST = process.env.HUB_HOST || '0.0.0.0';

// Parse optional P2P config (P2P is enabled when P2P_VALIDATOR_ADDR is set)
const P2P_VALIDATOR_ADDR = process.env.P2P_VALIDATOR_ADDR || '';
const p2pConfig = P2P_VALIDATOR_ADDR ? {
    P2P_PORT:               parseInt(process.env.P2P_PORT) || 10001,
    P2P_HOST:               process.env.P2P_HOST || '0.0.0.0',
    SEED_NODES:             (process.env.SEED_NODES || '').split(',').map(s => s.trim()).filter(s => s),
    P2P_VALIDATOR_ADDR:     P2P_VALIDATOR_ADDR,
    SIGNING_PRIVKEY_HEX:    process.env.SIGNING_PRIVKEY_HEX || '',
    REQUIRE_SIGNATURES:     (process.env.REQUIRE_SIGNATURES || '').toLowerCase() === 'true',
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

    // Create the app
    const app = express();

    // Security and parsing middleware
    app.use(helmet());
    app.use(express.json());
    app.use(cors());

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
            try {
                return await hub.getFeeQuote(action, chain);
            } catch (err) {
                return {error: "error calculating fee quote"};
            }
        },

        // Request a cross-chain attestation
        async requestattestation({source_chain, source_action_index, dest_chain}){
            if(!source_chain || !source_action_index || !dest_chain)
                return {error: "source_chain, source_action_index, and dest_chain are required"};
            try {
                let attestation = await hub.requestAttestation(source_chain, source_action_index, dest_chain);
                return attestation;
            } catch (err) {
                return {error: err.message || "error requesting attestation"};
            }
        },

        // Get cross-chain attestations
        async getattestations({status, limit}){
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
            try {
                await hub.reportReorg(chain, parseInt(reorg_height), parseInt(timestamp));
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error reporting reorg"};
            }
        },

        // Get reorg history
        async getreorghistory({limit}){
            try {
                return await hub.getReorgHistory(limit);
            } catch (err) {
                return {error: "error fetching reorg history"};
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
