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

// Runtime floor, asserted above the require it protects. The pinned mariadb 3.5.x
// line is ESM-only ("type": "module"), and require() loads ESM without a flag only
// from Node 22.12.0; below that the next line throws a bare ERR_REQUIRE_ESM that
// names neither the Node version nor the reason. engines.node cannot enforce this
// (npm only warns, and nothing in the tree sets engine-strict), so the check lives
// here, where the failure actually happens.
const [NODE_MAJOR, NODE_MINOR] = String(process.versions.node).split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 12)) {
    throw new Error('xchain-hub requires Node >= 22.12.0 (running ' + process.versions.node +
        '): the pinned mariadb 3.5.x driver is ESM-only and require() can load ESM without ' +
        'a flag only from Node 22.12. Upgrade the runtime (see .nvmrc), or start Node with ' +
        '--experimental-require-module.');
}

const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');
const ark     = require('./anchor_reward_key.js');

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

// Column names carried by an index spec such as "(a, b, c)", lowercased, with
// backticks and any prefix length stripped, so they can be matched against
// information_schema.columns before a key that names them is built.
function indexSpecColumns(spec){
    return String(spec == null ? '' : spec)
        .replace(/^\s*\(/, '').replace(/\)\s*$/, '')
        .split(',')
        .map(s => s.trim().replace(/`/g, '').replace(/\(\s*\d+\s*\)$/, '').toLowerCase())
        .filter(Boolean);
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
        // One summary line instead of a per-table pair; error paths below still
        // name the table, so a failure stays attributable.
        console.log('Verifying database and tables...');
        let checked = 0;
        let created = 0;
        for(let file of files){
            if(file.indexOf('.sql') !== -1){
                let table = file.substring(0, file.indexOf('.sql'));
                checked++;
                try {
                    let results = await db.query("SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ?", [this.dbName, table]);
                    if(results.length === 0){
                        await this._createTableFromFile(file);
                        created++;
                    } else
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
        console.log('Database and tables verified (' + checked + ' tables, ' + created + ' created).');
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
        // The reward key carries round_qualifier: snapshot_block for the anchor_archive
        // leg, 0 for every other type, so non-archive keys are exactly what they were.
        // The archive leg keys on MATCH_BATCH_SEQ, which a wipe-and-replay rebase
        // reissues, so the four-column key collapsed two genuinely distinct archive
        // anchors into one row. Backfill BEFORE widening: a pre-column archive row left
        // at the DEFAULT 0 falls out of every qualified predicate and reads as absent.
        await this._migrateUniqueKey(
            'validator_rewards',
            'uq_reward',
            '(validator_pubkey, round_number, reward_type, round_qualifier)',
            ['validator_pubkey', 'round_number', 'reward_type', 'round_qualifier']
        );
        await this._backfillArchiveRoundQualifier();
        await this._widenUniqueKey(
            'validator_rewards',
            'uq_reward',
            'round_qualifier',
            '(validator_pubkey, round_number, reward_type, round_qualifier)'
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
        // attestation_responses: one request can finalize under two leader slots and
        // yield two honestly signed rows that differ only in effective_time; the old
        // (network, request_id) key absorbed the second as a duplicate on some hubs and
        // kept it on others, so no window carrying such a request could reach batch
        // quorum. The stamp joins the key (see the table's SQL); same widen semantics.
        await this._widenUniqueKey(
            'attestation_responses',
            'uq_attest_response',
            'effective_time',
            '(network, request_id, effective_time)'
        );
        // #4315: governance_proposals.voting_start/voting_end shipped as TIMESTAMP, which
        // MariaDB bounds to the signed 32-bit epoch (2038-01-19 03:14:07 UTC). Both hold a
        // FUTURE instant (voting_end is NOW() + GOV_VOTING_PERIOD), so they run out of range
        // one voting period BEFORE every 'now'-recording audit column does. alterTableForDrift
        // never MODIFYs a type, so the DDL edit alone would fix only fresh installs.
        await this._migrateColumnType('governance_proposals', 'voting_start', 'datetime', 'DATETIME NOT NULL');
        await this._migrateColumnType('governance_proposals', 'voting_end', 'datetime', 'DATETIME NOT NULL');
        // attestation_responses.response_payload / meta hold PROVIDER bytes, and the on-chain
        // twins they stand in for (attests.response_payload, attests.meta on the indexer) are
        // utf8mb4. On the table's utf8mb3 tail a 4-byte character fails the mirror INSERT with
        // errno 1366 under STRICT_TRANS_TABLES, so a body the ATTEST v1 path would have carried
        // never reaches any indexer and the request it answers expires unresolved.
        // alterTableForDrift adds a missing column and never restates an existing one, so the
        // DDL edit in src/sql/attestation_responses.sql alone reaches only fresh installs.
        await this._migrateColumnCharset('attestation_responses', 'response_payload', 'utf8mb4',
            'MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        await this._migrateColumnCharset('attestation_responses', 'meta', 'utf8mb4',
            'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        // re-key price_ingest_watermarks from (source_chain) to
        // (network, source_chain). alterTableForDrift adds the `network` column on an
        // already-deployed table but never touches keys, so without this step a migrated
        // hub carries the column and STILL collapses every network onto one row per chain:
        // the fence's upsert would key on source_chain and one network's retraction would
        // overwrite another's. That is the bug this item exists to remove, so the re-key is
        // the migration, not the column.
        await this._migratePriceFencePrimaryKey();
    }

    // Move price_ingest_watermarks' PRIMARY KEY onto (network, source_chain).
    //
    // Idempotent: reads the live key first and no-ops once it already names both columns,
    // so this runs on every boot at the cost of one information_schema read.
    //
    // DROP and ADD are issued as ONE ALTER. MariaDB DDL is not transactional, and a table
    // left with no primary key would let two rows for the same (network, chain) seat, which
    // is a silently divergent fence rather than a loud failure. A single statement either
    // lands both halves or neither.
    //
    // No dedup pass is needed: the old key made source_chain unique on its own, and the
    // drift-added column defaults every existing row to '', so (network, source_chain) is
    // already unique across the existing rows. Those rows stay in the '' bucket, which
    // getPriceIngestWatermark folds into every network's read, so the migration cannot
    // lower a live fence; the fleet migration script backfills them onto the owning hub's
    // network to retire the coupling for good.
    //
    // A failure here is logged, not thrown: the pre-migration chain-keyed fence still
    // rejects stale replays (over-broadly, across networks), so refusing to boot would
    // trade a scoping defect for an outage.
    async _migratePriceFencePrimaryKey(){
        const table = 'price_ingest_watermarks';
        let db = await this.getConnection();
        try {
            let present = await this._liveIndexColumns(db, table, 'PRIMARY');
            // [] means the table is not here yet (a fresh install creates it from the SQL
            // source, already correctly keyed). Nothing to migrate either way.
            if(present.length === 0 || (present[0] === 'network' && present[1] === 'source_chain')) return;

            let missing = await this._missingIndexColumns(db, table, '(network, source_chain)');
            if(missing.length > 0){
                console.error('Migration: cannot re-key ' + table + ' on (network, source_chain); the table is '
                    + 'missing ' + missing.join(', ') + '. The fence stays chain-keyed, so one network\'s '
                    + 'retraction still fences every network for that chain. Run the fleet migration '
                    + '(xchain-hub/migrations/2026-09-11-price-ingest-watermarks-network-column.sql) by hand.');
                return;
            }

            await db.query('ALTER TABLE `' + table + '` DROP PRIMARY KEY, ADD PRIMARY KEY (network, source_chain)');
            let after = await this._liveIndexColumns(db, table, 'PRIMARY');
            if(after[0] === 'network' && after[1] === 'source_chain')
                console.log('Migration: re-keyed ' + table + ' on (network, source_chain); the price ingest '
                    + 'fence is now per network, not shared across every network on this hub DB.');
            else
                console.error('Migration: the re-key of ' + table + ' did not take (PRIMARY now covers '
                    + (after.join(', ') || 'nothing') + '). The fence is still chain-keyed.');
        } catch(e){
            console.error('Migration error re-keying ' + table + ':', e);
        } finally {
            await db.release();
        }
    }

    // Widen a column's character set in place. Idempotent: reads the live
    // CHARACTER_SET_NAME from information_schema and no-ops once it matches, so a fresh
    // install (which gets the charset from the CREATE TABLE) and an already-migrated node
    // both skip it. It reads the positive case rather than comparing against a legacy
    // spelling because MariaDB 10.6 renamed utf8 to utf8mb3.
    //
    // WIDENING ONLY. `columnDef` restates the whole column, so it must name the same type
    // and nullability the definition file declares; a narrowing here would fail on stored
    // rows rather than converting them. A widen rewrites no stored value: utf8mb3 is a
    // strict subset of utf8mb4, and utf8mb4_general_ci orders BMP characters exactly as
    // utf8_general_ci does.
    async _migrateColumnCharset(table, column, targetCharset, columnDef){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT CHARACTER_SET_NAME FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                [this.dbName, table, column]
            );
            if(!rows[0]) return; // table/column not present yet; CREATE TABLE covers it
            let liveCharset = String(rows[0].CHARACTER_SET_NAME || '').toLowerCase();
            if(liveCharset === String(targetCharset).toLowerCase()) return; // already widened
            await db.query('ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef);
            console.log('Migration: widened ' + table + '.' + column + ' ' + liveCharset + ' -> ' + targetCharset);
        } catch(e){
            // Swallowed loudly, as _migrateColumnType is and for the same reason: runMigrations
            // is one sequential pass at startup, and a throw takes the remaining migrations and
            // the hub boot with it. A narrow column stores every BMP body exactly as it does
            // now, so booting is the better trade - but the line has to name what stays broken
            // and the statement that finishes the job.
            console.error('MIGRATION FAILED: ' + table + '.' + column + ' is still ' + targetCharset +
                '-incapable. Until it is widened, a provider body carrying a 4-byte character ' +
                'cannot be stored and the response never reaches an indexer. Run by hand: ' +
                'ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef, e);
        } finally {
            await db.release();
        }
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

    // Columns a live index actually covers, lowercased, in key order. [] when the
    // index is absent. Read back after every DDL step in _widenUniqueKey, because a
    // statement that did not throw is not proof that the key is there.
    async _liveIndexColumns(db, table, indexName){
        let rows = await db.query(
            "SELECT column_name AS col FROM information_schema.statistics " +
            "WHERE table_schema = ? AND table_name = ? AND index_name = ? ORDER BY seq_in_index",
            [this.dbName, table, indexName]
        );
        return (rows || []).map(r => String(r.col != null ? r.col : '').toLowerCase()).filter(Boolean);
    }

    // Columns named by an index spec that the table does not have. This is the errno
    // 1072 case ("key column doesn't exist in table") read one statement early, which
    // is what lets the widen refuse before it has touched the existing key.
    async _missingIndexColumns(db, table, indexColumns){
        let wanted = indexSpecColumns(indexColumns);
        if(wanted.length === 0) return [];
        let rows = await db.query(
            "SELECT column_name AS col FROM information_schema.columns " +
            "WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        let have = new Set((rows || []).map(r => String(r.col != null ? r.col : '').toLowerCase()));
        // An empty column read means information_schema told us nothing about the
        // table, not that the table has no columns; treat it as "cannot judge" and
        // let the ADD speak, rather than blocking a widen on a bad read.
        if(have.size === 0) return [];
        return wanted.filter(c => !have.has(c));
    }

    // Add a column to an existing UNIQUE KEY in place.
    //
    // ADD-THEN-DROP, never drop-then-add. MariaDB DDL is not transactional, so the
    // old order had a window where a failed ADD left the table with NO unique key
    // and only a log line to say so: a duplicate then inserted cleanly, and for the
    // capability snapshot key that reaches the validator set. Here the wider key is
    // built first under a temporary name, so every failure point leaves the table
    // holding a unique key on these columns, and each step is confirmed by re-reading
    // information_schema instead of trusting that the statement did not throw. If the
    // sequence ever ends with no such key at all, the error thrown here takes hub boot
    // down with it, because serving an unconstrained table is the worse outcome.
    // Widening only (add a column), so no row dedup is required.
    async _widenUniqueKey(table, indexName, requiredColumn, indexColumns){
        const tempName = indexName + '_widening';
        const byHand   = 'ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns;
        let db = await this.getConnection();
        let dropped = false;   // set once the original key is gone, which is what arms the guard
        try {
            let present = await this._liveIndexColumns(db, table, indexName);

            // A temporary key means an earlier run died mid-sequence. Finish that run
            // first: promote it to the real name if the real name is free, then retire it.
            if((await this._liveIndexColumns(db, table, tempName)).length > 0){
                if(present.length === 0){
                    dropped = true;
                    await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
                    present = await this._liveIndexColumns(db, table, indexName);
                }
                if(present.length > 0){
                    await db.query('ALTER TABLE ' + table + ' DROP INDEX ' + tempName);
                    console.log('Migration: completed an interrupted widen of ' + indexName + ' on ' + table);
                }
            }

            if(present.length === 0){
                await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
                console.log('Migration: added UNIQUE KEY ' + indexName + ' on ' + table);
                return;
            }
            if(present.indexOf(String(requiredColumn).toLowerCase()) !== -1) return;   // already widened

            let missing = await this._missingIndexColumns(db, table, indexColumns);
            if(missing.length > 0){
                // The existing key is untouched, so the table is exactly as constrained as
                // it was; the widen simply does not happen on this boot.
                console.error('MIGRATION SKIPPED: UNIQUE KEY ' + indexName + ' on ' + table +
                    ' cannot be widened because the table has no ' + missing.join(', ') +
                    ' column. The narrower key is left in place. Add the column, then run: ' + byHand);
                return;
            }

            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + tempName + ' ' + indexColumns);
            if((await this._liveIndexColumns(db, table, tempName)).length === 0)
                throw new Error('the wider key did not appear after ADD ' + tempName);

            dropped = true;
            await db.query('ALTER TABLE ' + table + ' DROP INDEX ' + indexName);
            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
            if((await this._liveIndexColumns(db, table, indexName)).indexOf(String(requiredColumn).toLowerCase()) === -1)
                throw new Error('the widened key did not appear under its own name');

            await db.query('ALTER TABLE ' + table + ' DROP INDEX ' + tempName);
            console.log('Migration: widened UNIQUE KEY ' + indexName + ' on ' + table + ' to include ' + requiredColumn);
        } catch(e){
            console.error('Migration error widening ' + indexName + ' on ' + table + ':', e);
            if(dropped) await this._assertUniqueKeyStillEnforced(db, table, indexName, tempName, byHand);
        } finally {
            await db.release();
        }
    }

    // Boot guard for a widen that failed after the original key was dropped. Passes as
    // soon as either the final or the temporary key is live AND unique, since either one
    // still constrains the same columns. Anything else, a failed probe included, refuses
    // the boot: an unconstrained table admits duplicates no later read can tell apart.
    async _assertUniqueKeyStillEnforced(db, table, indexName, tempName, byHand){
        let enforcing = null;
        try {
            for(const name of [indexName, tempName]){
                let rows = await db.query(
                    "SELECT non_unique AS nu FROM information_schema.statistics " +
                    "WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1",
                    [this.dbName, table, name]
                );
                if(rows && rows[0] && Number(rows[0].nu) === 0){ enforcing = name; break; }
            }
        } catch(probeError){
            console.error('Could not read the index state of ' + table + ':', probeError);
        }
        if(enforcing === tempName)
            console.error('WARNING: ' + table + ' is constrained by the temporary key ' + tempName +
                ' rather than ' + indexName + '. The next boot completes the rename; nothing is lost meanwhile.');
        if(enforcing) return;
        throw new Error('Refusing to start: the UNIQUE KEY ' + indexName + ' on ' + table +
            ' was dropped and could not be rebuilt, so the table now accepts duplicate rows. ' +
            'Restore it by hand before starting the hub again: ' + byHand);
    }

    // Stamp the archive-leg round qualifier onto reward rows written before the column
    // existed. block_index IS the archive leg's snapshot_block at both writers, so the
    // value is recoverable in place. Scoped to anchor_archive, so no other reward type's
    // key can move, and idempotent (a stamped row no longer matches round_qualifier = 0).
    async _backfillArchiveRoundQualifier(){
        let db = await this.getConnection();
        try {
            let result = await db.query(
                'UPDATE validator_rewards SET round_qualifier = block_index ' +
                'WHERE reward_type = ? AND round_qualifier = 0 AND block_index IS NOT NULL AND block_index > 0',
                [ark.ARCHIVE_REWARD_TYPE]);
            let changed = (result && result.affectedRows) ? Number(result.affectedRows) : 0;
            if(changed > 0)
                console.log('Migration: qualified ' + changed + ' archive reward row(s) by snapshot block');
        } catch(e){
            console.error('Migration error qualifying archive rewards:', e);
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
        // Strip `--` line comments BEFORE splitting on ';'. A comment may contain a
        // ';' (e.g. "regtest; signed into the canonical"), which would otherwise split
        // the CREATE TABLE mid-statement and fail to parse. stripSqlLineComments
        // preserves quoted strings, so real SQL structure is untouched.
        let queries = this.stripSqlLineComments(data).split(';');
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

    // Every row of one module on one network, across coins, ordered so two hubs
    // reading the same table see the same sequence. getConfig() above needs a coin,
    // and a hub has none: it federates several chains and p2pConfig carries only
    // HUB_NETWORK. Used for chain-agnostic modules whose param_name is the whole
    // identity (ATTESTATION_PROVIDER rows are one definition per provider_id), where
    // a coin-keyed read would have to invent a coin to ask for.
    async getConfigRowsByModule(network, module){
        let query = "SELECT coin, param_name, param_value FROM configs WHERE network = ? AND module = ? "
                  + "ORDER BY coin, param_name";
        return await this.doQuery(query, [network, module]);
    }

    // Network defaults to 'mainnet' for back-compat with older indexers.
    //
    // `chainId` (optional) identifies the chain INSTANCE the pushing indexer follows:
    // the hash of its block 1, not of block 0, because the regtest genesis hash is a
    // chainparams constant that survives every re-genesis while block 1 commits to the
    // moment the new chain started. Omitted (older indexer, or a chain whose block 1 is
    // not mined yet) leaves the stored value alone rather than clearing it, so a single
    // push that has not learned the id cannot erase an identity the mirrors are filtering on.
    async setChainTip(coin, network, blockHeight, blockTime, chainId){
        let net = network || 'mainnet';
        // Store under the full coin name (see COIN_FULL_NAME) so chain_tips never
        // appears as an abbreviation-keyed phantom coin in the served config tree.
        let key = normalizeCoin(coin);
        await this.setParam(key, net, 'chain_tips', 'block_height', String(blockHeight));
        await this.setParam(key, net, 'chain_tips', 'block_time',   String(blockTime));
        if(typeof chainId === 'string' && chainId)
            await this.setParam(key, net, 'chain_tips', 'chain_id', chainId);
    }

    // Network defaults to 'mainnet' for back-compat; multi-network hubs must pass it explicitly.
    // Returns: { blockHeight, blockTime, chainId } or null if not set.
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
            blockTime:   parseInt(cfg.block_time) || 0,
            // Explicitly null, never undefined, when no indexer has reported one: every
            // consumer (the row stamps, the snapshot envelopes) treats null as "identity
            // unknown", which the mirrors accept, so a hub that has not learned its chain
            // keeps behaving exactly as it did before the column existed.
            chainId:     (typeof cfg.chain_id === 'string' && cfg.chain_id) ? cfg.chain_id : null
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

    // The fence's network scope, normalized the same way on the read and the write so a
    // HUB_NETWORK of '  Regtest ' keys the same row as 'regtest'. '' is the legacy/unset
    // bucket: a hub that does not know its own network writes there, and every reader folds
    // that bucket in (see getPriceIngestWatermark).
    static normalizeFenceNetwork(network){
        return typeof network === 'string' ? network.trim().toLowerCase() : '';
    }

    // HUB-RETRACT-4: per-(network, source-chain) price ingest fence. Returns the highest
    // source-chain rollback generation whose price retraction the hub has processed, plus that
    // retraction's orphaned-range lower bound; or null when no retraction has ever been recorded
    // for the chain on this network (so pre-reorg generation-0 pushes are never rejected).
    // PriceAggregator rejects an incoming price push whose push_generation <= retraction_generation
    // AND action_index >= from_action_index: exactly a stale replay of a rolled-back action arriving
    // after its retraction (the re-published canonical row carries a higher generation and passes).
    //
    // `network` is part of the key because one hub DB can be shared by, or outlive, more than one
    // deployment network: on a chain-only key, clearing the regtest fence after an indexer wipe
    // dropped the LIVE network's fence for that chain and admitted the orphan replay it existed to
    // stop. The legacy '' bucket (rows written before the column, or by a hub with HUB_NETWORK
    // unset) is ambiguous by construction, so it is folded in here and the STRICTER fence wins:
    // highest generation, and at a tie the lowest orphan bound. Over-rejecting is loud and
    // clearable; a fence silently lost is not.
    async getPriceIngestWatermark(sourceChain, network){
        let net = Database.normalizeFenceNetwork(network);
        let rows = await this.doQuery(
            `SELECT retraction_generation, from_action_index FROM price_ingest_watermarks
             WHERE source_chain = ? AND network IN (?, '')
             ORDER BY retraction_generation DESC, from_action_index ASC
             LIMIT 1`,
            [sourceChain, net]);
        if(!rows || rows.length === 0) return null;
        return {
            retraction_generation: Number(rows[0].retraction_generation) || 0,
            from_action_index:     Number(rows[0].from_action_index) || 0
        };
    }

    // Raise one network's fence for a chain to a retraction's generation. Monotonic in generation:
    // a higher generation replaces the stored (generation, from); the same generation only widens
    // the orphaned range downward (LEAST from); a lower generation is ignored. The from_action_index
    // assignment is ordered BEFORE retraction_generation so its CASE reads the OLD generation
    // (MariaDB evaluates ON DUPLICATE assignments left to right).
    //
    // The write always names this hub's own network, so a retraction on one network can no longer
    // raise a fence that drops another network's healthy pushes.
    async bumpPriceIngestWatermark(sourceChain, generation, fromActionIndex, network){
        let gen  = Number(generation);
        let from = Number(fromActionIndex);
        if(!Number.isFinite(gen) || gen < 0) return;
        if(!Number.isFinite(from) || from < 0) from = 0;
        let net = Database.normalizeFenceNetwork(network);
        await this.doQuery(
            `INSERT INTO price_ingest_watermarks (network, source_chain, retraction_generation, from_action_index)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                from_action_index = CASE
                    WHEN VALUES(retraction_generation) > retraction_generation THEN VALUES(from_action_index)
                    WHEN VALUES(retraction_generation) = retraction_generation THEN LEAST(from_action_index, VALUES(from_action_index))
                    ELSE from_action_index END,
                retraction_generation = GREATEST(retraction_generation, VALUES(retraction_generation))`,
            [net, sourceChain, gen, from]);
    }

    // ---------------------------------------------------------------------------
    // Bridge tables (the base bridge spec section 6, token spec section 5,
    // policy spec section 5). CrossChainBridgeEngine runs the rounds; the writes and
    // the invariant read live here beside the other table writers so one place owns
    // the column lists that the hub-DB mirror carries to every indexer.
    // ---------------------------------------------------------------------------

    // Columns written for a finalized transfer record. `status` is left to its DDL
    // default ('finalized') and `id`/`created_at` are assigned by the table.
    static get BRIDGE_TRANSFER_COLUMNS(){
        return ['transfer_id', 'snapshot_block', 'network', 'src_chain', 'src_action_index',
                'src_address', 'dest_chain', 'dest_address', 'tick', 'decimals', 'amount',
                'effective_time', 'finalizing_view', 'validator_signatures', 'push_generation',
                'btc_chain_id'];
    }

    // Columns written for a finalized policy snapshot.
    static get POLICY_SNAPSHOT_COLUMNS(){
        return ['snapshot_id', 'snapshot_block', 'origin_chain', 'tick', 'policy_seq',
                'origin_block', 'policy_hash', 'allow_list', 'block_list', 'sleeping',
                'effective_time', 'network', 'finalizing_view', 'validator_signatures',
                'push_generation', 'btc_chain_id'];
    }

    // Persist one quorum-signed transfer record. Returns true ONLY when a row was
    // actually written, so the caller mirrors, credits and logs exactly once per
    // finalization and a duplicate finalize (restart race, a second hub) is a no-op.
    //
    // INSERT IGNORE plus a revive of a retracted row: the cross_chain_matches rule
    // verbatim (CrossChainDexEngine._insertMatchRow). transfer_id folds snapshot_block
    // into its preimage, so a source leg reorged out and re-mined while the BTC tip has
    // not moved re-derives the IDENTICAL id; without the revive the IGNORE would no-op
    // against the stale 'retracted' row and the re-formed transfer would strand,
    // unmirrored, until the tip advanced. A row already 'finalized' is left untouched by
    // the status guard, which is what keeps the double-finalize dedupe.
    async insertBridgeTransfer(row){
        let cols = Database.BRIDGE_TRANSFER_COLUMNS;
        let res = await this.doQuery(
            'INSERT IGNORE INTO bridge_transfers (' + cols.join(', ') + ') VALUES (' +
            cols.map(() => '?').join(', ') + ')',
            cols.map(c => row[c]));
        if(res && Number(res.affectedRows) > 0) return true;
        let revive = await this.doQuery(
            "UPDATE bridge_transfers SET status = 'finalized', validator_signatures = ?, " +
            "finalizing_view = ?, effective_time = ? WHERE transfer_id = ? AND status = 'retracted'",
            [row.validator_signatures, row.finalizing_view, row.effective_time, row.transfer_id]);
        return !!(revive && Number(revive.affectedRows) > 0);
    }

    // Persist one quorum-signed policy snapshot. Append-only, the state_checkpoints
    // shape: a superseding policy is a NEW row at a higher policy_seq, never an in-place
    // update (the mirror applies rows INSERT IGNORE, so an UPDATE would never propagate),
    // and there is no retraction path for this table. Returns true only on a real insert
    // so a same-seq race between two hubs collapses on uq_policy_seq silently.
    async insertPolicySnapshot(row){
        let cols = Database.POLICY_SNAPSHOT_COLUMNS;
        let res = await this.doQuery(
            'INSERT IGNORE INTO policy_snapshots (' + cols.join(', ') + ') VALUES (' +
            cols.map(() => '?').join(', ') + ')',
            cols.map(c => row[c]));
        return !!(res && Number(res.affectedRows) > 0);
    }

    // Highest FINALIZED policy_seq this hub holds for one token, or 0 when it holds
    // none. The next snapshot signs at this + 1 (policy spec section 3 step 2); a gap is
    // ordering only and never a refusal, so the caller never back-fills.
    async getLatestPolicySeq(network, originChain, tick){
        let rows = await this.doQuery(
            "SELECT MAX(policy_seq) AS seq FROM policy_snapshots " +
            "WHERE network = ? AND origin_chain = ? AND tick = ? AND status = 'finalized'",
            [String(network || ''), String(originChain || ''), String(tick || '')]);
        if(!rows || rows.length === 0 || rows[0].seq == null) return 0;
        let n = Number(rows[0].seq);
        return Number.isFinite(n) ? n : 0;
    }

    // The finalized snapshot a follower would be equivocating against: our own row at
    // the same (network, origin_chain, tick, policy_seq), or null when we hold none.
    async getPolicySnapshotAtSeq(network, originChain, tick, policySeq){
        let rows = await this.doQuery(
            'SELECT snapshot_id, policy_hash, origin_block, snapshot_block, status FROM policy_snapshots ' +
            'WHERE network = ? AND origin_chain = ? AND tick = ? AND policy_seq = ? LIMIT 1',
            [String(network || ''), String(originChain || ''), String(tick || ''), Number(policySeq)]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Every (tick, src_chain, dest_chain) triple this hub has ever finalized on one
    // network. The policy poll derives its candidate (origin_chain, tick) pairs from it,
    // and the invariant read derives which chains hold a copy of a tick.
    //
    // Direction is NOT a column (base spec D19: it is derived from the chains, and every
    // canonical field is a byte-match obligation forever), so the caller resolves which
    // side of a triple is the origin rather than reading it here.
    async getBridgeTransferChainPairs(network){
        return await this.doQuery(
            'SELECT DISTINCT tick, src_chain, dest_chain FROM bridge_transfers ' +
            "WHERE network = ? AND status = 'finalized' ORDER BY tick, src_chain, dest_chain",
            [String(network || '')]);
    }

    // Finalized transfers whose effective_time has NOT passed yet: signed, mirrored, and
    // not applyable on any destination until the block loop's protocol time reaches the
    // stamp. They are the "signed but unapplied" half of the invariant's in-flight term.
    //
    // Amounts come back as the raw decimal strings the record carries. SQL SUM() would
    // coerce them through a float and silently lose the low digits of an 18-decimal
    // token, so the caller sums them with bcmath instead.
    async getInFlightBridgeTransfers(network, nowSeconds, tick){
        let args = [String(network || ''), Number(nowSeconds)];
        let sql = 'SELECT tick, dest_chain, amount FROM bridge_transfers ' +
                  "WHERE network = ? AND status = 'finalized' AND effective_time > ?";
        if(tick){ sql += ' AND tick = ?'; args.push(String(tick)); }
        return await this.doQuery(sql, args);
    }

    // True when this hub already holds a non-retracted record for a source leg, so the
    // poll does not re-propose a round for a transfer it has finalized. Keyed on
    // (src_chain, src_action_index), which is unique per source leg whatever the
    // snapshot_block the id folded in.
    async bridgeTransferExistsForSource(network, srcChain, srcActionIndex){
        let rows = await this.doQuery(
            'SELECT 1 FROM bridge_transfers WHERE network = ? AND src_chain = ? AND ' +
            "src_action_index = ? AND status <> 'retracted' LIMIT 1",
            [String(network || ''), String(srcChain || ''), Number(srcActionIndex)]);
        return !!(rows && rows.length);
    }

    // The transfer_id of this hub's persisted, non-retracted record for one source leg, or
    // null when it holds none. A follower's _validateTransfer reads this rather than
    // bridgeTransferExistsForSource's boolean because it has to tell "this row IS the
    // persisted record" (same id, a legitimate re-validation) from "a record for this leg
    // already exists under a DIFFERENT id" (the duplicate-finalization shape: the same
    // source leg re-derives a new transfer_id at every snapshot_block, section 6).
    async getBridgeTransferIdForSource(network, srcChain, srcActionIndex){
        let rows = await this.doQuery(
            'SELECT transfer_id FROM bridge_transfers WHERE network = ? AND src_chain = ? AND ' +
            "src_action_index = ? AND status <> 'retracted' LIMIT 1",
            [String(network || ''), String(srcChain || ''), Number(srcActionIndex)]);
        return (rows && rows.length) ? String(rows[0].transfer_id) : null;
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
