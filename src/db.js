/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Database Class
 *
 * This file handles connecting to MariaDB and running SQL queries.
 * Adapted from xchain-sync/src/db.js: connection pool,
 * circuit breaker, and hub-specific config storage methods.
 *
 ********************************************************************/

const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');

const DB_NAME_REGEX = /^[A-Za-z0-9_]+$/;

// Canonical coin names. The hub config tree keys coins by full name
// (bitcoin/litecoin/dogecoin); indexers, however, push chain tips using the
// coin abbreviation (config['COIN'] = 'BTC'/'LTC'/'DOGE'). Storing chain_tips
// under the abbreviation creates a phantom top-level coin key (e.g. 'BTC')
// alongside the real 'bitcoin' entry, which the explorer's config loader
// cannot map to a coin and used to crash on (configs/undefined.js). Normalize
// the coin to its full name so chain_tips co-locate under the canonical key.
const coins = require('./coins');
const COIN_FULL_NAME = { ...coins.COIN_FULL_NAME };

function normalizeCoin(coin) {
    if (typeof coin !== 'string') return coin;
    return COIN_FULL_NAME[coin.toUpperCase()] || coin;
}

// Binary args the driver encodes correctly on its own, so doQuery's
// JSON-stringify safety net must leave them alone: stringifying a Buffer yields
// `{"type":"Buffer","data":[...]}` rather than the BLOB bytes. Everything else
// (plain objects, arrays) keeps the JSON coercion, which is what the safety net
// is for: a caller that forgot to stringify a JSON column.
function isDriverNativeArg(value){
    return Buffer.isBuffer(value) || ArrayBuffer.isView(value);
}

// Render a Date as the UTC datetime literal MariaDB should store.
//
// Two separate defects met on this line. First, the safety net above
// used to catch Dates too: JSON.stringify(new Date()) is a QUOTED ISO string and
// MariaDB rejects it with errno 1292 "Incorrect datetime value", so EVERY product
// write binding a Date failed outright - Governance.propose() could not record a
// proposal at all - and the unit tier could not see it because it stubs doQuery.
// Second, simply handing the Date to the driver is not right either: the
// connector encodes it with getFullYear()/getHours(), i.e. in the NODE PROCESS's
// local timezone, while the session is pinned to UTC (see
// connectionPoolParams.timezone), so a hub on a non-UTC host silently writes an
// instant hours away from the one the caller meant. An explicit UTC literal makes
// the write agree with the session, with NOW()/CURRENT_TIMESTAMP, and with the
// driver's own UTC decoding on the way back out, wherever the hub runs.
function toUtcDatetimeLiteral(date){
    const p = (n, width = 2) => String(n).padStart(width, '0');
    return date.getUTCFullYear() + '-' + p(date.getUTCMonth() + 1) + '-' + p(date.getUTCDate()) +
        ' ' + p(date.getUTCHours()) + ':' + p(date.getUTCMinutes()) + ':' + p(date.getUTCSeconds()) +
        '.' + p(date.getUTCMilliseconds(), 3);
}

class Database {

