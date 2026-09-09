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
 * XChain Hub - the retraction half of the ATTEST response batch:
 * `retractattestbatch` and AttestationResponseMirror.retractBatchLink
 * (the ATTEST response-mirror design, §6.3, frontier row 55).
 *
 * A reorg on the DOGE rail un-lands a batch, and the indexer that rolled it back
 * says so here. Two properties carry the whole design and are what this file
 * drives: the retraction CLEARS THE LINK AND NEVER DELETES A ROW (a signed mirror
 * row is legitimate whichever batch carried it, and on a chain-only node it is the
 * only copy there is), and it clears nothing unless the caller's batch identity
 * actually derives from the window it names.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const sinon  = require('sinon');
const { expect } = require('chai');

const AttestationResponseMirror = require('../../src/AttestationResponseMirror.js');
const ValidatorIdentity = require('../../src/ValidatorIdentity.js');
const abw = require('../../src/lib/attest_batch_wire.js');

const ANCHOR       = 941234;
const ACTION_INDEX = 55501;
const WINDOW_START = 1780000000;
const WINDOW_END   = 1780003600;
const NETWORK      = 'regtest';

// The mirror table with the four statements this path uses: the INSERT IGNORE and
// keyed select-back the receive half already needs, the window-scoped select the
// retraction reads its victims from, and the clearing UPDATE.
function makeDb(){
    let table = [], nextId = 1;
    let key = r => r.network + '|' + r.request_id + '|' + r.effective_time;
    return {
        table,
        row(rid){ return table.find(r => r.request_id === rid) || null; },
        async doQuery(sql, args){
            if(/^INSERT IGNORE INTO attestation_responses/i.test(sql)){
                let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                let row  = {};
                cols.forEach((c, i) => { row[c] = args[i]; });
                if(table.find(r => key(r) === key(row))) return { affectedRows: 0, insertId: 0 };
                row.id = nextId++;
                if(row.batch_action_index === undefined) row.batch_action_index = null;
                table.push(row);
                return { affectedRows: 1, insertId: row.id };
            }
            // The retraction's window-scoped read, matched before the keyed select-back
            // because both start with `SELECT id, `.
            if(/^SELECT id, network, request_id, effective_time FROM attestation_responses/i.test(sql)){
                let [network, actionIndex, from, to] = args;
                return table.filter(r => r.network === network &&
                                         r.batch_action_index === actionIndex &&
                                         Number(r.effective_time) >= from && Number(r.effective_time) < to)
                            .map(r => ({ id: r.id, network: r.network, request_id: r.request_id,
                                         effective_time: r.effective_time }));
            }
            if(/^SELECT id, .*FROM attestation_responses/i.test(sql)){
                let found = table.find(r => r.network === args[0] && r.request_id === args[1] &&
                                            String(r.effective_time) === String(args[2]));
                return found ? [Object.assign({}, found)] : [];
            }
            if(/^UPDATE attestation_responses SET batch_action_index = NULL/i.test(sql)){
                let [network, actionIndex, from, to] = args;
                let hit = table.filter(r => r.network === network &&
                                            r.batch_action_index === actionIndex &&
                                            Number(r.effective_time) >= from && Number(r.effective_time) < to);
                for(let r of hit) r.batch_action_index = null;
                return { affectedRows: hit.length };
            }
            if(/^UPDATE attestation_responses SET batch_action_index/i.test(sql)){
                let [actionIndex, network, rid, effective] = args;
                let found = table.find(r => r.network === network && r.request_id === rid &&
                                            String(r.effective_time) === String(effective) &&
                                            (r.batch_action_index === null || r.batch_action_index === undefined));
                if(!found) return { affectedRows: 0 };
                found.batch_action_index = actionIndex;
                return { affectedRows: 1 };
            }
            throw new Error('unexpected statement: ' + sql);
        }
    };
}

