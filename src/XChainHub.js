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
 * XChain Hub - Hub Class
 *
 * This file handles starting the hub and managing service configs.
 * Orchestrates the database, P2P gossip, and PBFT consensus layers.
 *
 ********************************************************************/

const Database    = require('./db.js');
const PeerManager = require('./PeerManager.js');
const Consensus   = require('./Consensus.js');
const PARAMETER_LIST = ["host", "port", "service_port", "db_host", "db_port", "name", "user", "pass"];

class XChainHub {
    constructor(dbHost, dbPort, dbName, dbUser, dbPass, p2pConfig) {
        this.dbHost    = dbHost;
        this.dbPort    = dbPort;
        this.dbName    = dbName;
        this.dbUser    = dbUser;
        this.dbPass    = dbPass;
        this.p2pConfig = p2pConfig || null;
        this.db          = null;
        this.peerManager = null;
        this.consensus   = null;
    }

    async start(){
        this.db = new Database(this.dbHost, this.dbPort, this.dbName, this.dbUser, this.dbPass);
        await this.db.createDatabase();
        await this.db.verifyTables();
        console.log('XChain Hub started (MariaDB: ' + this.dbName + ')');
    }

    // Start the P2P gossip layer (no-op if p2pConfig is null)
    async startP2P(){
        if(!this.p2pConfig) return;
        this.peerManager = new PeerManager(this.p2pConfig, this.db);
        await this.peerManager.start();
    }

    // Start the PBFT consensus engine (no-op if P2P is not active)
    async startConsensus(){
        if(!this.peerManager) return;
        this.consensus = new Consensus(this);
        await this.consensus.start();
    }

    // Get the PeerManager instance (for higher layers)
    getPeerManager(){
        return this.peerManager;
    }

    // Get the Consensus instance (for higher layers)
    getConsensus(){
        return this.consensus;
    }

    // Update config — routes through consensus if active, otherwise writes directly
    async addParametersFromJson(json){
        if(this.consensus){
            // Route through PBFT consensus
            await this.consensus.propose(json);
            return true;
        }
        // Direct write (no consensus — single-instance mode)
        await this.applyConfig(json);
        return true;
    }

    // Apply config directly to the database (called by Consensus after quorum, or directly in single-instance mode)
    async applyConfig(json){
        for(let nextCoin in json){
            if(nextCoin != ""){
                for(let nextNetwork in json[nextCoin]){
                    for(let nextModule in json[nextCoin][nextNetwork]){
                        for(let nextParam of PARAMETER_LIST){
                            let nextValue = json[nextCoin][nextNetwork][nextModule][nextParam];
                            if(nextValue !== null && nextValue !== undefined){
                                await this.db.setParam(nextCoin, nextNetwork, nextModule, nextParam, nextValue);
                            }
                        }
                    }
                }
            }
        }
    }

    async getAllConfigs(){
        return await this.db.getAllConfigs();
    }

    async close(){
        if(this.consensus)   await this.consensus.stop();
        if(this.peerManager) await this.peerManager.stop();
        if(this.db)          await this.db.close();
    }
}

module.exports = XChainHub;
