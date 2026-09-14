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
 * The class's own plumbing is split the same way and installed by the same call:
 * schema/bootstrap.js brings the database and its tables up, schema/keys.js and
 * schema/columns.js hold the migration helpers, and schema/migrations.js holds the
 * step list runMigrations() below walks. What stays here is what the style guide
 * says lives in this file: the constructor, the pool, the migration entry point and
 * the query plumbing every mixin method calls.
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
const ark     = require('../anchor/anchor_reward_key.js');

// One mixin per table family, each an object of methods installed on
// Database.prototype below. A family's file is named for the src/sql DDL it owns.
// Each is required here at the top of the module, one const per family, and the
// literal MIXINS list below is what installMixins() iterates. The list is spelled
// out rather than read off the directory so a missing or extra family is a visible
// diff; db_prototype_install.test.js fails if a file here is never listed.
const anchorMixin              = require('./anchor.js');
const attestationMixin         = require('./attestation.js');
const bridgeTransfersMixin     = require('./bridge_transfers.js');
const capabilitySnapshotsMixin = require('./capability_snapshots.js');
const configsMixin             = require('./configs.js');
const consensusStateMixin      = require('./consensus_state.js');
const crossChainMixin          = require('./cross_chain.js');
const governanceMixin          = require('./governance.js');
const oracleMixin              = require('./oracle.js');
const p2pPeersMixin            = require('./p2p_peers.js');
const policySnapshotsMixin     = require('./policy_snapshots.js');
const pricesMixin              = require('./prices.js');
const reorgAttestationsMixin   = require('./reorg_attestations.js');
const slashProposalsMixin      = require('./slash_proposals.js');
const stateCheckpointsMixin    = require('./state_checkpoints.js');
const swapRecordsMixin         = require('./swap_records.js');
const telemetryPingsMixin      = require('./telemetry_pings.js');
const validatorsMixin          = require('./validators.js');
// The class's own plumbing, split out of this file by behaviour and installed the
// same way, non-enumerably, by the same installMixins() below. These are NOT table
// families: they are bring-up, the two migration-helper families and the step list
// runMigrations() walks, so they live under schema/ rather than beside the family
// files, where db_prototype_install.test.js and the test/helpers/mockHub scanner
// both read a bare `<family>.js` and would otherwise take a plumbing method for a
// query. Bootstrap reads the driver, fs and the SQL directory off Database.io below
// rather than requiring them, because it is the only one that reaches outside the
// process and a require there would escape the unit suite's proxyquire stubs.
const bootstrapMixin        = require('./schema/bootstrap.js');
const keyMigrationsMixin    = require('./schema/keys.js');
const columnMigrationsMixin = require('./schema/columns.js');
const migrationStepsMixin   = require('./schema/migrations.js');
const mirrorColumns         = require('./schema/mirror_columns.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const hubConfig = require('../config');
const logger = getLogger();

// The DDL lives at src/sql/, one level above this db home. Resolved here, against
// THIS file, because schema/bootstrap.js sits one directory deeper and a path built
// there would climb out of the wrong directory.
const SQL_DIR = path.join(__dirname, '..', 'sql');

const MIXINS = [
    anchorMixin,
    attestationMixin,
    bridgeTransfersMixin,
    capabilitySnapshotsMixin,
    configsMixin,
    consensusStateMixin,
    crossChainMixin,
    governanceMixin,
    oracleMixin,
    p2pPeersMixin,
    policySnapshotsMixin,
    pricesMixin,
    reorgAttestationsMixin,
    slashProposalsMixin,
    stateCheckpointsMixin,
    swapRecordsMixin,
    telemetryPingsMixin,
    validatorsMixin
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
            connectTimeout:     parseInt(hubConfig.DB_CONNECT_TIMEOUT) || 10000,
            acquireTimeout:     parseInt(hubConfig.DB_ACQUIRE_TIMEOUT) || 10000,
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
            queryTimeout:       parseInt(hubConfig.DB_QUERY_TIMEOUT) || 30000
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
    failFastIfFatal(e, action){
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

    // Idempotent: safe to run every startup.
    //
    // The steps themselves are the three lists in schema/migrations.js, awaited here
    // in the order they ran when they were one method: reward and submission keys,
    // then the capability ENUM and the checkpoint/snapshot keys, then the column
    // conversions, the price fence re-key and the admission columns. Splitting the
    // list never reorders it, so a hub applies exactly the statements it applied
    // before, in the same sequence.
    async runMigrations(){
        await this.runRewardKeyMigrations();
        await this.runCapabilityAndCheckpointMigrations();
        await this.runColumnAndFenceMigrations();
    }

    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;

        if(this.circuitState === 'open'){
            if(Date.now() < this.circuitOpenUntil)
                throw new Error('Circuit breaker open: database connections rejected until cooldown expires');
            this.circuitState = 'half-open';
            logger.info('Circuit breaker half-open: attempting reconnection');
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
                    logger.info('Circuit breaker closed: database connection restored');
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
                logger.info("Can't connect to MariaDB. Retrying in " + (delay + jitter) + 'ms... (' + attempts + '/' + maxAttempts + ')');
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
                        logger.warn('db.doQuery: object arg serialized to JSON at index ' + i);
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
                logger.error(nodeUtil.format('Error running database query:', error));
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

    // The column lists the hub-DB mirror carries, kept as the statics the two write
    // paths already read through this.constructor. The lists themselves, and the
    // ordering contract stated with them, live in schema/mirror_columns.js; slice()
    // because each read has always handed the caller an array of its own.
    static get BRIDGE_TRANSFER_COLUMNS(){
        return mirrorColumns.BRIDGE_TRANSFER_COLUMNS.slice();
    }

    static get POLICY_SNAPSHOT_COLUMNS(){
        return mirrorColumns.POLICY_SNAPSHOT_COLUMNS.slice();
    }

    async close(){
        await this.pool.end();
    }
}

// What schema/bootstrap.js reaches the outside world through. Set on the class, not
// required in that file, so a proxyquire load of THIS module hands the bring-up
// methods the same stubbed driver and filesystem it hands the constructor.
Database.io = { mariadb, fs, sqlDir: SQL_DIR };

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
// The plumbing mixins go on the same prototype by the same rules, so a moved
// bring-up or migration method is as indistinguishable from a class method as a
// moved query is. Installed after the families, which only decides which side a
// name collision is reported from: either way installMixins throws at boot.
installMixins(Database.prototype, [
    bootstrapMixin,
    keyMigrationsMixin,
    columnMigrationsMixin,
    migrationStepsMixin
]);

module.exports = Database;
