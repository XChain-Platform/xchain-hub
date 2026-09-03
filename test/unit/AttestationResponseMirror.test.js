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
 * XChain Hub - AttestationResponseMirror unit tests (the ATTEST response
 * mirror design, §3.2).
 *
 * Drives the producer side of the mirror: a finalized round at or above the
 * activation height becomes exactly one INSERT, one select-back and one
 * broadcast whose row carries the id the table assigned. The stubbed DB is a
 * tiny in-memory table rather than a pair of call-counting stubs, because the
 * two assertions that matter here (the broadcast carries the AUTO_INCREMENT
 * id, and a duplicate does not re-broadcast) are exactly the ones a stub
 * returning a canned row cannot fail.
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const crypto     = require('crypto');
const { expect } = require('chai');
const EventEmitter = require('events');

const AttestationResponseMirror = require('../../src/AttestationResponseMirror');

const PUB_A = 'aa'.repeat(32);
const PUB_B = 'bb'.repeat(32);
const RID   = '11'.repeat(32);

// ---------------------------------------------------------------------------
// A minimal stand-in for the hub's mariadb wrapper: enough of INSERT IGNORE and
// the keyed select-back to model AUTO_INCREMENT and the UNIQUE (network,
// request_id) the real table declares. Records every statement so the tests can
// assert the SHAPE of the traffic (one insert, one select) and not only its
// effect.
// ---------------------------------------------------------------------------
function makeDb(){
    let table   = [];
    let nextId  = 1;
    let queries = [];
    return {
        table:   table,
        queries: queries,
        inserts: () => queries.filter(q => /^INSERT/i.test(q.sql)),
        selects: () => queries.filter(q => /^SELECT/i.test(q.sql)),
        async doQuery(sql, args){
            queries.push({ sql: sql, args: args });
            if(/^INSERT IGNORE INTO attestation_responses/i.test(sql)){
                // Column order is taken from the statement itself, so a reordered
                // or short column list mis-binds here exactly as it would in SQL.
                let cols = sql.substring(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(s => s.trim());
                let row  = {};
                cols.forEach((c, i) => { row[c] = args[i]; });
                let clash = table.find(r => r.network === row.network && r.request_id === row.request_id);
                if(clash) return { affectedRows: 0, insertId: 0 };   // UNIQUE absorbed it
                row.id = nextId++;
                table.push(row);
                return { affectedRows: 1, insertId: row.id };
            }
            if(/^SELECT id, .*FROM attestation_responses/i.test(sql)){
                let found = table.find(r => r.network === args[0] && r.request_id === args[1]);
                return found ? [Object.assign({}, found)] : [];
            }
            throw new Error('unexpected statement: ' + sql);
        }
    };
}

function makeHub(overrides){
    overrides = overrides || {};
    let consensus = new EventEmitter();
    let hub = Object.assign({
        network:              'regtest',   // ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest === 0
        attestationConsensus: consensus,
        db:                   makeDb(),
        hubDbBroadcaster:     { broadcastRow: sinon.stub() }
    }, overrides);
    if(hub.attestationConsensus === consensus) hub._consensus = consensus;
    return hub;
}

// A finalized payload shaped exactly like AttestationConsensus._checkCommitQuorum
// emits: nested `request` and `signatures` are the round's own live objects, which
// is what the copy-before-await case below exploits.
function finalizedEvent(overrides){
    return Object.assign({
        requestId:     RID,
        request:       { block_index: 120, action_index: 4400, redundancy: 2 },
        providerId:    'http_get',
        responseBody:  Buffer.from('the agreed body', 'utf8'),
        meta:          '200',
        status:        'ok',
        signatures:    [{ pubkey: PUB_A, sig: 'ee'.repeat(64) }, { pubkey: PUB_B, sig: 'ff'.repeat(64) }],
        leaderPubkey:  PUB_A,
        role:          'leader',
        effectiveTime: 1770000120,
        widen:         1
    }, overrides || {});
}

// Let the handler's fire-and-forget promise chain settle.
function settle(){
    return new Promise(resolve => setImmediate(resolve));
}

describe('AttestationResponseMirror', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ── lifecycle ───────────────────────────────────────────────────────────

    describe('lifecycle', function () {
        it('attaches exactly one request:finalized listener in start() and detaches in stop()', async function () {
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();
            expect(hub._consensus.listenerCount('request:finalized')).to.equal(1);
            await m.stop();
            expect(hub._consensus.listenerCount('request:finalized')).to.equal(0);
        });

        it('a second start() does not attach a second listener', async function () {
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();
            await m.start();
            expect(hub._consensus.listenerCount('request:finalized')).to.equal(1);
        });

        it('starts as a no-op when there is no AttestationConsensus', async function () {
            let hub = makeHub({ attestationConsensus: null });
            let m   = new AttestationResponseMirror(hub);
            await m.start();
            await m.stop();
            expect(hub.db.queries).to.have.length(0);
        });
    });

    // ── the write path ──────────────────────────────────────────────────────

    describe('a finalized round at or above the activation height', function () {
        it('produces one INSERT, one select-back, and one broadcast carrying the selected id', async function () {
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            hub._consensus.emit('request:finalized', finalizedEvent());
            await settle();

            expect(hub.db.inserts()).to.have.length(1, 'exactly one INSERT');
            expect(hub.db.selects()).to.have.length(1, 'exactly one select-back');
            expect(hub.hubDbBroadcaster.broadcastRow.calledOnce).to.equal(true, 'exactly one broadcast');

            let event = hub.hubDbBroadcaster.broadcastRow.firstCall.args[0];
            expect(event.table).to.equal('attestation_responses');
            // THE SELECT-BACK ASSERTION. The id is assigned by the table, never by
            // the object the producer built, so a broadcast of the pre-insert row
            // carries no id at all and this fails.
            expect(event.row.id).to.equal(1);
            expect(event.row.id).to.equal(hub.db.table[0].id);
            expect(event.row.request_id).to.equal(RID);
        });

        it('writes every column the snapshot route selects, with the values the round signed', async function () {
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            let ev = finalizedEvent();
            hub._consensus.emit('request:finalized', ev);
            await settle();

            let row = hub.db.table[0];
            for(let col of AttestationResponseMirror.MIRROR_COLUMNS)
                expect(row, 'column ' + col + ' must be written').to.have.property(col);

            expect(row.network).to.equal('regtest');
            expect(row.request_id).to.equal(RID);
            expect(row.request_block_index).to.equal(120);
            expect(row.request_action_index).to.equal(4400);
            expect(row.provider_id).to.equal('http_get');
            expect(row.status).to.equal('ok');
            expect(row.response_payload).to.equal('the agreed body');
            expect(row.meta).to.equal('200');
            expect(row.widen).to.equal(1);
            // Copied from the event, never recomputed: it is inside the canonical
            // the responsible set signed.
            expect(row.effective_time).to.equal(1770000120);
            // The hash the canonical signs, over the body BYTES.
            expect(row.response_hash).to.equal(
                crypto.createHash('sha256').update(Buffer.from('the agreed body', 'utf8')).digest('hex'));
            expect(JSON.parse(row.signer_pubkeys)).to.deep.equal([PUB_A, PUB_B]);
            expect(JSON.parse(row.signatures)).to.deep.equal([
                { pubkey: PUB_A, sig: 'ee'.repeat(64) },
                { pubkey: PUB_B, sig: 'ff'.repeat(64) }
            ]);
            expect(Number.isFinite(Number(row.finalized_at))).to.equal(true);
        });
    });

    // ── the era gate ────────────────────────────────────────────────────────

    describe('below the activation height', function () {
        it('writes nothing and broadcasts nothing on an unratified network (testnet, null)', async function () {
            let hub = makeHub({ network: 'testnet' });
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            hub._consensus.emit('request:finalized', finalizedEvent({ request: { block_index: 999999 } }));
            await settle();

            expect(hub.db.queries).to.have.length(0, 'the legacy on-chain path owns this response');
            expect(hub.hubDbBroadcaster.broadcastRow.called).to.equal(false);
        });

        it('writes nothing on mainnet, where the entry is the inert null sentinel', async function () {
            let hub = makeHub({ network: 'mainnet' });
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            hub._consensus.emit('request:finalized', finalizedEvent({ request: { block_index: 999999 } }));
            await settle();

            expect(hub.db.queries).to.have.length(0);
            expect(hub.hubDbBroadcaster.broadcastRow.called).to.equal(false);
        });

        it('writes nothing when the request block is unparseable, matching the publisher gate exactly', async function () {
            // The publisher's D58 early return fails closed to "legacy", so the
            // mirror must fail closed the other way or an unparseable block would be
            // served by neither era and the response would be lost outright.
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            hub._consensus.emit('request:finalized', finalizedEvent({ request: { action_index: 1 } }));
            await settle();

            expect(hub.db.queries).to.have.length(0);
        });
    });

    // ── idempotence ─────────────────────────────────────────────────────────

    describe('a duplicate row', function () {
        it('does not broadcast again when INSERT IGNORE reports affectedRows 0', async function () {
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            hub._consensus.emit('request:finalized', finalizedEvent());
            await settle();
            hub._consensus.emit('request:finalized', finalizedEvent());
            await settle();

            expect(hub.db.inserts()).to.have.length(2, 'both deliveries attempt the write');
            expect(hub.db.table).to.have.length(1, 'the UNIQUE absorbed the second');
            expect(hub.hubDbBroadcaster.broadcastRow.calledOnce).to.equal(true,
                're-emitting a row this hub already streamed is not a row:inserted delta');
            expect(m.stats.written).to.equal(1);
            expect(m.stats.duplicates).to.equal(1);
        });

        it('still selects the row back on the duplicate path and reports not-inserted', async function () {
            // The gossip receiver (row 12) calls insertAndBroadcast directly and needs
            // both facts: whether it was new here, and the id this hub holds.
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            let row = m.buildRow(finalizedEvent());

            expect(await m.insertAndBroadcast(row)).to.equal(true);
            expect(await m.insertAndBroadcast(row)).to.equal(false);
            expect(hub.db.selects()).to.have.length(2, 'the select-back runs on both paths');
        });
    });

    // ── the pending-eviction race ───────────────────────────────────────────

    describe('the 10-second pending eviction', function () {
        it('copies the event payload synchronously rather than dereferencing it after the await', async function () {
            // `pending` is deleted PENDING_EVICT_MS after the emit and the payload's
            // nested objects are the round's own, so this test tears the event apart
            // the instant the emit returns: a handler that read `event.request`,
            // `event.signatures` or the body after its first await would see this
            // damage, and a handler that copied in its own tick sees none of it.
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            let ev = finalizedEvent();
            hub._consensus.emit('request:finalized', ev);

            ev.request       = null;
            ev.signatures    = [];
            ev.responseBody  = Buffer.from('EVICTED', 'utf8');
            ev.effectiveTime = null;
            ev.status        = 'no_quorum';
            ev.meta          = null;

            await settle();

            expect(hub.db.table).to.have.length(1, 'the row survives the eviction');
            let row = hub.db.table[0];
            expect(row.response_payload).to.equal('the agreed body');
            expect(row.effective_time).to.equal(1770000120);
            expect(row.request_block_index).to.equal(120);
            expect(row.status).to.equal('ok');
            expect(JSON.parse(row.signer_pubkeys)).to.deep.equal([PUB_A, PUB_B]);
        });
    });

    // ── what the mirror declines to carry ───────────────────────────────────

    describe('rounds the mirror does not carry', function () {
        it('skips a retryable status: only terminal rounds are mirrored', async function () {
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            for(let status of ['no_quorum', 'provider_error', 'timeout']){
                hub._consensus.emit('request:finalized', finalizedEvent({ status: status }));
                await settle();
            }

            expect(hub.db.queries).to.have.length(0);
            expect(m.stats.skipped).to.equal(3);
        });

        it('skips a mirror-era round that carries no signed effective_time', async function () {
            // A recomputed stamp would be a value no signature covers, so every
            // indexer would skip the row: better to write nothing and say so.
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            hub._consensus.emit('request:finalized', finalizedEvent({ effectiveTime: null }));
            await settle();

            expect(hub.db.queries).to.have.length(0);
            expect(m.stats.skipped).to.equal(1);
        });

        it('skips a round that reached quorum with no verifying signatures', async function () {
            let hub = makeHub();
            let m   = new AttestationResponseMirror(hub);
            await m.start();

            hub._consensus.emit('request:finalized', finalizedEvent({ signatures: [] }));
            await settle();

            expect(hub.db.queries).to.have.length(0);
            expect(m.stats.skipped).to.equal(1);
        });
    });
});
