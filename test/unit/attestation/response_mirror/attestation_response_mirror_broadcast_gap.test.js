/*********************************************************************
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
 * XChain Hub - AttestationResponseMirror broadcast-gap tests.
 *
 * Pins that a committed attestation_responses row which cannot be streamed
 * forces every hub-DB mirror subscriber to resync, and that the repair never
 * throws past the commit.
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');

const AttestationResponseMirror = require('../../../../src/attestation/response_mirror');

const ROW = { network: 'testnet', request_id: '22'.repeat(32), effective_time: 1770000120 };

// Build a mirror over a stub DB whose insert and select-back outcomes the case chooses.
function makeMirror({ affectedRows = 1, readBack, subscribers = 1 } = {}){
    const db = {
        doQuery: async () => [],
        createAttestationResponseMirrorRow: sinon.stub().resolves({ affectedRows }),
        getAttestationResponseMirrorRow: readBack || sinon.stub().resolves([{ id: 7, ...ROW }]),
    };
    const broadcaster = {
        subscribers: new Set(Array.from({ length: subscribers }, (_v, i) => i)),
        broadcastRow: sinon.stub(),
        dropAllForResync: sinon.stub().returns(subscribers),
    };
    return { mirror: new AttestationResponseMirror({ db, hubDbBroadcaster: broadcaster }), broadcaster };
}

describe('AttestationResponseMirror broadcast gap', function () {
    beforeEach(function () { sinon.stub(console, 'error'); sinon.stub(console, 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('streams a fresh insert and does not resync when the read-back succeeds', async function () {
        const { mirror, broadcaster } = makeMirror();
        expect(await mirror.insertAndBroadcast({ ...ROW })).to.equal(true);
        expect(broadcaster.broadcastRow.calledOnce).to.equal(true);
        expect(broadcaster.dropAllForResync.called).to.equal(false);
    });

    it('forces a resync when a fresh insert reads back empty', async function () {
        const { mirror, broadcaster } = makeMirror({ readBack: sinon.stub().resolves([]) });
        expect(await mirror.insertAndBroadcast({ ...ROW })).to.equal(true);
        expect(broadcaster.broadcastRow.called).to.equal(false);
        expect(broadcaster.dropAllForResync.calledOnceWith('attestation_responses mirror gap')).to.equal(true);
    });

    it('forces a resync and still reports the insert when the read-back throws', async function () {
        const { mirror, broadcaster } = makeMirror({ readBack: sinon.stub().rejects(new Error('read lost')) });
        expect(await mirror.insertAndBroadcast({ ...ROW })).to.equal(true);
        expect(broadcaster.dropAllForResync.calledOnce).to.equal(true);
        expect(mirror.stats.errors).to.equal(1);
    });

    it('leaves a duplicate whose read-back throws to the caller, with no resync', async function () {
        const { mirror, broadcaster } = makeMirror({ affectedRows: 0, readBack: sinon.stub().rejects(new Error('read lost')) });
        let thrown = null;
        try { await mirror.insertAndBroadcast({ ...ROW }); } catch (err) { thrown = err; }
        expect(thrown && thrown.message).to.equal('read lost');
        expect(broadcaster.dropAllForResync.called).to.equal(false);
    });

    it('skips the resync when no subscriber is connected', async function () {
        const { mirror, broadcaster } = makeMirror({ readBack: sinon.stub().resolves([]), subscribers: 0 });
        expect(await mirror.insertAndBroadcast({ ...ROW })).to.equal(true);
        expect(broadcaster.dropAllForResync.called).to.equal(false);
    });

    it('never throws past the commit when the repair itself fails', async function () {
        const { mirror, broadcaster } = makeMirror({ readBack: sinon.stub().resolves([]) });
        broadcaster.dropAllForResync.throws(new Error('broadcaster gone'));
        expect(await mirror.insertAndBroadcast({ ...ROW })).to.equal(true);
    });

    it('forces a resync instead of throwing when a re-stream read-back fails', async function () {
        const { mirror, broadcaster } = makeMirror({ readBack: sinon.stub().rejects(new Error('read lost')) });
        await mirror.rebroadcastRow({ ...ROW });
        expect(broadcaster.broadcastRow.called).to.equal(false);
        expect(broadcaster.dropAllForResync.calledOnce).to.equal(true);
    });
});
