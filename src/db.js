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
                    else
                        // Existing table — reconcile column drift against the SQL
                        // source so columns added upstream are auto-applied on
                        // stacks created from an older release, instead of failing
                        // later queries with "Unknown column".
                        await this.alterTableForDrift(file, db);
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
        // Strip `--` line comments BEFORE splitting on ';' — a comment may contain a
        // ';' (e.g. "regtest; signed into the canonical"), which would otherwise split
        // the CREATE TABLE mid-statement and fail to parse. stripSqlLineComments
        // preserves quoted strings, so real SQL structure is untouched.
        let queries = this.stripSqlLineComments(data).split(';');
        console.log('Creating ' + table + ' table...');
        for(let query of queries){
            query = query.trim();
            if(query === '') continue;
            await this.doQuery(query);
        }
    }

    // Remove SQL `--` line comments while respecting quoted strings, so a ';'
    // or ',' appearing inside comment prose is never mistaken for SQL structure.
    // Single/double-quote and backtick spans are preserved verbatim (doubled
    // quotes treated as escapes); a `--` outside any quote skips to the end of
    // its line. Newlines are kept so the column-split below stays well-formed.
    stripSqlLineComments(sql){
        let out = '';
        let quote = null;
        for(let i = 0; i < sql.length; i++){
            const ch = sql[i];
            if(quote){
                out += ch;
                if(ch === quote){
                    if(sql[i + 1] === quote){ out += sql[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; out += ch; continue; }
            if(ch === '-' && sql[i + 1] === '-'){
                while(i < sql.length && sql[i] !== '\n'){ i++; }
                if(i < sql.length){ out += '\n'; }
                continue;
            }
            out += ch;
        }
        return out;
    }

    // Parse a CREATE TABLE statement to extract expected columns. Conservative —
    // only used for drift detection, not full schema management. Returns array of
    // {name, nullable, definition, notNull, hasDefault} or null when the file has
    // no recognizable CREATE TABLE block.
    parseExpectedColumns(sqlData){
        // Strip `--` line comments BEFORE any structural parsing — inline comments
        // routinely carry commas/parens that would otherwise fool the comma split.
        sqlData = this.stripSqlLineComments(sqlData);
        // Match the column block up to the table's closing paren, tolerating the
        // optional `IF NOT EXISTS` clause and both the `) ENGINE=...;` form and a
        // bare `);` terminator (the hub schema mostly uses the bare form).
        const m = sqlData.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s*\(([\s\S]+?)\)\s*(?:ENGINE\b|;|$)/i);
        if(!m) return null;
        // Split on top-level commas (commas not inside type parens like VARCHAR(20))
        const parts = m[1].split(/,(?![^()]*\))/g);
        const cols = [];
        for(let raw of parts){
            let line = raw.replace(/--[^\n\r]*/g, '').trim();
            if(!line) continue;
            // Skip constraint/index/key lines — column definitions only
            if(/^(PRIMARY|UNIQUE|INDEX|KEY|CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)) continue;
            const tokens = line.split(/\s+/);
            if(tokens.length < 2) continue;
            const name       = tokens[0].replace(/`/g, '');
            // A column is nullable unless it says NOT NULL or is an inline PRIMARY
            // KEY (SQL forces PK columns NOT NULL, so a MODIFY ... NULL on one is a
            // silent no-op that would otherwise re-fire on every startup).
            const nullable   = !/\bNOT\s+NULL\b/i.test(line) && !/\bPRIMARY\s+KEY\b/i.test(line);
            const notNull    = !nullable;
            const hasDefault = /\bDEFAULT\b/i.test(line);
            // Keep the full (comment-stripped) definition so a missing column can
            // be re-added verbatim — preserving its DEFAULT clause, which is what
            // backfills existing rows when the column is NOT NULL.
            cols.push({ name, nullable, definition: line, notNull, hasDefault });
        }
        return cols.length > 0 ? cols : null;
    }

    // Detect schema drift between the live table and its SQL source, and fix it
    // by ALTER. Two kinds of drift are handled:
    //   1. Missing columns — a column declared in the SQL source but absent from
    //      the live table is added with ADD COLUMN, reusing the source definition
    //      verbatim so its DEFAULT clause backfills existing rows. (A NOT NULL
    //      column with no DEFAULT can't be backfilled safely, so it's skipped
    //      with a loud warning rather than aborting startup.)
    //   2. Nullability — only relaxes NOT NULL -> NULL (the safe direction; never
    //      strengthens to NOT NULL since live rows might hold NULLs that would
    //      block the ALTER).
    // Doesn't touch types, defaults of existing columns, or indexes. Each applied
    // ALTER is loudly logged. Reuses the caller's connection (`db`).
    async alterTableForDrift(file, db){
        const dir      = path.join(__dirname, 'sql');
        const data     = fs.readFileSync(dir + '/' + file, "utf8");
        const table    = file.substring(0, file.indexOf('.sql'));
        const expected = this.parseExpectedColumns(data);
        if(!expected) return;
        const live = await db.query(
            "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        const liveByName = new Map(live.map(c => [c.COLUMN_NAME.toLowerCase(), c]));
        for(const exp of expected){
            const cur = liveByName.get(exp.name.toLowerCase());
            if(!cur){
                if(exp.notNull && !exp.hasDefault){
                    console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT — cannot backfill existing rows safely. Skipping; add manually.');
                    continue;
                }
                console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live. Adding column from SQL source.');
                await db.query('ALTER TABLE `' + table + '` ADD COLUMN ' + exp.definition);
                continue;
            }
            const liveIsNullable = cur.IS_NULLABLE === 'YES';
            if(!liveIsNullable && exp.nullable){
                console.log('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL. Relaxing constraint.');
                await db.query('ALTER TABLE `' + table + '` MODIFY `' + exp.name + '` ' + cur.COLUMN_TYPE + ' NULL');
            }
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
    //
    // Optional `sinceUpdatedAt` is an epoch-seconds cursor (see getConfigWatermark).
    // When supplied, only rows changed strictly after that instant are returned,
    // so a consumer that threads the prior watermark back gets a delta — typically
    // empty on a quiet poll — instead of the full table on every refresh. Omitting
    // it (or passing 0) returns the complete config tree exactly as before, so
    // existing callers are unaffected.
    //
    // The cursor is anchored on UNIX_TIMESTAMP(updated_at) rather than the raw
    // TIMESTAMP so the value is a plain integer: it survives JSON round-trips and
    // re-binds into the query with no client/server timezone ambiguity. The
    // comparison is strict `>`; updated_at has second granularity, so two distinct
    // writes in the same wall-clock second straddling a poll could theoretically
    // miss the later one until a subsequent change re-bumps it — config writes are
    // rare (governance-driven) and a consumer restart re-fetches in full, so this
    // boundary is acceptable in exchange for avoiding a separate sequence column.
    async getAllConfigs(sinceUpdatedAt){
        let query = "SELECT coin, network, module, param_name, param_value FROM configs";
        let args  = [];
        let since = Number(sinceUpdatedAt);
        if(Number.isFinite(since) && since > 0){
            query += " WHERE UNIX_TIMESTAMP(updated_at) > ?";
            args.push(since);
        }
        query += " ORDER BY coin, network, module, param_name";
        let rows  = await this.doQuery(query, args);
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

    // Current high-water mark of the configs table as epoch seconds — the newest
    // updated_at across all rows, or 0 when the table is empty. Consumers thread
    // this value back into getAllConfigs(sinceUpdatedAt) on their next poll to
    // fetch only what changed since. Returned as an integer so it carries through
    // JSON and re-binds into the cursor query without timezone conversion.
    //
    // Callers should read this BEFORE reading the rows: a write landing between
    // the two reads is then excluded from the watermark but included in the rows,
    // so it is re-delivered next poll (an idempotent merge) rather than skipped.
    async getConfigWatermark(){
        let rows = await this.doQuery("SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS watermark FROM configs");
        let w = rows && rows[0] ? rows[0].watermark : null;
        return w == null ? 0 : Number(w);
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