function makeRow(overrides){
    let body = 'the agreed body ' + Math.random();
    return Object.assign({
        network:              NETWORK,
        request_id:           crypto.randomBytes(32).toString('hex'),
        request_action_index: 4400,
        request_block_index:  120,
        provider_id:          'http_get',
        status:               'ok',
        response_payload:     body,
        response_hash:        crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
        meta:                 '200',
        effective_time:       1780000120,
        signer_pubkeys:       JSON.stringify(['aa'.repeat(32)]),
        signatures:           JSON.stringify([{ pubkey: 'aa'.repeat(32), sig: 'ee'.repeat(64) }]),
        widen:                0
    }, overrides || {});
}

function makeBatch(rows, signers, overrides){
    let header = Object.assign({
        network: NETWORK, window_start: WINDOW_START, window_end: WINDOW_END,
        row_count: rows.length, btc_block_height: ANCHOR, rows: rows
    }, overrides || {});
    let canonical = abw.buildAttestBatchCanonical(header);
    return Object.assign({}, header, {
        sigs: signers.map(s => ({ pubkey: s.getPubkeyHex().toLowerCase(), sig: s.sign(canonical) })),
        action_index: ACTION_INDEX, block_index: 700123, block_time: 1780004000, push_generation: 3
    });
}

// The retraction the indexer's rollback sends: the key AND the window it derives
// from, plus the action index the landing push carried.
function makeRetraction(overrides){
    let base = {
        network:      NETWORK,
        window_start: WINDOW_START,
        window_end:   WINDOW_END,
        action_index: ACTION_INDEX
    };
    let merged = Object.assign(base, overrides || {});
    if(merged.batch_key === undefined)
        merged.batch_key = abw.computeBatchKey({
            network: base.network, window_start: base.window_start, window_end: base.window_end });
    return merged;
}

function makeHub(opts){
    opts = opts || {};
    let signers = opts.signers || [];
    let snapshot = {
        validators: signers.map((s, i) => ({
            pubkey: s.getPubkeyHex().toLowerCase(),
            weight: '100', amount: '100', source: 'src' + i
        })),
        count: signers.length
    };
    return {
        network: NETWORK,
        db: opts.db || makeDb(),
        hubDbBroadcaster: { broadcastRow: sinon.stub() },
        capabilitySnapshot: {
            async getWeightSnapshot(){ return snapshot; },
            async getSnapshot(){ return snapshot; }
        },
        attestationBatchPublisher: { recordLandedWindow: sinon.stub().resolves() }
    };
}

