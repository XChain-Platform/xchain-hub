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
const test = require('node:test');

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
    const out = {
        apply: false,
        remove: undefined,
        network: undefined,
        selfTest: false,
        help: false
    };
    for(let i = 0; i < argv.length; i++){
        const arg = argv[i];
        if(arg === '--apply') out.apply = true;
        else if(arg === '--remove'){
            if(out.remove !== undefined) throw new CliUsageError('--remove may be given only once');
            out.remove = argv[++i];
            if(out.remove === undefined) throw new CliUsageError('Missing value for --remove');
        }
        else if(arg === '--self-test') out.selfTest = true;
        else if(arg === '--help' || arg === '-h') out.help = true;
        else if(arg === '--network'){
            if(out.network !== undefined) throw new CliUsageError('--network may be given only once');
            out.network = argv[++i];
            if(out.network === undefined) throw new CliUsageError('Missing value for --network');
        } else throw new CliUsageError('Unknown argument: ' + arg);
    }
    if(out.apply && out.remove !== undefined)
        throw new CliUsageError('--apply and --remove are mutually exclusive');
    if(out.selfTest && (out.apply || out.remove !== undefined ||
        out.network !== undefined || out.help))
        throw new CliUsageError('--self-test may not be combined with other options');
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
        '  --self-test          Run the cleanup acceptance unit tests.',
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

function connectionOptions(env = process.env){
    if(!env.HUB_DB_HOST) throw new Error('Missing required env var HUB_DB_HOST');
    if(!env.HUB_DB_PORT) throw new Error('Missing required env var HUB_DB_PORT');
    if(!env.HUB_DB_NAME) throw new Error('Missing required env var HUB_DB_NAME');
    if(!env.HUB_DB_USER) throw new Error('Missing required env var HUB_DB_USER');
    const secret = env.HUB_DB_SECRET;
    if(!secret) throw new Error('Missing required env var HUB_DB_SECRET');
    return {
        host: env.HUB_DB_HOST,
        port: env.HUB_DB_PORT,
        name: env.HUB_DB_NAME,
        user: env.HUB_DB_USER,
        secret
    };
}

async function main(argv = process.argv.slice(2), env = process.env,
    DatabaseClass = Database, log = console.log){
    const args = parseArgs(argv);
    if(args.help){ usage(); return 0; }
    if(args.selfTest){ await runUnitTests(); return 0; }

    const network = seed.assertSeedableNetwork(env.HUB_NETWORK);
    if(args.network !== undefined && args.network !== network)
        throw new seed.SeedNetworkError(args.network);

    const options = connectionOptions(env);
    const db = new DatabaseClass(
        options.host, options.port, options.name, options.user, options.secret);
    try {
        if(args.remove !== undefined){
            await removeSeededResponse(db, network, args.remove);
            log('request_id: ' + args.remove);
            log('mode: REMOVE');
            return 0;
        }
        const row = await seed.seedUndeliveredResponse(db, { network, apply: args.apply });
        log('request_id: ' + row.request_id);
        log('dashboard_rule_key: attestation-mirror:undelivered:' + network + ':' + row.request_id);
        log(args.apply ? 'mode: APPLY' : 'mode: DRY RUN');
    } finally {
        await db.close();
    }
    return 0;
}

async function runUnitTests(){
    const rows = [];
    let databaseConstructions = 0;

    class FakeDatabase {
        constructor(){ databaseConstructions++; }

        async getAttestationResponseMirrorRow(network, requestId, effectiveTime){
            return rows.filter(row => row.network === network &&
                row.request_id === requestId && row.effective_time === effectiveTime);
        }

        async createAttestationResponseMirrorRow(row){
            rows.push(row);
            return { affectedRows: 1 };
        }

        async doQuery(sql, args){
            check(sql.startsWith('DELETE FROM attestation_responses '),
                'cleanup must delete from attestation_responses');
            const [network, requestId, providerId, responsePayload, meta] = args;
            const index = rows.findIndex(row => row.network === network &&
                row.request_id === requestId && row.provider_id === providerId &&
                row.response_payload === responsePayload && row.meta === meta);
            if(index === -1) return { affectedRows: 0 };
            rows.splice(index, 1);
            return { affectedRows: 1 };
        }

        async close(){}
    }

    const env = {
        HUB_NETWORK: 'regtest',
        HUB_DB_HOST: 'unused',
        HUB_DB_PORT: '3306',
        HUB_DB_NAME: 'unused',
        HUB_DB_USER: 'unused',
        HUB_DB_SECRET: 'unused'
    };
    const quiet = () => {};
    await test('--apply then --remove leaves no seeded row', async () => {
        await main(['--apply'], env, FakeDatabase, quiet);
        check(rows.length === 1, '--apply must create one row');
        const seededId = rows[0].request_id;
        await main(['--remove', seededId], env, FakeDatabase, quiet);
        check(rows.length === 0, '--remove must delete the seeded row');
    });

    await test('--remove refuses an id the tool did not seed', async () => {
        const foreignId = 'a'.repeat(64);
        rows.push({
            network: 'regtest',
            request_id: foreignId,
            provider_id: 'real_provider',
            response_payload: '{}',
            meta: '{}'
        });
        await expectRejection(
            () => main(['--remove', foreignId], env, FakeDatabase, quiet),
            SeedRemovalError);
        check(rows.length === 1, '--remove must preserve a row not seeded by this tool');
    });

    await test('--remove refuses on mainnet', async () => {
        const constructionsBeforeMainnet = databaseConstructions;
        await expectRejection(
            () => main(['--remove', 'b'.repeat(64)],
                Object.assign({}, env, { HUB_NETWORK: 'mainnet' }), FakeDatabase, quiet),
            seed.SeedNetworkError);
        check(databaseConstructions === constructionsBeforeMainnet,
            'mainnet refusal must happen before opening the database');
    });
}

function check(condition, message){
    if(!condition) throw new Error('Self-test failed: ' + message);
}

async function expectRejection(action, ErrorClass){
    try {
        await action();
    } catch(err){
        check(err instanceof ErrorClass,
            'expected ' + ErrorClass.name + ', received ' + (err && err.name));
        return;
    }
    throw new Error('Self-test failed: expected ' + ErrorClass.name);
}

if(require.main === module){
    main().then(code => { process.exitCode = code; }).catch(err => {
        console.error('seed-undelivered-attestation-response: ' +
            (err && err.message ? err.message : err));
        const refused = err && (err.name === 'SeedNetworkError' ||
            err.name === 'SeedCollisionError' || err.name === 'SeedRemovalError' ||
            err.name === 'CliUsageError');
        process.exitCode = refused ? 2 : 1;
    });
}

module.exports = {
    CliUsageError,
    SeedRemovalError,
    main,
    parseArgs,
    removeSeededResponse,
    runUnitTests
};
