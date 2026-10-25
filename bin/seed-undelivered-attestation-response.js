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
 **********************************************************************/

const Database = require('../src/db');
const seed = require('../src/attestation/response_mirror/seed_undelivered.js');

const SEED_PROVIDER_ID = 'seed_probe';
const SEED_RESPONSE_PAYLOAD = JSON.stringify({ seeded: true });
const SEED_META = JSON.stringify({ seeded: 'hub-seed-undelivered' });

class CliUsageError extends Error {
    constructor(message){
        super(message);
        this.name = 'CliUsageError';
    }
}

class SeedRemovalError extends Error {
    constructor(requestId){
        super('Refusing to remove an attestation response not seeded by this tool for request_id ' + requestId);
        this.name = 'SeedRemovalError';
    }
}

function parseArgs(argv){
    const out = { apply: false, remove: undefined, network: undefined, help: false };
    for(let i = 0; i < argv.length; i++){
        const arg = argv[i];
        if(arg === '--apply') out.apply = true;
        else if(arg === '--remove'){
            if(out.remove !== undefined) throw new CliUsageError('--remove may be given only once');
            out.remove = argv[++i];
            if(out.remove === undefined) throw new CliUsageError('Missing value for --remove');
        }
        else if(arg === '--help' || arg === '-h') out.help = true;
        else if(arg === '--network'){
            if(out.network !== undefined) throw new CliUsageError('--network may be given only once');
            out.network = argv[++i];
            if(out.network === undefined) throw new CliUsageError('Missing value for --network');
        } else throw new CliUsageError('Unknown argument: ' + arg);
    }
    if(out.apply && out.remove !== undefined)
        throw new CliUsageError('--apply and --remove are mutually exclusive');
    if(out.remove !== undefined && !/^[0-9a-f]{64}$/.test(out.remove))
        throw new CliUsageError('--remove requires a 64-character lower-case hex request_id');
    return out;
}

function usage(){
    console.log([
        'Seed one undelivered attestation response on testnet or regtest.',
        '',
        '  --network <network>  Optional cross-check against HUB_NETWORK.',
        '  --apply              Insert the row. The default is a dry run.',
        '  --remove <request_id> Delete a row previously inserted by this tool.',
        '',
        'Connection: HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, HUB_DB_USER, HUB_DB_SECRET.'
    ].join('\n'));
}

async function removeSeededResponse(db, network, requestId){
    seed.assertSeedableNetwork(network);
    const result = await db.doQuery(
        'DELETE FROM attestation_responses ' +
        'WHERE network = ? AND request_id = ? AND provider_id = ? ' +
        'AND response_payload = ? AND meta = ? LIMIT 1',
        [network, requestId, SEED_PROVIDER_ID, SEED_RESPONSE_PAYLOAD, SEED_META]);
    if(!result || result.affectedRows !== 1) throw new SeedRemovalError(requestId);
}

function connectionOptions(){
    if(!process.env.HUB_DB_HOST) throw new Error('Missing required env var HUB_DB_HOST');
    if(!process.env.HUB_DB_PORT) throw new Error('Missing required env var HUB_DB_PORT');
    if(!process.env.HUB_DB_NAME) throw new Error('Missing required env var HUB_DB_NAME');
    if(!process.env.HUB_DB_USER) throw new Error('Missing required env var HUB_DB_USER');
    const secret = process.env.HUB_DB_SECRET;
    if(!secret) throw new Error('Missing required env var HUB_DB_SECRET');
    return {
        host: process.env.HUB_DB_HOST,
        port: process.env.HUB_DB_PORT,
        name: process.env.HUB_DB_NAME,
        user: process.env.HUB_DB_USER,
        secret
    };
}

async function main(){
    const args = parseArgs(process.argv.slice(2));
    if(args.help){ usage(); return 0; }

    const network = seed.assertSeedableNetwork(process.env.HUB_NETWORK);
    if(args.network !== undefined && args.network !== network)
        throw new seed.SeedNetworkError(args.network);

    const options = connectionOptions();
    const db = new Database(options.host, options.port, options.name, options.user, options.secret);
    try {
        if(args.remove !== undefined){
            await removeSeededResponse(db, network, args.remove);
            console.log('request_id: ' + args.remove);
            console.log('mode: REMOVE');
            return 0;
        }
        const row = await seed.seedUndeliveredResponse(db, { network, apply: args.apply });
        console.log('request_id: ' + row.request_id);
        console.log('dashboard_rule_key: attestation-mirror:undelivered:' + network + ':' + row.request_id);
        console.log(args.apply ? 'mode: APPLY' : 'mode: DRY RUN');
    } finally {
        await db.close();
    }
    return 0;
}

if(require.main === module){
    main().then(code => process.exit(code)).catch(err => {
        console.error('seed-undelivered-attestation-response: ' +
            (err && err.message ? err.message : err));
        const refused = err && (err.name === 'SeedNetworkError' ||
            err.name === 'SeedCollisionError' || err.name === 'SeedRemovalError' ||
            err.name === 'CliUsageError');
        process.exit(refused ? 2 : 1);
    });
}

module.exports = {
    CliUsageError,
    SeedRemovalError,
    main,
    parseArgs,
    removeSeededResponse
};