function identities(n){
    let out = [];
    for(let i = 0; i < n; i++) out.push(new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
    return out;
}

describe('retractattestbatch: the hub retraction half', function () {

    afterEach(function () { sinon.restore(); });

    it('clears the link on every row the un-landed batch carried, and keeps the rows', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let rows = [makeRow({ effective_time: 1780000120 }), makeRow({ effective_time: 1780001200 })];

        await mirror.receiveValidatedBatch('DOGE', makeBatch(rows, signers));
        expect(hub.db.table.map(r => r.batch_action_index)).to.deep.equal([ACTION_INDEX, ACTION_INDEX]);
        hub.hubDbBroadcaster.broadcastRow.resetHistory();

        let result = await mirror.retractBatchLink('DOGE', makeRetraction());

        expect(result.accepted).to.equal(true);
        expect(result.cleared).to.equal(2);
        expect(hub.db.table.length, 'a retraction must never delete a mirror row').to.equal(2);
        expect(hub.db.table.map(r => r.batch_action_index)).to.deep.equal([null, null]);
        // The cleared link has to reach the consumer the way the set link did.
        expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(2);
        for(let call of hub.hubDbBroadcaster.broadcastRow.getCalls()){
            expect(call.args[0].table).to.equal('attestation_responses');
            expect(call.args[0].row.batch_action_index,
                'the re-broadcast must carry the CLEARED value, not the stale one').to.equal(null);
        }
    });

    it('refuses a batch key that does not derive from the window it names, and clears nothing', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let rows = [makeRow()];
        await mirror.receiveValidatedBatch('DOGE', makeBatch(rows, signers));
        hub.hubDbBroadcaster.broadcastRow.resetHistory();

        // A well-formed key for a DIFFERENT window: structurally perfect, and still not
        // the identity of the batch whose link this action index names.
        let foreignKey = abw.computeBatchKey({
            network: NETWORK, window_start: WINDOW_START - 3600, window_end: WINDOW_END - 3600 });
        let result = await mirror.retractBatchLink('DOGE', makeRetraction({ batch_key: foreignKey }));

        expect(result.accepted).to.equal(false);
        expect(result.cleared).to.equal(0);
        expect(hub.db.table[0].batch_action_index,
            'a retraction that cannot name the batch must leave the link alone').to.equal(ACTION_INDEX);
        expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(0);
    });

    it('leaves a link stamped by the same action index but outside the named window', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let inside  = makeRow({ effective_time: WINDOW_END - 1 });
        // The window is half-open, so a row at the boundary belongs to the NEXT window.
        let outside = makeRow({ effective_time: WINDOW_END });

        await mirror.receiveValidatedBatch('DOGE', makeBatch([inside, outside], signers));
        expect(hub.db.table.every(r => r.batch_action_index === ACTION_INDEX)).to.equal(true);

        let result = await mirror.retractBatchLink('DOGE', makeRetraction());

        expect(result.cleared).to.equal(1);
        expect(hub.db.row(inside.request_id).batch_action_index).to.equal(null);
        expect(hub.db.row(outside.request_id).batch_action_index).to.equal(ACTION_INDEX);
    });

    it('is an accepted no-op when nothing is linked, so a replayed retraction never parks', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        await mirror.receiveValidatedBatch('DOGE', makeBatch([makeRow()], signers));

        let first  = await mirror.retractBatchLink('DOGE', makeRetraction());
        hub.hubDbBroadcaster.broadcastRow.resetHistory();
        let second = await mirror.retractBatchLink('DOGE', makeRetraction());

        expect(first.cleared).to.equal(1);
        // Accepted, not rejected: the indexer's durable retraction row is uncapped, so a
        // rejection here would be retried until the end of time.
        expect(second.accepted).to.equal(true);
        expect(second.cleared).to.equal(0);
        expect(second.reason).to.equal(null);
        expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(0);
    });

    it('lets the batch re-land after the retraction, which is why the link is cleared and not the row', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let rows = [makeRow()];

        await mirror.receiveValidatedBatch('DOGE', makeBatch(rows, signers));
        await mirror.retractBatchLink('DOGE', makeRetraction());
        expect(hub.db.table[0].batch_action_index).to.equal(null);

        // The reorg's replay re-mines the batch, which lands at a new action index.
        let relanded = Object.assign(makeBatch(rows, signers), { action_index: ACTION_INDEX + 40 });
        let result = await mirror.receiveValidatedBatch('DOGE', relanded);

        expect(result.linked, 'the set-once link only re-arms because the retraction NULLed it').to.equal(1);
        expect(hub.db.table.length).to.equal(1);
        expect(hub.db.table[0].batch_action_index).to.equal(ACTION_INDEX + 40);
    });

    it('refuses a retraction for another network, and one with no usable identity', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        await mirror.receiveValidatedBatch('DOGE', makeBatch([makeRow()], signers));

        let foreign = await mirror.retractBatchLink('DOGE', makeRetraction({ network: 'testnet' }));
        expect(foreign.accepted).to.equal(false);

        let noKey = await mirror.retractBatchLink('DOGE', makeRetraction({ batch_key: 'nothex' }));
        expect(noKey.accepted).to.equal(false);
        expect(noKey.reason).to.match(/^invalid/);

        // action_index 0 is a REAL index, so only a missing one is refused; the coercion
        // trap the receive half documents applies identically here.
        let noIndex = await mirror.retractBatchLink('DOGE', makeRetraction({ action_index: '' }));
        expect(noIndex.accepted).to.equal(false);

        let badWindow = await mirror.retractBatchLink('DOGE',
            makeRetraction({ window_start: WINDOW_END, window_end: WINDOW_START }));
        expect(badWindow.accepted).to.equal(false);

        expect(hub.db.table[0].batch_action_index,
            'no refusal may clear anything').to.equal(ACTION_INDEX);
    });
});
