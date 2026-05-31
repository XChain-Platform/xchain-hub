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
 * XChain Hub - Database Class
 *
 * This file handles connecting to MariaDB and running SQL queries.
 * Adapted from xchain-sync/src/db.js — connection pool,
 * circuit breaker, and hub-specific config storage methods.
 *
 ********************************************************************/

const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');

const DB_NAME_REGEX = /^[A-Za-z0-9_]+$/;

class Database {

    constructor(host, port, dbName, user, pass) {
        if(!DB_NAME_REGEX.test(dbName))
            throw new Error('Invalid database name: ' + dbName);

        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;

        // Connection pool parameters
        this.connectionPoolParams = {
            host:               this.host,
            user:               this.user,
            password:           this.pass,
            database:           this.dbName,
            port:               this.port,
            connectionLimit:    10,
            connectTimeout:     10000,
            acquireTimeout:     10000,
            idleTimeout:        60000,
            insertIdAsNumber:   true,
            bigIntAsNumber:     true,
            minDelayValidation: 3000,
            queryTimeout:       parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
        };

        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;

        // Circuit breaker state
        this.circuitState     = 'closed';
        this.circuitFailures  = 0;
        this.circuitThreshold = 10;
        this.circuitCooldown  = 30000;
        this.circuitOpenUntil = 0;
    }

    // Sleep for a given number of milliseconds
    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Throw immediately on errors that retrying will never fix (bad credentials,
    // missing privilege). Transient errors (DB still booting, connection refused)
    // are NOT fatal — callers keep waiting on those. Without this, a misconfigured
    // DB user (e.g. one lacking CREATE DATABASE) makes startup hang forever on a
    // 5s retry loop instead of surfacing the real problem.
    _failFastIfFatal(e, action){
        const FATAL = new Set([
            'ER_ACCESS_DENIED_ERROR',          // wrong user/password
            'ER_DBACCESS_DENIED_ERROR',        // user has no rights on this database
            'ER_SPECIFIC_ACCESS_DENIED_ERROR', // user lacks a required privilege (e.g. CREATE)
            'ER_PASSWORD_NO_MATCH'
        ]);
        if(e && FATAL.has(e.code)){
            throw new Error(
                'Fatal DB error while ' + action + ' (' + e.code + '): the configured DB user (' +
                this.user + '@' + this.host + ':' + this.port + ') lacks the required privilege. ' +
                'Check HUB_DB_USER/HUB_DB_PASS and that the user has CREATE DATABASE (for first-run) ' +
                'or pre-create the hub database and grant ALL on it. ' +
                'Retrying will not fix a credentials/privilege error.'
            );
        }
    }

    // Verify a database exists
    async verifyDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        while(true){
            try {
                let db      = await mariadb.createConnection(connectionParams);
                let results = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?", [this.dbName]);
                await db.end();
                return results.length > 0;
            } catch (e){
                this._failFastIfFatal(e, 'checking database existence');
                console.log('Database connection error:', e.code || 'unknown');
                console.log("Error checking if " + this.dbName + " exists. Trying again in 5 seconds...");
                await this._sleep(5000);
            }
        }
    }

