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

const HUB_PORT  = process.env.HUB_PORT;
const HUB_HOST  = process.env.HUB_HOST || '0.0.0.0';

async function startApi(){
    // Start the hub
    const hub = new XChainHub(
        process.env.HUB_DB_HOST,
        process.env.HUB_DB_PORT,
        process.env.HUB_DB_NAME,
        process.env.HUB_DB_USER,
        process.env.HUB_DB_PASS
    );
    await hub.start();

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
                return {error: "there was an error trying to update a config"};
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
