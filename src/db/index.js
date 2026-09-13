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
 * The per-table queries live in one mixin per table family beside this file, and
 * installMixins() puts them on Database.prototype at load time, so every caller
 * keeps writing db.<method>() and no call site knows which file a query is in.
 *
 * The install uses Object.defineProperties with enumerable false, NOT the
 * Object.assign the style guide names. Class methods are non-enumerable, so an
 * assigned mixin would be the only prototype member that for...in and
 * Object.keys(Database.prototype) can see: the split would change what the
 * prototype enumerates, which is behaviour, not layout. writable and
 * configurable stay true so a test can still stub and restore a moved method.
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
const ark     = require('../anchor_reward_key.js');

// One mixin per table family, each an object of methods installed on
// Database.prototype below. A family's file is named for the src/sql DDL it owns.
const MIXINS = [
    require('./anchor.js'),
    require('./attestation.js'),
    require('./bridge_transfers.js'),
    require('./capability_snapshots.js'),
    require('./configs.js'),
    require('./consensus_state.js'),
    require('./cross_chain.js'),
    require('./governance.js'),
    require('./oracle.js'),
    require('./p2p_peers.js'),
    require('./policy_snapshots.js'),
    require('./prices.js'),
    require('./reorg_attestations.js'),
    require('./slash_proposals.js'),
    require('./state_checkpoints.js'),
    require('./swap_records.js'),
    require('./telemetry_pings.js'),
    require('./validators.js')
];

