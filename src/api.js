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
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Hub - API
 * 
 * This file parses in environmental variables and starts up the hub instance
 * 
 ********************************************************************/

// Load required libraries
const dotenv = require('dotenv')
dotenv.config()

const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const XChainHub  = require('./XChainHub');
const jsonRouter = require('express-json-rpc-router')

const DB_NAME =  "xchain-hub"
const LISTEN_PORT = 3000

async function startApi(){
    //Start the monitor
    const hub = new XChainHub(DB_NAME);
    await hub.start()

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS for development
    app.use(cors());


    const jsonRpcController = {

        // Function to check if xchain-hub is up
        async ping() {
            return {status:"success"};
        },
        // Function to create transactions hex for a given data and encoding type
        async getallconfigs() {
            try {
                let configs = await hub.getAllConfigs()
                return configs
            } catch (err) {
                return {error:"there was an error trying to get all configs"};
            }
        },
        async updateconfig({config}){
            try {
                await hub.addParametersFromJson(config)
                return {status:"success"}
            } catch (err) {
                return {error:"there was an error trying to update a config"};
            }
        }
    }

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}))


    // Start the server
    app.listen(LISTEN_PORT, () => {
      console.log('API listening on port '+LISTEN_PORT);
    });
}

startApi()