    constructor(host, port, dbName, user, pass) {
        if(!DB_NAME_REGEX.test(dbName))
            throw new Error('Invalid database name: ' + dbName);

        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;

        this.connectionPoolParams = {
            host:               this.host,
            user:               this.user,
            password:           this.pass,
            database:           this.dbName,
            port:               this.port,
            connectionLimit:    10,
            connectTimeout:     parseInt(process.env.DB_CONNECT_TIMEOUT) || 10000,
            acquireTimeout:     parseInt(process.env.DB_ACQUIRE_TIMEOUT) || 10000,
            idleTimeout:        60000,
            insertIdAsNumber:   true,
            bigIntAsNumber:     true,
            // Pin BOTH halves of datetime handling to UTC. The driver
            // otherwise binds a JS Date using the Node process's LOCAL timezone while
            // the server evaluates NOW() / CURRENT_TIMESTAMP / FROM_UNIXTIME in the
            // session's own, so a hub whose host is not on UTC writes and compares
            // datetimes that are hours apart. Two real consequences, both silent:
            // Governance.propose() wrote a voting_end already in the past, so a
            // proposal expired the instant it was created, and ReorgHandler's rollback
            // DELETE matched nothing because the attestation rows it was meant to
            // remove appeared to predate the reorg bound. This option makes the driver
            // serialize/parse Dates as UTC and issue `SET time_zone='+00:00'` per
            // connection, so both sides agree no matter where the hub runs - which
            // also keeps a geographically-spread federation comparing like with like.
            // Safe for existing data: every temporal column in src/sql is TIMESTAMP,
            // which MariaDB already stores as UTC internally.
            timezone:           'Z',
            minDelayValidation: 3000,
            queryTimeout:       parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
        };

        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;

        // Circuit breaker state
        this.circuitState     = 'closed';
        this.circuitFailures  = 0;
        this.circuitThreshold = 10;
        this.circuitCooldown  = 30000;
        this.circuitOpenUntil = 0;
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Throw immediately on errors that retrying will never fix (bad credentials,
    // missing privilege). Transient errors (DB still booting, connection refused)
    // are NOT fatal; callers keep waiting on those. Without this, a misconfigured
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

    async verifyDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port,
            timezone: 'Z'   // same UTC pin as the pool, see connectionPoolParams
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

    async createDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port,
            timezone: 'Z'   // same UTC pin as the pool, see connectionPoolParams
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
                        // Existing table: reconcile column drift against the SQL
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

    // Idempotent: safe to run every startup.
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
        // Plain (non-unique) indexes declared in a table's SQL source AFTER the
        // table first shipped. alterTableForDrift back-fills missing columns but
        // deliberately never touches indexes, so an index added to the source
        // later never reaches a table that already exists on a deployed node.
        // idx_batch_seq is the case in point: the batch_seq column was
        // drift-reconciled onto prod validator_rewards during the ANCHOR rollout,
        // but its index had to be added by hand on every box. This folds that
        // hand-step into the code-side self-heal.
        await this._migrateIndex('validator_rewards', 'idx_batch_seq', '(batch_seq)');
        // The capability ENUM gains values as new capability tiers ship (e.g.
        // 'full_node' added for WI-2). alterTableForDrift only adds missing
        // columns and relaxes NULL; it never MODIFYs a column's type. So an
        // already-deployed validator_capabilities keeps the narrower ENUM and
        // rejects the new value (WARN_DATA_TRUNCATED) on the capability self-test
        // INSERT. Widen it in place to match CapabilityRegistry.KNOWN_CAPABILITIES.
        await this._migrateEnumColumn(
            'validator_capabilities',
            'capability',
            ['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node'],
            'NOT NULL'
        );
        // Checkpoint split-brain: tighten the state_checkpoints uniqueness from
        // (chain, network, block_index, checkpoint_seq) to (chain, network, checkpoint_seq)
        // so a same-seq race can never seat two divergent rows (and double-anchor DOGE).
        // _migrateUniqueKey dedups any pre-existing (chain, network, checkpoint_seq)
        // collisions (keeping the lowest id) before adding the key; the audit the spec
        // asks for is exactly that dedup step. Then retire the now-redundant wider
        // indexes so fresh installs and migrated nodes carry the same index set.
        await this._migrateUniqueKey(
            'state_checkpoints',
            'uq_chain_seq',
            '(chain, network, checkpoint_seq)',
            ['chain', 'network', 'checkpoint_seq']
        );
        await this._migrateIndex('state_checkpoints', 'sc_chain_blk', '(chain, network, block_index)');
        await this._dropIndexIfExists('state_checkpoints', 'chain_block_seq');
        await this._dropIndexIfExists('state_checkpoints', 'checkpoint_seq');
        // Widen capability_snapshots.uq_cap_snap to add `source`. At/above
        // STAKE_WEIGHTED_QUORUM a signing key delegated by two staking sources yields
        // one row per (source, pubkey); the old 3-column key collapsed them on
        // INSERT IGNORE and silently dropped the second source, understating stake for
        // any mirror-reading verifier. alterTableForDrift only reconciles columns and
        // _migrateUniqueKey no-ops once the index NAME exists, so neither widens an
        // existing key: this reconciles the column set in place. Monotonically safe (a
        // strict superset of an already-enforced UNIQUE key can only relax it, so no
        // pre-dedup is needed).
        await this._widenUniqueKey(
            'capability_snapshots',
            'uq_cap_snap',
            'source',
            '(snapshot_block, capability, signing_pubkey, source)'
        );
        // #4315: governance_proposals.voting_start/voting_end shipped as TIMESTAMP, which
        // MariaDB bounds to the signed 32-bit epoch (2038-01-19 03:14:07 UTC). Both hold a
        // FUTURE instant (voting_end is NOW() + GOV_VOTING_PERIOD), so they run out of range
        // one voting period BEFORE every 'now'-recording audit column does. alterTableForDrift
        // never MODIFYs a type, so the DDL edit alone would fix only fresh installs.
        await this._migrateColumnType('governance_proposals', 'voting_start', 'datetime', 'DATETIME NOT NULL');
        await this._migrateColumnType('governance_proposals', 'voting_end', 'datetime', 'DATETIME NOT NULL');
    }

    // Convert a column to a new type in place. Idempotent: reads the live DATA_TYPE from
    // information_schema and no-ops when it already matches `targetType`, so a fresh install
    // (which gets the type from the CREATE TABLE) and an already-migrated node both skip it.
    //
    // Safe for the TIMESTAMP -> DATETIME conversion it was added for: TIMESTAMP is stored
    // UTC-normalized and rendered through the SESSION time zone while DATETIME stores the
    // literal, so the conversion preserves the instant only under a UTC session. It is one:
    // the pool pins timezone 'Z' and the driver issues SET time_zone='+00:00' per connection
    // (connectionPoolParams), so no host's local zone can shift a stored value here.
    async _migrateColumnType(table, column, targetType, columnDef){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT DATA_TYPE FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                [this.dbName, table, column]
            );
            if(!rows[0]) return; // table/column not present yet; CREATE TABLE covers it
            let liveType = String(rows[0].DATA_TYPE || '').toLowerCase();
            if(liveType === String(targetType).toLowerCase()) return; // already converted
            await db.query('ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef);
            console.log('Migration: converted ' + table + '.' + column + ' ' + liveType + ' -> ' + targetType);
        } catch(e){
            // Swallowed on purpose, and loudly. runMigrations runs every migration in one
            // sequential pass at startup, so a throw here would take the remaining migrations
            // and the hub boot down with it - the wrong trade for a column that fails in 2038,
            // not today. What it must never be is invisible, so the line names the consequence
            // and the exact statement an operator runs to finish the job by hand.
            console.error('MIGRATION FAILED: ' + table + '.' + column + ' is still ' +
                'the old type. Until it is converted, any value past the TIMESTAMP epoch ' +
                'limit (2038-01-19 03:14:07 UTC) cannot be stored. Run by hand: ' +
                'ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef, e);
        } finally {
            await db.release();
        }
    }

    // Drop an index if it exists (idempotent). Used to retire an index that a
    // later schema revision superseded, so a node created from an older release
    // does not keep carrying it after the migration runs.
    async _dropIndexIfExists(table, indexName){
        let db = await this.getConnection();
        try {
            let existing = await db.query(
                "SELECT COUNT(*) AS c FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            if(!existing[0] || Number(existing[0].c) === 0) return;
            await db.query('ALTER TABLE `' + table + '` DROP INDEX `' + indexName + '`');
            console.log('Migration: dropped redundant INDEX ' + indexName + ' on ' + table);
        } catch(e){
            console.error('Migration error dropping ' + indexName + ' on ' + table + ':', e);
        } finally {
            await db.release();
        }
    }

    async _migrateUniqueKey(table, indexName, indexColumns, columnList){
        let db = await this.getConnection();
        try {
            let existing = await db.query(
                "SELECT COUNT(*) AS c FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            if(existing[0] && Number(existing[0].c) > 0) return;

            let joinClause = columnList.map(c => 't1.' + c + ' = t2.' + c).join(' AND ');
            let deleteSql = 'DELETE t1 FROM ' + table + ' t1 ' +
                            'INNER JOIN ' + table + ' t2 ' +
                            'WHERE t1.id > t2.id AND ' + joinClause;
            let result = await db.query(deleteSql);
            let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
            if(deleted > 0)
                console.log('Migration: removed ' + deleted + ' duplicate rows from ' + table);

            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
            console.log('Migration: added UNIQUE KEY ' + indexName + ' on ' + table);
        } catch(e){
            console.error('Migration error on ' + table + ':', e);
        } finally {
            await db.release();
        }
    }

    // Add a column to an existing UNIQUE KEY in place (drop + re-add the wider key).
    // Unlike _migrateUniqueKey (which no-ops as soon as the index NAME exists), this
    // reconciles a same-named key whose COLUMN SET changed. Only ever used to WIDEN a
    // key (add a column): a wider UNIQUE key is a strict superset constraint, so an
    // already-unique table cannot collide on it and no row dedup is required.
    // Idempotent: a no-op once the live key already covers `requiredColumn`, and it
    // simply adds the key when it is absent entirely.
    async _widenUniqueKey(table, indexName, requiredColumn, indexColumns){
        let db = await this.getConnection();
        try {
            let cols = await db.query(
                "SELECT column_name AS col FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            let present = (cols || []).map(r => String(r.col != null ? r.col : '').toLowerCase());
            if(present.length === 0){
                await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
                console.log('Migration: added UNIQUE KEY ' + indexName + ' on ' + table);
                return;
            }
            if(present.indexOf(String(requiredColumn).toLowerCase()) !== -1) return;   // already widened
            await db.query('ALTER TABLE ' + table + ' DROP INDEX ' + indexName);
            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
            console.log('Migration: widened UNIQUE KEY ' + indexName + ' on ' + table + ' to include ' + requiredColumn);
        } catch(e){
            console.error('Migration error widening ' + indexName + ' on ' + table + ':', e);
        } finally {
            await db.release();
        }
    }

    // Mirrors _migrateUniqueKey without the dedup step; idempotent once the index exists.
    async _migrateIndex(table, indexName, indexColumns){
        let db = await this.getConnection();
        try {
            let existing = await db.query(
                "SELECT COUNT(*) AS c FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            if(existing[0] && Number(existing[0].c) > 0) return;

            await db.query('ALTER TABLE ' + table + ' ADD INDEX ' + indexName + ' ' + indexColumns);
            console.log('Migration: added INDEX ' + indexName + ' on ' + table);
        } catch(e){
            console.error('Migration error on ' + table + ':', e);
        } finally {
            await db.release();
        }
    }

    // Widen an ENUM column in place to the target value set. Idempotent: skips
    // when the live COLUMN_TYPE already contains every target value, so it is a
    // no-op on fresh installs (which get the full set from the CREATE TABLE) and
    // on already-migrated nodes. Used to roll out new capability tiers without a
    // manual ALTER on every deployed hub.
    async _migrateEnumColumn(table, column, enumValues, nullClause){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT COLUMN_TYPE FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                [this.dbName, table, column]
            );
            if(!rows[0]) return; // table/column not present yet; CREATE TABLE covers it
            let liveType = String(rows[0].COLUMN_TYPE || '').toLowerCase();
            let missing = enumValues.filter(v => liveType.indexOf("'" + v.toLowerCase() + "'") === -1);
            if(missing.length === 0) return; // already covers every target value
            let enumDef = 'ENUM(' + enumValues.map(v => "'" + v + "'").join(',') + ')';
            await db.query('ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + enumDef + ' ' + (nullClause || ''));
            console.log('Migration: widened ' + table + '.' + column + ' ENUM (added ' + missing.join(', ') + ')');
        } catch(e){
            console.error('Migration error widening ' + table + '.' + column + ':', e);
        } finally {
            await db.release();
        }
    }

    async _createTableFromFile(file){
        let dir     = path.join(__dirname, 'sql');
        let data    = fs.readFileSync(dir + '/' + file, "utf8");
        let table   = file.substring(0, file.indexOf('.sql'));
        // Strip `--` line comments BEFORE splitting on ';'. A comment may contain a
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

    // Parse a CREATE TABLE statement to extract expected columns. Conservative
    // (only used for drift detection, not full schema management). Returns array of
    // {name, nullable, definition, notNull, hasDefault} or null when the file has
    // no recognizable CREATE TABLE block.
    parseExpectedColumns(sqlData){
        // Strip `--` line comments BEFORE any structural parsing. Inline comments
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
            // Skip constraint/index/key lines; column definitions only
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
            // be re-added verbatim, preserving its DEFAULT clause (which backfills
            // existing rows when the column is NOT NULL).
            cols.push({ name, nullable, definition: line, notNull, hasDefault });
        }
        return cols.length > 0 ? cols : null;
    }

    // Detect schema drift between the live table and its SQL source, and fix it
    // by ALTER. Two kinds of drift are handled:
    //   1. Missing columns: a column declared in the SQL source but absent from
    //      the live table is added with ADD COLUMN, reusing the source definition
    //      verbatim so its DEFAULT clause backfills existing rows. (A NOT NULL
    //      column with no DEFAULT can't be backfilled safely, so it's skipped
    //      with a loud warning rather than aborting startup.)
    //   2. Nullability: only relaxes NOT NULL -> NULL (the safe direction; never
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
                    console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT (cannot backfill existing rows safely). Skipping; add manually.');
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

    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;

        if(this.circuitState === 'open'){
            if(Date.now() < this.circuitOpenUntil)
                throw new Error('Circuit breaker open: database connections rejected until cooldown expires');
            this.circuitState = 'half-open';
            console.log('Circuit breaker half-open: attempting reconnection');
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
                    console.log('Circuit breaker closed: database connection restored');
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

    async doQuery(query, args){
        let results = [];
        if(query){
            if(Array.isArray(args)){
                for(let i = 0; i < args.length; i++){
                    if(args[i] instanceof Date){
                        args[i] = toUtcDatetimeLiteral(args[i]);
                    } else if(args[i] !== null && args[i] !== undefined && typeof args[i] === 'object'
                              && !isDriverNativeArg(args[i])) {
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
                // Always rethrow. Swallowing non-transactional errors returned [] to
                // callers that write consensus/coordination rows (mirrors, configs,
                // prices), so a failed INSERT/UPDATE read as success and the row was
                // silently missing downstream. An empty result must mean a genuinely
                // empty SELECT, never a failed query.
                console.error('Error running database query:', error);
                throw error;
            } finally {
                // Release in finally so an error no longer leaks the pooled
                // connection. Transaction connections are owned by the caller.
                if(!tx) await db.release();
            }
        }
        return results;
    }

    async setParam(coin, network, module, paramName, paramValue){
        let query = `INSERT INTO configs (coin, network, module, param_name, param_value)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE param_value = ?, updated_at = NOW()`;
        await this.doQuery(query, [coin, network, module, paramName, paramValue, paramValue]);
    }

    // Batched upsert. rows: [{coin, network, module, paramName, paramValue}, ...]
    // Single round-trip: keeps xchain-node's precheck push (3 coins x 3 networks
    // x ~6 modules x ~7 params ~= 378 rows) under one second instead of one
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

    async getConfig(coin, network, module){
        let query = "SELECT param_name, param_value FROM configs WHERE coin = ? AND network = ? AND module = ?";
        let rows  = await this.doQuery(query, [coin, network, module]);
        let config = {};
        for(let row of rows){
            config[row.param_name] = row.param_value;
        }
        return config;
    }

    // Network defaults to 'mainnet' for back-compat with older indexers.
    async setChainTip(coin, network, blockHeight, blockTime){
        let net = network || 'mainnet';
        // Store under the full coin name (see COIN_FULL_NAME) so chain_tips never
        // appears as an abbreviation-keyed phantom coin in the served config tree.
        let key = normalizeCoin(coin);
        await this.setParam(key, net, 'chain_tips', 'block_height', String(blockHeight));
        await this.setParam(key, net, 'chain_tips', 'block_time',   String(blockTime));
    }

    // Network defaults to 'mainnet' for back-compat; multi-network hubs must pass it explicitly.
    // Returns: { blockHeight, blockTime } or null if not set.
    async getChainTip(coin, network){
        let net = network || 'mainnet';
        // Prefer the canonical full-name key (setChainTip writes there now). Fall
        // back to the raw abbreviation for tips written before the normalization,
        // so a deploy never opens a read gap on the oracle's BTC anchor.
        let cfg = await this.getConfig(normalizeCoin(coin), net, 'chain_tips');
        if(!cfg.block_height && normalizeCoin(coin) !== coin)
            cfg = await this.getConfig(coin, net, 'chain_tips');
        if(!cfg.block_height) return null;
        return {
            blockHeight: parseInt(cfg.block_height),
            blockTime:   parseInt(cfg.block_time) || 0
        };
    }

    // Returns: { coin: { network: { module: { param: value } } } }
    //
    // Optional `sinceUpdatedAt` (epoch-seconds cursor from getConfigWatermark) returns rows
    // changed at or after that instant. The cursor is anchored on UNIX_TIMESTAMP(updated_at): a
    // plain integer that survives JSON round-trips with no timezone ambiguity. Comparison is
    // INCLUSIVE `>=` (item #2265): both sides truncate to whole seconds, so a strict `>` dropped
    // a write committed after the row read but stamped in the same second as the watermark - the
    // client advanced its cursor to that second and the write was never delivered until a full
    // re-fetch. The cost of `>=` is that rows in the cursor second are re-delivered each poll
    // until a newer write lands; consumers merge idempotently, so redelivery is a no-op and the
    // delta is genuinely loss-free without a separate sequence column.
    async getAllConfigs(sinceUpdatedAt){
        let query = "SELECT coin, network, module, param_name, param_value FROM configs";
        let args  = [];
        let since = Number(sinceUpdatedAt);
        if(Number.isFinite(since) && since > 0){
            query += " WHERE UNIX_TIMESTAMP(updated_at) >= ?";
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

    // High-water mark of the configs table as epoch seconds (newest updated_at, or 0 when empty).
    // Read BEFORE reading the rows: a racing write is excluded from the watermark but included in
    // the rows. The cursor second itself is INCLUSIVE on the next poll (getAllConfigs uses `>=`),
    // so a write stamped in the same second as the watermark - even one committed after the row
    // read - is re-delivered next poll (idempotent merge) rather than skipped. That inclusive
    // redelivery is what makes the delta loss-free at one-second granularity (item #2265).
    async getConfigWatermark(){
        let rows = await this.doQuery("SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS watermark FROM configs");
        let w = rows && rows[0] ? rows[0].watermark : null;
        return w == null ? 0 : Number(w);
    }

    // HUB-RETRACT-4: per-source-chain price ingest fence. Returns the highest source-chain
    // rollback generation whose price retraction the hub has processed, plus that retraction's
    // orphaned-range lower bound; or null when no retraction has ever been recorded for the chain
    // (so pre-reorg generation-0 pushes are never rejected). PriceAggregator rejects an incoming
    // price push whose push_generation <= retraction_generation AND action_index >= from_action_index:
    // exactly a stale replay of a rolled-back action arriving after its retraction (the re-published
    // canonical row carries a higher generation and passes).
    async getPriceIngestWatermark(sourceChain){
        let rows = await this.doQuery(
            "SELECT retraction_generation, from_action_index FROM price_ingest_watermarks WHERE source_chain = ? LIMIT 1",
            [sourceChain]);
        if(!rows || rows.length === 0) return null;
        return {
            retraction_generation: Number(rows[0].retraction_generation) || 0,
            from_action_index:     Number(rows[0].from_action_index) || 0
        };
    }

    // Raise a chain's ingest fence to a retraction's generation. Monotonic in generation: a higher
    // generation replaces the stored (generation, from); the same generation only widens the
    // orphaned range downward (LEAST from); a lower generation is ignored. The from_action_index
    // assignment is ordered BEFORE retraction_generation so its CASE reads the OLD generation
    // (MariaDB evaluates ON DUPLICATE assignments left to right).
    async bumpPriceIngestWatermark(sourceChain, generation, fromActionIndex){
        let gen  = Number(generation);
        let from = Number(fromActionIndex);
        if(!Number.isFinite(gen) || gen < 0) return;
        if(!Number.isFinite(from) || from < 0) from = 0;
        await this.doQuery(
            `INSERT INTO price_ingest_watermarks (source_chain, retraction_generation, from_action_index)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
                from_action_index = CASE
                    WHEN VALUES(retraction_generation) > retraction_generation THEN VALUES(from_action_index)
                    WHEN VALUES(retraction_generation) = retraction_generation THEN LEAST(from_action_index, VALUES(from_action_index))
                    ELSE from_action_index END,
                retraction_generation = GREATEST(retraction_generation, VALUES(retraction_generation))`,
            [sourceChain, gen, from]);
    }

    // Returns 0 on a fresh node or unparseable value.
    async getLastSeq(){
        let rows = await this.doQuery(
            "SELECT value FROM consensus_state WHERE key_name = ?",
            ['last_seq']
        );
        if(!rows || rows.length === 0) return 0;
        let seq = parseInt(rows[0].value, 10);
        return Number.isNaN(seq) ? 0 : seq;
    }

    async close(){
        await this.pool.end();
    }
}

module.exports = Database;