const DB_NAME_REGEX = /^[A-Za-z0-9_]+$/;

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
// Two separate defects meet on this line. First, the safety net above must
// leave Dates alone: JSON.stringify(new Date()) is a QUOTED ISO string and
// MariaDB rejects it with errno 1292 "Incorrect datetime value", so EVERY product
// write binding a Date would fail outright - Governance.propose() could not record
// a proposal at all - and the unit tier cannot see it because it stubs doQuery.
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
        // The DDL stays at src/sql/ while this file lives in src/db/, so every read
        // of it climbs one directory out of the db home.
        let dir   = path.join(__dirname, '..', 'sql');
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
        // The mirror admission columns (spec §5.5, C28, C35). A JS helper and NOT a dated
        // .sql, because this repo HAS no dated-.sql runner: the two files under
        // xchain-hub/migrations/ are applied by hand, so a migration copied from the
        // indexer's style would sit there and never run on a single deployed hub.
        await this._migrateAdmissionColumns();
    }

    // Add the per-chain admission height columns to every mirrored table that carries one.
    //
    // The column set per table is the row's measured READ SET, not a uniform three: attest
    // responses and anchor-reward attestations are read on BTC alone by the indexer's own
    // call-site guard, so a second column there would be a column nothing could ever set.
    //
    // Every column is nullable with no default, per C28 and the one mirror .sql that is
    // byte-identical across both repos (attestation_responses.request_block_index). NULL is
    // the legacy row and binds by effective_time at every height, so an existing row needs
    // no backfill and a node that has not crossed the flag day is byte-identical to today.
    // No index: the barrier compares a per-table watermark, not this column, and the
    // consuming selects already have their own covering keys.
    async _migrateAdmissionColumns(){
        const TABLES = {
            cross_chain_matches:        ['btc', 'ltc', 'doge'],
            cross_chain_calls:          ['btc', 'ltc', 'doge'],
            bridge_transfers:           ['btc', 'ltc', 'doge'],
            policy_snapshots:           ['btc', 'ltc', 'doge'],
            price_snapshots:            ['btc', 'ltc', 'doge'],
            attestation_responses:      ['btc'],
            anchor_reward_attestations: ['btc'],
        };
        for(let table of Object.keys(TABLES))
            for(let chain of TABLES[table])
                await this._migrateAddNullableColumn(table, 'admit_block_' + chain, 'BIGINT UNSIGNED DEFAULT NULL');

        // oracle_prices takes ONE unqualified column, not the per-chain map. It is the only
        // unsigned rail: no signatures, no canonical, nothing to stamp a map into. Its height
        // is the PUBLISHING chain's, which source_chain already names, so the barrier certifies
        // it against heights[oracle_prices][source_chain] rather than against the reading
        // chain's own B, and every chain reads the row without needing an entry of its own.
        await this._migrateAddNullableColumn('oracle_prices', 'admit_block', 'BIGINT UNSIGNED DEFAULT NULL');
    }

    // Add one nullable column if the table exists and does not already carry it.
    //
    // Idempotent from information_schema, so it runs on every boot at the cost of one read
    // per column. A table with NO columns is one this node has not created yet; the CREATE
    // TABLE from src/sql covers it, so this returns rather than failing the boot.
    //
    // A failure is logged and swallowed, as _migrateColumnType's is and for the same
    // reason: runMigrations is one sequential pass, so a throw here takes every migration
    // after it and the hub boot down with it. The consequence of the column being absent is
    // bounded and stated: this hub cannot stamp admission heights, so above the activation
    // it refuses to finalize those rows rather than producing rows no verifier can rebuild.
    async _migrateAddNullableColumn(table, column, columnDef){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT column_name AS c FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ?",
                [this.dbName, table]
            );
            if(!rows || rows.length === 0) return;   // table not here yet; CREATE TABLE covers it
            for(let r of rows)
                if(String(r.c).toLowerCase() === String(column).toLowerCase()) return;   // already migrated
            await db.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + columnDef);
            console.log('Migration: added ' + table + '.' + column + ' ' + columnDef);
        } catch(e){
            console.error('MIGRATION FAILED: ' + table + '.' + column + ' is absent. Until it exists this hub ' +
                'cannot stamp an admission height for that table, so above the mirror admission activation it ' +
                'will REFUSE to finalize those rows. Run by hand: ALTER TABLE `' + table + '` ADD COLUMN `' +
                column + '` ' + columnDef, e);
        } finally {
            await db.release();
        }
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

    // Drop an index if it exists (idempotent). It retires an index that a
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
    // on already-migrated nodes. It rolls out new capability tiers without a
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
        // src/sql/ sits one level above the db home (see verifyTables).
        let dir     = path.join(__dirname, '..', 'sql');
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
        // src/sql/ sits one level above the db home (see verifyTables).
        const dir      = path.join(__dirname, '..', 'sql');
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

    // The fence's network scope, normalized the same way on the read and the write so a
    // HUB_NETWORK of '  Regtest ' keys the same row as 'regtest'. '' is the legacy/unset
    // bucket: a hub that does not know its own network writes there, and every reader folds
    // that bucket in (see getPriceIngestWatermark).
    static normalizeFenceNetwork(network){
        return typeof network === 'string' ? network.trim().toLowerCase() : '';
    }

    // ---------------------------------------------------------------------------
    // Bridge tables (the base bridge spec section 6, token spec section 5,
    // policy spec section 5). CrossChainBridgeEngine runs the rounds; the writes and
    // the invariant read live in db/bridge_transfers.js and db/policy_snapshots.js,
    // and the column lists stay here as statics so one place owns what the hub-DB
    // mirror carries to every indexer.
    // ---------------------------------------------------------------------------

    // Columns written for a finalized transfer record. `status` is left to its DDL
    // default ('finalized') and `id`/`created_at` are assigned by the table.
    static get BRIDGE_TRANSFER_COLUMNS(){
        return ['transfer_id', 'snapshot_block', 'network', 'src_chain', 'src_action_index',
                'src_address', 'dest_chain', 'dest_address', 'tick', 'decimals', 'amount',
                'effective_time', 'finalizing_view', 'validator_signatures', 'push_generation',
                // The admission map, one column per chain in the row's read set. Inside the
                // signed canonical, so it is written from `row` like every other signed
                // field. Placed BEFORE btc_chain_id because that one stays LAST by contract:
                // it is the only transport-only column and the write path's tests read it
                // off the end of the parameter list.
                'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
                'btc_chain_id'];
    }

    // Columns written for a finalized policy snapshot.
    static get POLICY_SNAPSHOT_COLUMNS(){
        return ['snapshot_id', 'snapshot_block', 'origin_chain', 'tick', 'policy_seq',
                'origin_block', 'policy_hash', 'allow_list', 'block_list', 'sleeping',
                'effective_time', 'network', 'finalizing_view', 'validator_signatures',
                'push_generation',
                // Every federation chain, because a policy snapshot's consuming select
                // carries no chain clause: see the note in src/sql/policy_snapshots.sql.
                // Before btc_chain_id, which stays LAST by contract (see the transfer list).
                'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
                'btc_chain_id'];
    }

    async close(){
        await this.pool.end();
    }
}

// Install one mixin's methods on the prototype, non-enumerably.
//
// enumerable false keeps a moved method indistinguishable from one still declared in
// the class above, so for...in and Object.keys(Database.prototype) report exactly what
// they reported before the split; writable and configurable true keep a test able to
// stub a method and restore it. A name already on the prototype throws rather than
// overwriting: two families claiming one method name is a collision the loader must
// name at boot, not a silent last-mixin-wins.
function installMixins(target, mixins){
    for(const mixin of mixins){
        const descriptors = {};
        for(const name of Object.keys(mixin)){
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate database method: ' + name + ' is already defined on ' +
                    'Database.prototype. Two db mixins, or a mixin and the class, claim the same name.');
            descriptors[name] = { value: mixin[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installMixins(Database.prototype, MIXINS);

module.exports = Database;
