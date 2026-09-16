'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -


const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const path           = require('path');
const os             = require('os');
const { DB_METHODS } = require('../../../helpers/mockHub');


let fsMock;
let OraclePublisher;

function loadModule() {
    fsMock = {
        mkdirSync:     sinon.stub(),
        existsSync:    sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        openSync:      sinon.stub().returns(99),
        writeSync:     sinon.stub(),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        readFileSync:  sinon.stub().returns('')
    };
    OraclePublisher = proxyquire('../../../../src/oracle/publisher', {
        fs: fsMock,
        '../peers/encoder_client': function () { return null; }
    });
}

function makeIdentity(pubkey) {
    return {
        getPubkeyHex: sinon.stub().returns(pubkey || 'aa'.repeat(32)),
        sign:         sinon.stub().returns('bb'.repeat(64))
    };
}

function makeHub(overrides) {
    return {
        p2pConfig:          overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getIdentity:        sinon.stub().returns(makeIdentity()),
        capabilityRegistry: overrides && overrides.capabilityRegistry !== undefined
            ? overrides.capabilityRegistry : null,
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        oracleConsensus:    overrides && overrides.oracleConsensus !== undefined
            ? overrides.oracleConsensus : null,
        ...(overrides || {})
    };
}


function makeDb(seed) {
    let markers = Object.assign({}, seed || {});
    let db = {


        ...DB_METHODS,
        markers,
        doQuery: sinon.stub().callsFake(async function (q, args) {
            if (/^\s*SELECT/i.test(q)) {
                if (/WHERE\s+round/i.test(q)) {
                    let r = Number(args[0]);
                    return markers[r] ? [markers[r]] : [];
                }
                return Object.keys(markers).map(k => markers[k]);
            }
            if (/^\s*INSERT/i.test(q)) {
                let r = Number(args[0]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                return { affectedRows: 1 };
            }
            if (/^\s*UPDATE/i.test(q)) {
                let txid = args[0];
                let r    = Number(args[args.length - 1]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                markers[r].txid    = txid;
                markers[r].sent_at = '2026-01-01 00:00:00';
                return { affectedRows: 1 };
            }


            if (/^\s*DELETE/i.test(q)) {
                let cutoff       = Number(args[0]);
                let confirmedOnly = /sent_at\s+IS\s+NOT\s+NULL/i.test(q);
                let deleted = 0;
                for (let k of Object.keys(markers)) {
                    let row = markers[k];
                    if (!(Number(row.round) < cutoff)) continue;
                    if (confirmedOnly && (row.sent_at === null || row.sent_at === undefined)) continue;
                    delete markers[k];
                    deleted++;
                }
                return { affectedRows: deleted };
            }
            return [];
        })
    };
    return db;
}

function bigPrices() {
    // Enough pairs to push the encoded wire past PRICE_WIRE_MAX_BYTES (8189).
    let out = [];
    for (let i = 0; i < 800; i++) out.push({ coinPair: 'PAIR' + i + '/USD', price: '123456' });
    return out;
}
function oraclePublisherTests(title, registerTests) {
    describe('OraclePublisher', function () {
        beforeEach(function () {
            loadModule();
        });

        afterEach(function () {
            sinon.restore();
        });

        describe(title, registerTests);
    });
}


// ── snapshot dark-path logging (item 2391) ─────────────────────────────────
oraclePublisherTests('capability-snapshot dark logging (item 2391)', function () {
    it('logs a warn when the snapshot resolves to null (silent dark path)', async function () {
        let warn = sinon.stub(console, 'warn');
        let capSS = { getSnapshot: sinon.stub().resolves(null) };
        let pub = new OraclePublisher(makeHub({ capabilitySnapshot: capSS }));
        let keys = await pub.getActiveOraclePublishPubkeys(100);
        expect(keys).to.deep.equal([]);          // fail-closed unchanged
        expect(warn.called).to.be.true;
        expect(pub._snapshotDark).to.be.true;
    });

    it('logs a warn when the snapshot call throws', async function () {
        let warn = sinon.stub(console, 'warn');
        let capSS = { getSnapshot: sinon.stub().rejects(new Error('indexer down')) };
        let pub = new OraclePublisher(makeHub({ capabilitySnapshot: capSS }));
        await pub.getActiveOraclePublishPubkeys(100);
        expect(warn.calledWithMatch(/indexer down/)).to.be.true;
    });

    it('is transition-only: a persistent fault logs once, then resets on recovery', async function () {
        let warn = sinon.stub(console, 'warn');
        let capSS = { getSnapshot: sinon.stub().resolves(null) };
        let pub = new OraclePublisher(makeHub({ capabilitySnapshot: capSS }));
        await pub.getActiveOraclePublishPubkeys(100);
        await pub.getActiveOraclePublishPubkeys(100);
        expect(warn.callCount).to.equal(1);       // second dark round is quiet
        // Recovery clears the guard so a subsequent dark spell logs again.
        capSS.getSnapshot.resolves({ validators: [{ pubkey: 'aa'.repeat(32) }] });
        await pub.getActiveOraclePublishPubkeys(100);
        expect(pub._snapshotDark).to.be.false;
        capSS.getSnapshot.resolves(null);
        await pub.getActiveOraclePublishPubkeys(100);
        expect(warn.callCount).to.equal(2);
    });

});


// ── oversized-wire drop observability (item 2402) ──────────────────────────
oraclePublisherTests('oversized PRICE v0 wire drop (item 2402)', function () {

    it('cannot be reached through onRoundFinalized any more: the v0 emit rail is retired', async function () {
        // The oversized-v0 drop guarded a per-round wire that onRoundFinalized no
        // longer builds. The equivalent for a batch is batchUnpublishableCount, which
        // is louder by design (a CRITICAL line plus a dead-letter) and is driven in
        // OraclePublisherBatch.test.js. Kept as a pin that nothing silently restores
        // the v0 emit path: a round this oversized must still never enqueue a wire.
        sinon.stub(console, 'error');
        let pub = new OraclePublisher(makeHub());
        sinon.stub(pub, 'getMyRank').resolves(0);
        sinon.stub(pub, 'getActiveOraclePublishCount').resolves(3);
        let enqueueSpy = sinon.spy(pub, 'enqueue');
        sinon.stub(pub, 'bufferFinalizedRound').resolves();
        await pub.onRoundFinalized({ round: 3, btcBlockHeight: 100, btcBlockTime: 0,
            prices: bigPrices(), signatures: [{ pubkey: 'pk', sig: 'sig' }] });
        expect(enqueueSpy.called).to.be.false;
        expect(pub.oversizedDrops).to.equal(0);
    });

    it('surfaces oversizedDrops via getStats()', function () {
        let pub = new OraclePublisher(makeHub());
        pub.oversizedDrops = 2;
        expect(pub.getStats().oversizedDrops).to.equal(2);
    });

});

