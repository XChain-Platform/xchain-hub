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
    P2P_MAX_PAYLOAD:        parseInt(process.env.P2P_MAX_PAYLOAD) || 1048576
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

        // Register a validator (Phase 2C bootstrap)
        async registervalidator({signing_pubkey, addr}){
            try {
                await hub.registerValidator(signing_pubkey, addr);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "there was an error trying to register a validator"};
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
