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

// A broadcast that answers without a txid has an unknown outcome, so it must be dead-lettered
// like any ambiguous send rather than recorded as a clean publish with a null txid.

const sinon      = require('sinon');
const { expect } = require('chai');
const { makeHub, describeOraclePublisher } = require('./helpers/oracle_publisher_harness');
const { requireBroadcastTxid, isAmbiguousSendError } = require('../../../../src/lib/guards/idempotent_broadcast.js');

let fsMock, OraclePublisher;

function publisherWith(broadcastResult) {
    let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
    fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
    let pub = new OraclePublisher(makeHub());
    pub.broadcastFn  = sinon.stub().resolves(broadcastResult);
    pub.getBalanceFn = sinon.stub().resolves(50);
    return pub;
}

describeOraclePublisher('a broadcast that returns no txid', (loaded) => { ({ fsMock, OraclePublisher } = loaded); }, function () {
    for (let [label, result] of [['an empty object', {}], ['null', null], ['an empty txid', { txid: '' }]]) {
        it('dead-letters ' + label + ' instead of writing a sent marker with a null txid', async function () {
            let pub = publisherWith(result);
            let dead = sinon.stub(pub, 'deadLetter');
            let marked = sinon.stub(pub, 'markPublished').resolves();
            await pub.processQueue();
            expect(dead.calledOnce, 'the round is dead-lettered as an ambiguous send').to.equal(true);
            expect(marked.called, 'no durable sent marker is written').to.equal(false);
            expect(pub.publishedCount).to.equal(0);
        });
    }

    it('still publishes a result that carries a txid, and accepts a bare txid string', async function () {
        for (let result of [{ txid: 'ab'.repeat(32) }, 'cd'.repeat(32)]) {
            let pub = publisherWith(result);
            let dead = sinon.stub(pub, 'deadLetter');
            let marked = sinon.stub(pub, 'markPublished').resolves();
            await pub.processQueue();
            expect(dead.called).to.equal(false);
            expect(marked.firstCall.args[1]).to.match(/^(ab|cd){32}$/);
        }
    });
});

describe('requireBroadcastTxid', function () {
    it('throws an error the shared classifier reads as an ambiguous send', function () {
        let err = null;
        try { requireBroadcastTxid({ txid: null }, 'test'); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.missingTxid).to.equal(true);
        expect(isAmbiguousSendError(err)).to.equal(true);
    });
});
