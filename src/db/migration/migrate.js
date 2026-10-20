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
 * Operator path for the hub's dated migrations: applies the pending files under
 * src/sql/migrations, manual ones included, and records each in the ledger.
 *
 * A boot never runs a manual file; it baselines the ones the schema already
 * satisfies and logs the rest as PENDING with this command. Connection settings
 * come from the hub's own env (HUB_DB_HOST / HUB_DB_PORT / HUB_DB_NAME /
 * HUB_DB_USER / HUB_DB_SECRET), so this runs with the service's credentials.
 *
 * Usage:
 *   npm run migrate
 *   node src/db/migration/migrate.js --file 2026-10-19-oracle-prices-widen-tick.sql
 *
 * A file tagged `-- xchain:runbook` is a one-off script: this command skips it unless --file names it.
 *
 ********************************************************************/

'use strict';

const Database = require('../index.js');
const { resolveSecretEnv } = require('../../secret_env.js');
const hubConfig = require('../../config');

// Repeatable --file <name>; anything else is refused so a typo never runs everything.
function parseArgs(argv){
    const only = [];
    for(let i = 0; i < argv.length; i++){
        if(argv[i] === '--file' && argv[i + 1]){ only.push(argv[++i]); continue; }
        throw new Error('Unknown argument ' + argv[i] + '. Usage: migrate.js [--file <name>]...');
    }
    return { only: only.length > 0 ? only : null };
}

function connectionFromEnv(env){
    for(const name of ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER'])
        if(!env[name]) throw new Error('Missing required env var ' + name);
    const secret = resolveSecretEnv('HUB_DB_PASS', env);
    if(secret === undefined) throw new Error('Missing required env var HUB_DB_SECRET');
    return { host: env.HUB_DB_HOST, port: env.HUB_DB_PORT, name: env.HUB_DB_NAME, user: env.HUB_DB_USER, secret };
}

// Returns the process exit code: 0 when the run settled every file it examined,
// 1 when the lock was held elsewhere and nothing was examined.
async function main(argv, env = hubConfig.env(), DatabaseClass = Database){
    const args = parseArgs(argv);
    const c = connectionFromEnv(env);
    const db = new DatabaseClass(c.host, c.port, c.name, c.user, c.secret);
    try {
        const result = await db.runDatedMigrations({ includeManual: true, only: args.only });
        if(result.lockSkipped){
            console.error('Another process holds the migration lock; nothing was examined. Run again once it finishes.');
            return 1;
        }
        console.log('applied:   ' + (result.applied.join(', ') || 'none'));
        console.log('baselined: ' + (result.baselined.join(', ') || 'none'));
        console.log('pending:   ' + (result.pending.join(', ') || 'none'));
        return 0;
    } finally {
        await db.close();
    }
}

if(require.main === module){
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        console.error(err && err.message ? err.message : err);
        process.exit(1);
    });
}

module.exports = { main, parseArgs, connectionFromEnv };
