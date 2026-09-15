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
 * XChain Hub - database and table BRING-UP, as a Database.prototype mixin.
 *
 * Everything that has to exist before a query can run: the database itself, the
 * tables read out of src/sql, and the column drift reconciliation each existing
 * table gets on the way past. src/db/index.js owns the pool and installs these
 * the same way it installs the table-family mixins, so `this` is the Database
 * and every method reads exactly the state it read as a class method.
 *
 * These are the only db methods that reach outside the process, and they take the
 * three things they need to do it - the driver, fs, and the src/sql directory
 * resolved against index.js rather than against this deeper file - off the class as
 * Database.io rather than requiring them here. The unit suite loads src/db through
 * proxyquire with mariadb and fs stubbed, and a proxyquire stub reaches only the
 * module that was proxyquired, so a require in this file would hand these methods
 * the REAL driver and the REAL filesystem inside a suite that believes it stubbed
 * both. Reading them off the class keeps one binding per load of src/db/index.js,
 * whatever that load was given, which is the same reason db/prices/index.js reaches its
 * fence normalizer through this.constructor.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

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
    },

    async verifyDatabase(){
        const { mariadb } = this.constructor.io;
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
                this.failFastIfFatal(e, 'checking database existence');
                logger.info(nodeUtil.format('Database connection error:', e.code || 'unknown'));
                logger.info("Error checking if " + this.dbName + " exists. Trying again in 5 seconds...");
                await this._sleep(5000);
            }
        }
    },


    async createDatabase(){
        const { mariadb } = this.constructor.io;
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port,
            timezone: 'Z'   // same UTC pin as the pool, see connectionPoolParams
        };
        logger.info("Creating " + this.dbName + " database...");
        while(true){
            try {
                let db = await mariadb.createConnection(connectionParams);
                await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                return true;
            } catch(e){
                this.failFastIfFatal(e, 'creating the database');
                logger.info(nodeUtil.format("Database creation error:", e.code || 'unknown'));
                logger.info("Error creating " + this.dbName + ". Trying again in 5 seconds...");
                await this._sleep(5000);
            }
        }
    },


    async verifyTables(){
        // The DDL stays at src/sql/ while the db home is src/db/, so the directory is
        // resolved once in src/db/index.js and read off the class (see the header).
        const { fs, sqlDir } = this.constructor.io;
        let dir   = sqlDir;
        let files = fs.readdirSync(dir);
        let db    = await this.getConnection();
        // One summary line instead of a per-table pair; error paths below still
        // name the table, so a failure stays attributable.
        logger.info('Verifying database and tables...');
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
                    logger.error('Error verifying ' + table + ' table: ' + e);
                    throw e;
                }
            }
        }
        await db.release();
        logger.info('Database and tables verified (' + checked + ' tables, ' + created + ' created).');
        return true;
    },


    async _createTableFromFile(file){
        // src/sql/, resolved by src/db/index.js (see verifyTables).
        const { fs, sqlDir } = this.constructor.io;
        let dir     = sqlDir;
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
    },


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
    },


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
    },


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
        // src/sql/, resolved by src/db/index.js (see verifyTables).
        const { fs, sqlDir } = this.constructor.io;
        const dir      = sqlDir;
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
                    logger.info('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT (cannot backfill existing rows safely). Skipping; add manually.');
                    continue;
                }
                logger.info('Schema drift on ' + table + '.' + exp.name + ': column missing live. Adding column from SQL source.');
                await db.query('ALTER TABLE `' + table + '` ADD COLUMN ' + exp.definition);
                continue;
            }
            const liveIsNullable = cur.IS_NULLABLE === 'YES';
            if(!liveIsNullable && exp.nullable){
                logger.info('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL. Relaxing constraint.');
                await db.query('ALTER TABLE `' + table + '` MODIFY `' + exp.name + '` ' + cur.COLUMN_TYPE + ' NULL');
            }
        }
    },

};
