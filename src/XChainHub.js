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
 * Orchestrates the database, P2P gossip, PBFT consensus, and
 * validator identity layers.
 *
 ********************************************************************/

const Database          = require('./db.js');
const PeerManager       = require('./PeerManager.js');
const Consensus         = require('./Consensus.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const OracleConsensus   = require('./OracleConsensus.js');
const OracleRound       = require('./OracleRound.js');
const PARAMETER_LIST = ["host", "port", "service_port", "db_host", "db_port", "name", "user", "pass"];

class XChainHub {
    constructor(dbHost, dbPort, dbName, dbUser, dbPass, p2pConfig) {
        this.dbHost    = dbHost;
        this.dbPort    = dbPort;
        this.dbName    = dbName;
        this.dbUser    = dbUser;
        this.dbPass    = dbPass;
        this.p2pConfig = p2pConfig || null;
        this.db               = null;
        this.peerManager      = null;
        this.consensus        = null;
        this.identity         = null;
        this.oracle           = null;
        this.oracleConsensus  = null;
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

        // Load validator identity if private key is configured
        if(this.p2pConfig.SIGNING_PRIVKEY_HEX){
            this.identity = new ValidatorIdentity(this.p2pConfig.SIGNING_PRIVKEY_HEX);
            console.log('Validator identity loaded (pubkey: ' + this.identity.getPubkeyHex().substring(0, 16) + '...)');
        }

        this.peerManager = new PeerManager(this.p2pConfig, this.db);

        // Attach identity for signing
        if(this.identity){
            this.peerManager.setIdentity(this.identity);
        }

        // Load validator pubkey registry for verification
        await this._loadValidatorPubkeys();

        await this.peerManager.start();
    }

    // Start the PBFT consensus engine (no-op if P2P is not active)
    async startConsensus(){
        if(!this.peerManager) return;
        this.consensus = new Consensus(this);

        // Load validator set for leader rotation
        let validators = await this._loadValidatorSet();
        this.consensus.setValidatorSet(validators);

        await this.consensus.start();
    }

    // Get the PeerManager instance
    getPeerManager(){
        return this.peerManager;
    }

    // Get the Consensus instance
    getConsensus(){
        return this.consensus;
    }

    // Start the oracle round system (no-op if P2P is not active)
    async startOracle(){
        if(!this.peerManager) return;

        // Create oracle round manager
        this.oracle = new OracleRound(this);

        // Create oracle consensus engine
        this.oracleConsensus = new OracleConsensus(this, this.oracle);
        let validators = await this._loadValidatorSet();
        this.oracleConsensus.setValidatorSet(validators);

        // Wire them together
        this.oracle.setConsensus(this.oracleConsensus);

        // Start both
        await this.oracleConsensus.start();
        await this.oracle.start();
    }

    // Get the ValidatorIdentity instance
    getIdentity(){
        return this.identity;
    }

    // Get the OracleRound instance
    getOracle(){
        return this.oracle;
    }

    // Update config — routes through consensus if active, otherwise writes directly
    async addParametersFromJson(json){
        if(this.consensus){
            await this.consensus.propose(json);
            return true;
        }
        await this.applyConfig(json);
        return true;
    }

    // Apply config directly to the database
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

    // Register a validator (for Phase 2C bootstrap)
    async registerValidator(signingPubkey, addr){
        if(!signingPubkey || !/^[0-9a-fA-F]{64}$/.test(signingPubkey))
            throw new Error('Invalid signing pubkey (must be 64 hex chars)');
        if(!addr)
            throw new Error('Validator addr is required');

        await this.db.doQuery(
            `INSERT INTO validators (signing_pubkey, addr, status)
             VALUES (?, ?, 'active')
             ON DUPLICATE KEY UPDATE addr = ?, status = 'active', updated_at = NOW()`,
            [signingPubkey, addr, addr]
        );

        // Reload pubkey registry and validator set
        await this._loadValidatorPubkeys();
        if(this.consensus){
            let validators = await this._loadValidatorSet();
            this.consensus.setValidatorSet(validators);
        }

        console.log('Validator registered: ' + addr + ' (pubkey: ' + signingPubkey.substring(0, 16) + '...)');
        return true;
    }

    // Load validator pubkeys from DB into PeerManager for signature verification
    async _loadValidatorPubkeys(){
        if(!this.peerManager) return;
        try {
            let rows = await this.db.doQuery(
                "SELECT signing_pubkey, addr FROM validators WHERE status = 'active' ORDER BY signing_pubkey"
            );
            let pubkeyMap = new Map();
            for(let row of rows){
                pubkeyMap.set(row.addr, row.signing_pubkey);
            }
            this.peerManager.setValidatorPubkeys(pubkeyMap);
        } catch(e){
            console.error('Error loading validator pubkeys:', e.message);
        }
    }

    // Load sorted validator set for consensus leader rotation
    async _loadValidatorSet(){
        try {
            let rows = await this.db.doQuery(
                "SELECT signing_pubkey, addr FROM validators WHERE status = 'active' ORDER BY signing_pubkey"
            );
            return rows.map(r => ({ pubkey: r.signing_pubkey, addr: r.addr }));
        } catch(e){
            console.error('Error loading validator set:', e.message);
            return [];
        }
    }

    // Get price snapshots from DB
    async getPriceSnapshots(limit) {
        let query = "SELECT * FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC, coin_pair ASC LIMIT ?";
        return await this.db.doQuery(query, [limit || 50]);
    }

    // Get latest price for a coin pair
    async getPrice(coinPair) {
        let query = "SELECT * FROM price_snapshots WHERE coin_pair = ? AND status = 'finalized' ORDER BY round_number DESC LIMIT 1";
        let rows = await this.db.doQuery(query, [coinPair]);
        return rows.length > 0 ? rows[0] : null;
    }

    async close(){
        if(this.oracle)           await this.oracle.stop();
        if(this.oracleConsensus)  await this.oracleConsensus.stop();
        if(this.consensus)        await this.consensus.stop();
        if(this.peerManager)      await this.peerManager.stop();
        if(this.db)               await this.db.close();
    }
}

module.exports = XChainHub;