    // Create a database if it doesn't exist
    async createDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        console.log("Creating " + this.dbName + " database...");
        while(true){
            try {
                let db = await mariadb.createConnection(connectionParams);
                await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                return true;
            } catch(e){
                this._failFastIfFatal(e, 'creating the database');
                console.log("Database creation error:", e.code || 'unknown');
                console.log("Error creating " + this.dbName + ". Trying again in 5 seconds...");
                await this._sleep(5000);
            }
        }
    }

    // Verify all tables exist (reads SQL files from src/sql/)
    async verifyTables(){
        let dir   = path.join(__dirname, 'sql');
        let files = fs.readdirSync(dir);
        let db    = await this.getConnection();
        for(let file of files){
            if(file.indexOf('.sql') !== -1){
                let table = file.substring(0, file.indexOf('.sql'));
                console.log('Verifying ' + table + ' table exists...');
                try {
                    let results = await db.query("SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ?", [this.dbName, table]);
                    if(results.length === 0)
                        await this._createTableFromFile(file);
                } catch(e){
                    console.error('Error verifying ' + table + ' table: ' + e);
                    throw e;
                }
            }
        }
        await db.release();
        return true;
    }

    // Apply schema migrations against existing tables (idempotent — safe to run every startup)
    async runMigrations(){
        await this._migrateUniqueKey(
            'oracle_submissions',
            'uq_submission',
            '(round_number, coin_pair, validator_pubkey)',
            ['round_number', 'coin_pair', 'validator_pubkey']
        );
        await this._migrateUniqueKey(
            'validator_rewards',
            'uq_reward',
            '(validator_pubkey, round_number, reward_type)',
            ['validator_pubkey', 'round_number', 'reward_type']
        );
    }

    // Add a UNIQUE KEY to a table, removing duplicate rows first
    async _migrateUniqueKey(table, indexName, indexColumns, columnList){
        let db = await this.getConnection();
        try {
            // Check if the unique key already exists — skip everything if so
            let existing = await db.query(
                "SELECT COUNT(*) AS c FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            if(existing[0] && Number(existing[0].c) > 0) return;

            // Delete duplicates, keeping the row with the smallest id per group
            let joinClause = columnList.map(c => 't1.' + c + ' = t2.' + c).join(' AND ');
            let deleteSql = 'DELETE t1 FROM ' + table + ' t1 ' +
                            'INNER JOIN ' + table + ' t2 ' +
                            'WHERE t1.id > t2.id AND ' + joinClause;
            let result = await db.query(deleteSql);
            let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
            if(deleted > 0)
                console.log('Migration: removed ' + deleted + ' duplicate rows from ' + table);

            // Add the unique key
            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
            console.log('Migration: added UNIQUE KEY ' + indexName + ' on ' + table);
        } catch(e){
            console.error('Migration error on ' + table + ':', e);
        } finally {
            await db.release();
        }
    }

    // Create a table from a local SQL file
    async _createTableFromFile(file){
        let dir     = path.join(__dirname, 'sql');
        let data    = fs.readFileSync(dir + '/' + file, "utf8");
        let table   = file.substring(0, file.indexOf('.sql'));
        let queries = data.split(';');
        console.log('Creating ' + table + ' table...');
        for(let query of queries){
            query = query.trim();
            if(query === '') continue;
            await this.doQuery(query);
        }
    }

    // Get a connection from the pool with circuit breaker and exponential backoff
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;

        // Circuit breaker: reject immediately if open
        if(this.circuitState === 'open'){
            if(Date.now() < this.circuitOpenUntil)
                throw new Error('Circuit breaker open — database connections rejected until cooldown expires');
            this.circuitState = 'half-open';
            console.log('Circuit breaker half-open — attempting reconnection');
        }

        let connection  = null;
        let attempts    = 0;
        let maxAttempts = 30;
        let baseDelay   = 500;
        let maxDelay    = 15000;

        while(connection == null){
            try {
                connection = await this.pool.getConnection();
                if(this.circuitState === 'half-open'){
                    this.circuitState = 'closed';
                    this.circuitFailures = 0;
                    console.log('Circuit breaker closed — database connection restored');
                }
                this.circuitFailures = 0;
            } catch (e){
                attempts++;
                this.circuitFailures = (this.circuitFailures || 0) + 1;
                if(this.circuitFailures >= this.circuitThreshold){
                    this.circuitState = 'open';
                    this.circuitOpenUntil = Date.now() + this.circuitCooldown;
                    throw new Error('Circuit breaker opened after ' + this.circuitFailures + ' consecutive failures');
                }
                if(attempts >= maxAttempts)
                    throw new Error('Could not connect to MariaDB after ' + maxAttempts + ' attempts');
                let delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
                let jitter = Math.floor(Math.random() * delay * 0.3);
                console.log("Can't connect to MariaDB. Retrying in " + (delay + jitter) + 'ms... (' + attempts + '/' + maxAttempts + ')');
                connection = null;
                await this._sleep(delay + jitter);
            }
        }
        return connection;
    }

    // Run a SQL query with parameterized arguments
    async doQuery(query, args){
        let results = [];
        if(query){
            if(Array.isArray(args)){
                for(let i = 0; i < args.length; i++){
                    if(args[i] !== null && args[i] !== undefined && typeof args[i] === 'object') {
                        console.warn('db.doQuery: object arg serialized to JSON at index ' + i);
                        args[i] = JSON.stringify(args[i]);
                    }
                }
            }
            let tx = this.transactionConnection != null;
            let db = await this.getConnection();
            try {
                results = await db.query(query, args);
            } catch (error){
                console.error('Error running database query:', error);
                if(tx) throw error;
            }
            if(!tx) await db.release();
        }
        return results;
    }

    // Set a single config parameter (upsert)
    async setParam(coin, network, module, paramName, paramValue){
        let query = `INSERT INTO configs (coin, network, module, param_name, param_value)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE param_value = ?, updated_at = NOW()`;
        await this.doQuery(query, [coin, network, module, paramName, paramValue, paramValue]);
    }

    // Batched upsert. rows: [{coin, network, module, paramName, paramValue}, ...]
    // Single round-trip — keeps xchain-node's precheck push (3 coins × 3 networks
    // × ~6 modules × ~7 params ≈ 378 rows) under one second instead of one
    // INSERT per row.
    async setParams(rows){
        if(!rows || rows.length === 0) return 0;
        let placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
        let query = `INSERT INTO configs (coin, network, module, param_name, param_value)
                     VALUES ${placeholders}
                     ON DUPLICATE KEY UPDATE param_value = VALUES(param_value), updated_at = NOW()`;
        let args = [];
        for(let r of rows){
            args.push(r.coin, r.network, r.module, r.paramName, r.paramValue);
        }
        await this.doQuery(query, args);
        return rows.length;
    }

    // Get config for a specific coin/network/module
    async getConfig(coin, network, module){
        let query = "SELECT param_name, param_value FROM configs WHERE coin = ? AND network = ? AND module = ?";
        let rows  = await this.doQuery(query, [coin, network, module]);
        let config = {};
        for(let row of rows){
            config[row.param_name] = row.param_value;
        }
        return config;
    }

    // Set the latest chain tip for a given coin + network (block height + time)
    // Used by indexers to push their chain tip to the hub for cross-chain reference.
    // Network defaults to 'mainnet' for back-compat with older indexers that
    // don't pass it (single-network hubs continue to work unchanged).
    async setChainTip(coin, network, blockHeight, blockTime){
        let net = network || 'mainnet';
        await this.setParam(coin, net, 'chain_tips', 'block_height', String(blockHeight));
        await this.setParam(coin, net, 'chain_tips', 'block_time',   String(blockTime));
    }

    // Get the latest chain tip for a given coin + network.
    // Network defaults to 'mainnet' for back-compat (single-network hubs work
    // unchanged). Multi-network hubs must pass the network explicitly.
    // Returns: { blockHeight, blockTime } or null if not set.
    async getChainTip(coin, network){
        let net = network || 'mainnet';
        let cfg = await this.getConfig(coin, net, 'chain_tips');
        if(!cfg.block_height) return null;
        return {
            blockHeight: parseInt(cfg.block_height),
            blockTime:   parseInt(cfg.block_time) || 0
        };
    }

    // Get all configs, reconstructed as nested object
    // Returns: { coin: { network: { module: { param: value } } } }
    async getAllConfigs(){
        let query = "SELECT coin, network, module, param_name, param_value FROM configs ORDER BY coin, network, module, param_name";
        let rows  = await this.doQuery(query);
        let configs = {};
        for(let row of rows){
            let coin    = row.coin;
            let network = row.network;
            let module  = row.module;
            if(!configs[coin]) configs[coin] = {};
            if(!configs[coin][network]) configs[coin][network] = {};
            if(!configs[coin][network][module]) configs[coin][network][module] = {};
            configs[coin][network][module][row.param_name] = row.param_value;
        }
        return configs;
    }

    // Get the last committed consensus sequence number. The PBFT engine persists
    // this to consensus_state on every applied config change; exposing it lets
    // config consumers detect that a change was committed between polls and
    // invalidate their cached config. Returns 0 on a fresh node (no row yet) or
    // if the value is unparseable, so callers can treat 0 as "no commits seen".
    async getLastSeq(){
        let rows = await this.doQuery(
            "SELECT value FROM consensus_state WHERE key_name = ?",
            ['last_seq']
        );
        if(!rows || rows.length === 0) return 0;
        let seq = parseInt(rows[0].value, 10);
        return Number.isNaN(seq) ? 0 : seq;
    }

    // Close the connection pool
    async close(){
        await this.pool.end();
    }
}

module.exports = Database;
