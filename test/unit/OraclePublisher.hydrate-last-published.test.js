'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Startup hydration of the last-published markers. The publish path is the only
// writer of lastPublishedRound at runtime, so without this hydration every
// restart hands the monitor a null and its batch-backlog rail reads a publisher
// of months standing as one that has never published, which cannot arm.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

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
    OraclePublisher = proxyquire('../../src/OraclePublisher', {
        fs: fsMock,
        './EncoderClient': function () { return null; }
    });
}

function makeHub(overrides) {
    return {
        p2pConfig:          {},
        getIdentity:        sinon.stub().returns({
            getPubkeyHex: sinon.stub().returns('aa'.repeat(32)),
            sign:         sinon.stub().returns('bb'.repeat(64))
        }),
        capabilityRegistry: null,
        capabilitySnapshot: null,
        oracleConsensus:    null,
        ...(overrides || {})
    };
}

// Minimal stand-in for hub.db. Models oracle_published_rounds well enough to drive
// the startup scan: the hydrate reads the whole table with no WHERE clause, so any
// SELECT without one returns every seeded row in insertion order (deliberately NOT
// sorted, so a hydrate that takes the last row rather than the highest round fails).
function makeDb(rows) {
    let table = (rows || []).slice();
    return {
        table,
        doQuery: sinon.stub().callsFake(async function (q, args) {
            if (/^\s*SELECT/i.test(q)) {
                if (/WHERE\s+round/i.test(q)) {
                    let r = Number(args[0]);
                    return table.filter(row => Number(row.round) === r);
                }
                return table.slice();
            }
            return [];
        })
    };
}

function sent(round, txid) {
    return { round: round, txid: txid || ('tx-' + round), sent_at: '2026-08-26 12:00:00' };
}

function intentOnly(round) {
    return { round: round, txid: null, sent_at: null };
}

describe('OraclePublisher last-published hydrate', function () {

    beforeEach(function () {
        loadModule();
    });

    afterEach(function () {
        sinon.restore();
    });

    it('restores the highest confirmed round and its txid from the marker table', async function () {
        // Out of round order on purpose: the answer is the MAX confirmed round, not
        // whichever row the driver happened to return last.
        let db  = makeDb([sent(1204), sent(1207), sent(1205)]);
        let pub = new OraclePublisher(makeHub({ db: db }));

        expect(pub.lastPublishedRound, 'a new process starts with empty markers').to.equal(null);

        await pub._hydratePublishedMarkers();

        expect(pub.lastPublishedRound).to.equal(1207);
        expect(pub.lastPublishedTxid).to.equal('tx-1207');
    });

    it('reports the hydrated round through the status payload', async function () {
        // The monitor reads the payload, not the field, so the rail arms only if the
        // hydrated value reaches getStats().
        let db  = makeDb([sent(880), sent(913)]);
        let pub = new OraclePublisher(makeHub({ db: db }));

        await pub._hydratePublishedMarkers();

        let s = pub.getStats();
        expect(s.lastPublishedRound, 'the rail gates on this field').to.equal(913);
        expect(s.lastPublishedTxid).to.equal('tx-913');
        expect(s.everPublished).to.equal(true);
    });

    it('leaves a hub with no marker rows reporting null', async function () {
        let db  = makeDb([]);
        let pub = new OraclePublisher(makeHub({ db: db }));

        await pub._hydratePublishedMarkers();

        expect(pub.lastPublishedRound).to.equal(null);
        expect(pub.lastPublishedTxid).to.equal(null);
        expect(pub.getStats().lastPublishedRound).to.equal(null);
        expect(pub.getStats().everPublished).to.equal(false);
    });

    it('does not treat an intent-only row as a publication', async function () {
        // sent_at NULL is a round whose on-chain state is unknown after a crash. It is
        // quarantined for an operator to reconcile, and claiming it as the last
        // publication would report a round that may never have reached a wire.
        let db  = makeDb([sent(500), intentOnly(501)]);
        let pub = new OraclePublisher(makeHub({ db: db }));

        await pub._hydratePublishedMarkers();

        expect(pub.lastPublishedRound).to.equal(500);
        expect(pub._quarantinedRounds.has(501)).to.be.true;
    });

    it('never walks the markers backwards over a round published in this process', async function () {
        // Idempotence guard: the process is the fresher writer, so a second hydrate
        // (or one racing a publish) must not replace a newer round with a stale row.
        let db  = makeDb([sent(700)]);
        let pub = new OraclePublisher(makeHub({ db: db }));

        await pub._hydratePublishedMarkers();
        expect(pub.lastPublishedRound).to.equal(700);

        pub.lastPublishedRound = 900;
        pub.lastPublishedTxid  = 'tx-900';
        await pub._hydratePublishedMarkers();

        expect(pub.lastPublishedRound).to.equal(900);
        expect(pub.lastPublishedTxid).to.equal('tx-900');
    });

    it('is inert when no hub DB is wired', async function () {
        let pub = new OraclePublisher(makeHub());

        await pub._hydratePublishedMarkers();

        expect(pub.lastPublishedRound).to.equal(null);
        expect(pub.getStats().everPublished).to.equal(false);
    });
});
