'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const remote = require('../../../src/cross_chain/remote_token_snapshots.js');
const queries = require('../../../src/db/snapshots/remote_token_snapshots.js');

const NETWORK = 'regtest';
const SNAPSHOT_BLOCK = 840000;

function offer(overrides){
    return Object.assign({
        action_index: 91,
        give_tick: 'ART',
        give_decimals: 0,
        give_owner: 'doge-owner-address',
        source: 'doge-owner-address'
    }, overrides || {});
}

function queryRecorder(result){
    const calls = [];
    const doQuery = async (...args) => {
        calls.push(args);
        return result;
    };
    doQuery.calls = calls;
    return doQuery;
}

function registerAgreementTests(){
    it('requires every follower fixture to reproduce the leader token claim exactly', function(){
        const leader = remote.buildRemoteTokenSnapshot(
            NETWORK, SNAPSHOT_BLOCK, 'DOGE', offer());
        const followerViews = [
            offer(),
            offer({ give_decimals: '0' }),
            offer({ source: 'different-holder' })
        ];

        assert.strictEqual(remote.remoteTokenRowShapeOk(leader), true);
        assert.strictEqual(
            followerViews.every(view => remote.remoteTokenProposalAgrees(leader, view)),
            true);
        assert.strictEqual(
            remote.remoteTokenProposalAgrees(leader, offer({ give_decimals: 8 })),
            false);
        assert.strictEqual(
            remote.remoteTokenProposalAgrees(leader, offer({ give_owner: 'other-owner' })),
            false);
        assert.strictEqual(
            remote.remoteTokenProposalAgrees(leader, offer({ action_index: 92 })),
            false);
    });

    it('binds view, chain, token precision, owner and observation to the signed bytes', function(){
        const row = remote.buildRemoteTokenSnapshot(
            NETWORK, SNAPSHOT_BLOCK, 'ltc', offer({
                action_index: 14,
                give_tick: 'USD',
                give_decimals: 6,
                give_owner: 'ltc-owner'
            }));

        assert.strictEqual(row.coin, 'LTC');
        assert.match(row.snapshot_id, /^[0-9a-f]{64}$/);
        assert.strictEqual(
            remote.canonicalRemoteTokenSnapshot(row, 3),
            'XREMOTE|' + row.snapshot_id +
            '|3|regtest|LTC|USD|6|ltc-owner|14|840000');

        for(const key of ['coin', 'tick', 'decimals', 'owner',
            'source_action_index', 'snapshot_block']){
            const changed = Object.assign({}, row);
            changed[key] = key === 'decimals' ? 7 : String(changed[key]) + 'x';
            assert.notStrictEqual(
                remote.deriveRemoteTokenSnapshotId(changed), row.snapshot_id, key);
        }
    });
}

function registerNormalizationTests(){
    it('deduplicates identical book observations and sorts rows canonically', function(){
        const rows = remote.remoteTokenRowsFromBooks(NETWORK, SNAPSHOT_BLOCK, {
            LTC: [offer({ action_index: 9, give_tick: 'ZED', give_decimals: 2,
                give_owner: 'z-owner' })],
            DOGE: [
                offer({ action_index: 7 }),
                offer({ action_index: 3 })
            ]
        });

        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(rows.map(row => [row.coin, row.tick, row.source_action_index]), [
            ['DOGE', 'ART', 3],
            ['LTC', 'ZED', 9]
        ]);
    });

    it('rejects incomplete and non-canonical observations', function(){
        assert.strictEqual(remote.buildRemoteTokenSnapshot(
            NETWORK, SNAPSHOT_BLOCK, 'DOGE', offer({ give_tick: '' })), null);
        assert.strictEqual(remote.buildRemoteTokenSnapshot(
            NETWORK, SNAPSHOT_BLOCK, 'DOGE', offer({ give_decimals: 19 })), null);
        assert.strictEqual(remote.buildRemoteTokenSnapshot(
            NETWORK, SNAPSHOT_BLOCK, 'DOGE', offer({ give_owner: '', source: '' })), null);

        const row = remote.buildRemoteTokenSnapshot(
            NETWORK, SNAPSHOT_BLOCK, 'DOGE', offer());
        assert.strictEqual(remote.remoteTokenRowShapeOk(
            Object.assign({}, row, { decimals: '00' })), false);
    });
}

function registerPersistenceTests(){
    it('stores the attested row and exposes deterministic mirror reads', async function(){
        const doQuery = queryRecorder({ affectedRows: 1 });
        const row = Object.assign(remote.buildRemoteTokenSnapshot(
            NETWORK, SNAPSHOT_BLOCK, 'DOGE', offer()), {
            finalizing_view: 2,
            validator_signatures: '[]',
            status: 'finalized'
        });

        await queries.insertRemoteTokenSnapshot.call({ doQuery }, row, 'btc-chain-id');
        assert.match(doQuery.calls[0][0],
            /^INSERT IGNORE INTO remote_token_snapshots/);
        assert.deepStrictEqual(doQuery.calls[0][1].slice(0, 8), [
            row.snapshot_id, SNAPSHOT_BLOCK, NETWORK, 'DOGE', 'ART', 0,
            'doge-owner-address', 91
        ]);
        assert.strictEqual(doQuery.calls[0][1].at(-1), 'btc-chain-id');

        doQuery.calls.length = 0;
        await queries.getLatestRemoteTokenSnapshot.call(
            { doQuery }, NETWORK, 'doge', 'ART');
        assert.match(doQuery.calls[0][0],
            /ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC LIMIT 1$/);
        assert.deepStrictEqual(doQuery.calls[0][1], [NETWORK, 'DOGE', 'ART']);
    });

    it('defines the mirror table with the attested token fields and pin index', function(){
        const sql = fs.readFileSync(path.join(
            __dirname, '..', '..', '..', 'src', 'sql',
            'remote_token_snapshots.sql'), 'utf8');
        for(const column of ['coin', 'tick', 'decimals', 'owner',
            'source_action_index', 'validator_signatures'])
            assert.match(sql, new RegExp('\\n\\s*' + column + '\\s+'));
        assert.match(sql,
            /CREATE INDEX pinned_remote_token ON remote_token_snapshots \(network, coin, tick, snapshot_block\)/);
    });
}

describe('remote token snapshots', function(){
    registerAgreementTests();
    registerNormalizationTests();
    registerPersistenceTests();
});
