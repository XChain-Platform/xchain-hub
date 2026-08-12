#!/usr/bin/env node
'use strict';

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
 * Operator tool: prune capability_snapshots rows left behind by a chain reset.
 * See src/lib/capability_snapshot_prune.js for why stale rows are dangerous
 * rather than merely untidy.
 *
 * Connection settings come from the hub's own env (HUB_DB_HOST / HUB_DB_PORT /
 * HUB_DB_NAME / HUB_DB_USER / HUB_DB_SECRET) so this runs with the same
 * credentials as the service; --db overrides the database name and may be
 * repeated to sweep a federation that keeps one DB per validator.
 *
 * Dry run by default. Nothing is deleted without --apply.
 *
 * Usage:
 *   node bin/prune-stale-capability-snapshots.js --from 131 --to 487
 *   node bin/prune-stale-capability-snapshots.js --from 131 --to 487 \
 *       --db XChain_Relay_Hub --db XChain_Relay_Hub_2 --capability cross_chain --apply
 *
 ********************************************************************/

const Database = require('../src/db.js');
const prune    = require('../src/lib/capability_snapshot_prune.js');
const { resolveSecretEnv } = require('../src/secret-env.js');

function parseArgs(argv){
    let out = { dbs: [], apply: false, from: undefined, to: undefined, capability: undefined,
                createdBefore: undefined, blocks: undefined, batchSize: undefined, help: false };
    for(let i = 0; i < argv.length; i++){
        let a = argv[i];
        let next = () => {
            let v = argv[++i];
            if(v === undefined) throw new Error('Missing value for ' + a);
            return v;
        };
        switch(a){
            case '--from':       out.from       = next(); break;
            case '--to':         out.to         = next(); break;
            case '--capability': out.capability = next(); break;
            case '--created-before': out.createdBefore = next(); break;
            case '--blocks':     out.blocks     = Number(next()); break;
            case '--db':         out.dbs.push(next());    break;
            case '--batch-size': out.batchSize  = Number(next()); break;
            case '--apply':      out.apply      = true;   break;
            case '-h':
            case '--help':       out.help       = true;   break;
            default:
                throw new Error('Unknown argument: ' + a);
        }
    }
    return out;
}

function usage(){
    console.log([
        'Prune stale capability_snapshots rows.',
        '',
        '  --from <block>        REQUIRED. First block of the dead range (inclusive).',
        '  --to <block>          Last block of the dead range (inclusive). Omit for open-ended.',
        '  --capability <name>   Restrict to one capability (e.g. cross_chain). Default: all.',
        '  --created-before <t>  Only rows written before this YYYY-MM-DD[ HH:MM:SS]. Use this',
        '                        once the live chain has re-mined through the dead range.',
        '  --blocks <n>          Dry run only: list up to n per-block groups with write times.',
        '  --db <name>           Database name; repeatable. Default: HUB_DB_NAME.',
        '  --batch-size <n>      Rows per DELETE statement. Default: ' + prune.DEFAULT_BATCH_SIZE + '.',
        '  --apply               Actually delete. Without it the run is a dry run.',
        '',
        'Connection: HUB_DB_HOST, HUB_DB_PORT, HUB_DB_USER, HUB_DB_SECRET (+ HUB_DB_NAME).'
    ].join('\n'));
}

function describe(summary){
    if(summary.total === 0) return '  no rows in range';
    let lines = ['  ' + summary.total + ' rows across ' + summary.blocks +
                 ' blocks (' + summary.minBlock + '-' + summary.maxBlock + ')'];
    for(let c of summary.byCapability)
        lines.push('    ' + c.capability + ': ' + c.rows + ' rows, blocks ' + c.minBlock + '-' + c.maxBlock +
                   ', written ' + fmt(c.minCreated) + ' .. ' + fmt(c.maxCreated));
    return lines.join('\n');
}

function fmt(t){
    if(!t) return '?';
    return (t instanceof Date) ? t.toISOString().replace('T', ' ').slice(0, 19) : String(t);
}

async function main(){
    let args = parseArgs(process.argv.slice(2));
    if(args.help){ usage(); return 0; }

    for(let v of ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_USER']){
        if(!process.env[v]) throw new Error('Missing required env var ' + v);
    }
    // Accepts the deprecated HUB_DB_PASS too; see src/secret-env.js.
    let dbSecret = resolveSecretEnv('HUB_DB_PASS');
    if(!dbSecret) throw new Error('Missing required env var HUB_DB_SECRET');

    let dbNames = args.dbs.length ? args.dbs : [process.env.HUB_DB_NAME];
    if(!dbNames[0]) throw new Error('No database given: pass --db or set HUB_DB_NAME');

    // Fail on a bad range before opening any connection.
    let opts = { fromBlock: args.from, toBlock: args.to, capability: args.capability,
                 createdBefore: args.createdBefore, batchSize: args.batchSize };
    let range = prune.normalizeRange(opts);

    console.log('Range: blocks ' + range.fromBlock + '-' +
                (range.toBlock === prune.MAX_BLOCK ? 'open' : range.toBlock) +
                ', capability ' + (range.capability || 'ALL') +
                ', written before ' + (range.createdBefore || 'ANY') +
                ', mode ' + (args.apply ? 'APPLY' : 'DRY RUN'));

    let leftover = 0;
    for(let name of dbNames){
        let db = new Database(process.env.HUB_DB_HOST, process.env.HUB_DB_PORT, name,
                              process.env.HUB_DB_USER, dbSecret);
        try {
            let before = await prune.summarizeStale(db, opts);
            console.log(name + ': before');
            console.log(describe(before));

            if(!args.apply && args.blocks){
                for(let b of await prune.listStaleBlocks(db, opts, args.blocks))
                    console.log('    block ' + b.snapshotBlock + ' ' + b.capability + ': ' + b.rows +
                                ' rows, written ' + fmt(b.minCreated) + ' .. ' + fmt(b.maxCreated));
            }

            if(args.apply){
                let res = await prune.pruneStale(db, opts);
                console.log(name + ': deleted ' + res.deleted + ' rows in ' + res.batches +
                            ' batch(es), remaining in range ' + res.remaining);
                leftover += res.remaining;
            } else {
                leftover += before.total;
            }
        } finally {
            await db.close();
        }
    }

    if(args.apply && leftover > 0){
        console.error('FAILED: ' + leftover + ' stale rows still in range after prune');
        return 2;
    }
    if(!args.apply)
        console.log('Dry run only. Re-run with --apply to delete.');
    return 0;
}

main().then(code => process.exit(code)).catch(err => {
    // Never echo the connection object; it carries the DB password.
    console.error('prune-stale-capability-snapshots: ' + (err && err.message ? err.message : err));
    process.exit(1);
});
