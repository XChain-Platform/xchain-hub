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
 * XChain Hub - the receive half of the ATTEST response batch: the
 * `pushattestbatch` method and AttestationResponseMirror.receiveValidatedBatch
 * (the ATTEST response-mirror design, §6.3, decisions D72 and D78).
 *
 * This is the chain-only rebuild road. A batch that landed on the DOGE rail is
 * parsed by the indexer and pushed back here, and the hub turns it into mirror rows
 * every BTC indexer then verifies for itself. Two things therefore have to hold and
 * are what this file drives: the batch quorum is RE-VERIFIED here against the hub's
 * own capability view (the pusher's local verdict is never trusted), and every
 * effect is idempotent, because a re-landed batch, a replayed push and a
 * push_generation retry all deliver the same body twice.
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

// ---------------------------------------------------------------------------
// The mirror table, with the three statements this path uses: INSERT IGNORE on the
// natural key, the keyed select-back, and the set-once link UPDATE.
// ---------------------------------------------------------------------------
function makeDb(){
    let table = [], nextId = 1, queries = [];
    return {
        table, queries,
        row(rid){ return table.find(r => r.request_id === rid) || null; },
        async doQuery(sql, args){
            queries.push({ sql, args });
            if(/^INSERT IGNORE INTO attestation_responses/i.test(sql)){
                let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                let row  = {};
                cols.forEach((c, i) => { row[c] = args[i]; });
                if(table.find(r => r.network === row.network && r.request_id === row.request_id))
                    return { affectedRows: 0, insertId: 0 };
                row.id = nextId++;
                table.push(row);
                return { affectedRows: 1, insertId: row.id };
            }
            if(/^SELECT id, .*FROM attestation_responses/i.test(sql)){
                let found = table.find(r => r.network === args[0] && r.request_id === args[1]);
                return found ? [Object.assign({}, found)] : [];
            }
            if(/^UPDATE attestation_responses SET batch_action_index/i.test(sql)){
                let [actionIndex, network, rid] = args;
                let found = table.find(r => r.network === network && r.request_id === rid &&
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
        network:              'regtest',
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

// A batch signed by `signers` over the canonical the wire carries, so the hub's own
// re-verification is exercised rather than stubbed out.
function makeBatch(rows, signers, overrides){
    let header = Object.assign({
        network: 'regtest', window_start: WINDOW_START, window_end: WINDOW_END,
        row_count: rows.length, btc_block_height: ANCHOR, rows: rows
    }, overrides || {});
    let canonical = abw.buildAttestBatchCanonical(header);
    return Object.assign({}, header, {
        sigs: signers.map(s => ({ pubkey: s.getPubkeyHex().toLowerCase(), sig: s.sign(canonical) })),
        action_index: ACTION_INDEX, block_index: 700123, block_time: 1780004000, push_generation: 3
    });
}

function makeHub(opts){
    opts = opts || {};
    let signers = opts.signers || [];
    let snapshot = {
        validators: signers.map((s, i) => ({
            pubkey: s.getPubkeyHex().toLowerCase(),
            weight: i === 0 ? '100' : '100', amount: '100', source: 'src' + i
        })),
        count: signers.length
    };
    if(opts.snapshotOverride) snapshot = opts.snapshotOverride;
    return {
        network: 'regtest',
        db: opts.db || makeDb(),
        hubDbBroadcaster: { broadcastRow: sinon.stub() },
        capabilitySnapshot: {
            async getWeightSnapshot(){ return snapshot; },
            async getSnapshot(){ return snapshot; }
        },
        attestationBatchPublisher: { recordLandedWindow: sinon.stub().resolves() }
    };
}

// Three signers, so two of them clear the strict 2/3 stake bar only when the third
// is present in the snapshot with a smaller weight; the helper above gives every
// member the same weight, so the suite signs with ALL of them.
function identities(n){
    let out = [];
    for(let i = 0; i < n; i++) out.push(new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
    return out;
}

describe('pushattestbatch: the hub receive half', function () {

    afterEach(function () { sinon.restore(); });

    it('inserts the rows a chain-only rebuild carries, and streams each one', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let rows = [makeRow(), makeRow()];

        let result = await mirror.receiveValidatedBatch('DOGE', makeBatch(rows, signers));

        expect(result.accepted).to.equal(true);
        expect(result.stored).to.equal(2);
        expect(result.linked).to.equal(2);
        expect(hub.db.table.length).to.equal(2);
        // Every insert is streamed with the id the table assigned, which is the cursor
        // the mirror consumer pages on.
        expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.be.at.least(2);
        for(let call of hub.hubDbBroadcaster.broadcastRow.getCalls())
            expect(call.args[0].row.id, 'a streamed row must carry its id').to.be.a('number');
    });

    it('sets batch_action_index once and re-broadcasts the row that got the link', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let row = makeRow();

        // The row is already held (the ordinary mirror case): the batch's job here is
        // only the link, and the re-broadcast that carries it to the consumer.
        await mirror.insertAndBroadcast(Object.assign({}, row, { finalized_at: 1780000200 }));
        hub.hubDbBroadcaster.broadcastRow.resetHistory();

        let result = await mirror.receiveValidatedBatch('DOGE', makeBatch([row], signers));

        expect(result.stored).to.equal(0);
        expect(result.duplicates).to.equal(1);
        expect(result.linked).to.equal(1);
        expect(hub.db.row(row.request_id).batch_action_index).to.equal(ACTION_INDEX);
        expect(hub.hubDbBroadcaster.broadcastRow.callCount,
            'the link must reach the consumer, and only a re-broadcast can carry it').to.equal(1);
    });

    it('is a no-op on replay, including a re-landed batch under a new action index', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let rows = [makeRow()];
        let batch = makeBatch(rows, signers);

        await mirror.receiveValidatedBatch('DOGE', batch);
        hub.hubDbBroadcaster.broadcastRow.resetHistory();

        // The identical push again (a retry), then the same rows under a LATER action
        // index (the same batch re-landing after a DOGE reorg): neither may move the
        // link, and neither may stream anything.
        let replay = await mirror.receiveValidatedBatch('DOGE', batch);
        let later  = await mirror.receiveValidatedBatch('DOGE',
            Object.assign({}, makeBatch(rows, signers), { action_index: ACTION_INDEX + 900 }));

        expect(replay.stored + later.stored).to.equal(0);
        expect(replay.linked + later.linked, 'the first batch to carry a row owns its link').to.equal(0);
        expect(hub.db.row(rows[0].request_id).batch_action_index).to.equal(ACTION_INDEX);
        expect(hub.hubDbBroadcaster.broadcastRow.callCount).to.equal(0);
    });

    it('REFUSES a batch whose quorum does not verify, storing nothing', async function () {
        let signers  = identities(2);
        let stranger = identities(1)[0];
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let rows = [makeRow()];

        // Signed by a key that holds no attestation capability at the anchor.
        let outsider = await mirror.receiveValidatedBatch('DOGE', makeBatch(rows, [stranger]));
        expect(outsider.accepted).to.equal(false);
        expect(outsider.reason).to.match(/stake|quorum/);

        // Signed honestly, then a row TAMPERED with after signing: the canonical the hub
        // rebuilds is not the one the set signed.
        let tampered = makeBatch(rows, signers);
        tampered.rows = [Object.assign({}, rows[0], { response_payload: 'rewritten' })];
        let bad = await mirror.receiveValidatedBatch('DOGE', tampered);
        expect(bad.accepted).to.equal(false);

        // A signature that is structurally fine but is not over these bytes.
        let forged = makeBatch(rows, signers);
        forged.sigs = forged.sigs.map(s => ({ pubkey: s.pubkey, sig: 'ab'.repeat(64) }));
        let forgedResult = await mirror.receiveValidatedBatch('DOGE', forged);
        expect(forgedResult.accepted).to.equal(false);

        expect(hub.db.table.length, 'a refused batch must store nothing').to.equal(0);
    });

    it('fails closed when no capability snapshot resolves at the anchor', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers, snapshotOverride: { validators: [], count: 0 } });
        let mirror = new AttestationResponseMirror(hub);

        let result = await mirror.receiveValidatedBatch('DOGE', makeBatch([makeRow()], signers));

        expect(result.accepted).to.equal(false);
        expect(result.reason).to.match(/no attestation capability snapshot/);
    });

    it('refuses a batch that is structurally not this hub\'s', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        let rows = [makeRow()];

        let foreign = await mirror.receiveValidatedBatch('DOGE',
            Object.assign(makeBatch(rows, signers), { network: 'testnet' }));
        expect(foreign.accepted).to.equal(false);

        let miscount = await mirror.receiveValidatedBatch('DOGE',
            Object.assign(makeBatch(rows, signers), { row_count: 9 }));
        expect(miscount.accepted).to.equal(false);

        let tooMany = await mirror.receiveValidatedBatch('DOGE',
            Object.assign(makeBatch(rows, signers),
                { rows: new Array(abw.ATTEST_BATCH_MAX_ROWS + 1).fill(makeRow()) }));
        expect(tooMany.accepted).to.equal(false);
        expect(tooMany.reason).to.equal('too many rows');

        let noAction = await mirror.receiveValidatedBatch('DOGE',
            Object.assign(makeBatch(rows, signers), { action_index: null }));
        expect(noAction.accepted).to.equal(false);

        expect(hub.db.table.length).to.equal(0);
    });

    it('records the window as landed so no hub pays to publish it again', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);

        await mirror.receiveValidatedBatch('DOGE', makeBatch([makeRow()], signers));

        let call = hub.attestationBatchPublisher.recordLandedWindow.getCall(0);
        expect(call, 'the landed window must reach the publisher').to.not.equal(null);
        expect(call.args[0]).to.equal(WINDOW_START);
        expect(call.args[1]).to.equal(WINDOW_END);
    });

    it('skips a carried row the structural gate rejects without losing the rest', async function () {
        let signers = identities(2);
        let hub = makeHub({ signers });
        let mirror = new AttestationResponseMirror(hub);
        // A row whose hash is not over its body is unusable on every node identically,
        // so it is skipped rather than stored; the batch's other row still lands.
        let junk = makeRow({ request_id: 'nothex' });
        let good = makeRow();

        let result = await mirror.receiveValidatedBatch('DOGE', makeBatch([junk, good], signers));

        expect(result.accepted).to.equal(true);
        expect(result.stored).to.equal(1);
        expect(result.rejected).to.equal(1);
        expect(hub.db.row(good.request_id)).to.not.equal(null);
    });
});
