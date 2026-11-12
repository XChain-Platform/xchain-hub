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

// A leader restarted inside its own window holds only part of it. The proposal must
// still cover the WINDOW: rounds its peers finalized while it was down are fetched
// before anything is packed or anchored, or the window is withheld and left
// un-memoized. A wire over only the held span, plus a memoized window, leaves those
// rounds off chain for good, because every co-signer re-derives the same narrowed
// range and signs it.
const { expect, buildMesh, baseRounds } = require('../oracle_batch_signer.test.js');
const { sinon, makePublisher, bodyOf, cleanupPublisherBatch } =
    require('../publisher/batch/oracle_publisher_batch.test.js');

let mesh;
let logs;

function only(numbers) {
    return baseRounds().filter(r => numbers.includes(r.round));
}

function landedCopy(numbers) {
    return baseRounds().map(r => numbers.includes(r.round) ? Object.assign({}, r, { batchSourced: true }) : r);
}

function quickFill(m) {
    for (let node of m.nodes) node.signer.fillTimeoutMs = 80;
}

function sentOf(node, type) {
    return node.sent.filter(m => m.type === type);
}

// The window's publisher, signing through mesh node 0, with `held` buffered.
function leaderPublisher(held) {
    let h = makePublisher({ signer: mesh.nodes[0].signer });
    h.p.windowPlan.rangeOf = () => ({ first: 100, last: 105 });
    // No landing-chain indexer: the chain read fails open, as on a hub that cannot reach it.
    h.hub.resolveIndexerUrl = async () => null;
    for (let r of held) h.p._buffer.set(r.round, Object.assign({ bufferedAt: 1 }, r));
    return h;
}

function header(wire) {
    return bodyOf(wire).split('|').slice(0, 4).join('|');
}

function registerFillTests() {
    it('fills the trailing rounds its peers finalized and publishes the whole window', async function () {
        mesh = buildMesh(4, { perNodeRounds: i => i === 0 ? only([100, 101]) : baseRounds(), timeoutMs: 400 });
        quickFill(mesh);
        let h = leaderPublisher(only([100, 101]));
        await h.p.assembleWindow(0);

        expect(h.broadcasts, 'one wire for the window').to.have.length(1);
        expect(header(h.broadcasts[0])).to.equal('100|105|5005|6');
        expect(sentOf(mesh.nodes[0], 'XPRICEB_SIGN_REQ').map(m => [m.data.first_round, m.data.last_round]))
            .to.deep.equal([[100, 105]]);
        expect(h.p._assembledWindows.has(0)).to.equal(true);
    });

    it('fills the leading rounds when the hub came back holding only the tail', async function () {
        mesh = buildMesh(4, { perNodeRounds: i => i === 0 ? only([104, 105]) : baseRounds(), timeoutMs: 400 });
        quickFill(mesh);
        let h = leaderPublisher(only([104, 105]));
        await h.p.assembleWindow(0);

        expect(h.broadcasts).to.have.length(1);
        expect(header(h.broadcasts[0])).to.equal('100|105|5005|6');
    });
}

function registerWithholdTests() {
    it('withholds and does not memoize when the peers cannot supply the missing rounds', async function () {
        mesh = buildMesh(4, { perNodeRounds: i => i === 0 ? only([100, 101]) : baseRounds(), timeoutMs: 400 });
        quickFill(mesh);
        for (let node of mesh.nodes.slice(1)) node.signer.handleFillReq = async () => {};
        let h = leaderPublisher(only([100, 101]));
        await h.p.assembleWindow(0);

        expect(h.broadcasts, 'no partial wire').to.have.length(0);
        expect(sentOf(mesh.nodes[0], 'XPRICEB_SIGN_REQ'), 'nothing proposed').to.have.length(0);
        expect(h.p._assembledWindows.has(0), 'a later pass may re-propose it').to.equal(false);
        expect(logs.warn.join('\n')).to.match(/window \[100,105\] lacks round\(s\) 102, 103, 104, 105/);
    });

    it('withholds when an answering peer holds a tail round it does not send', async function () {
        mesh = buildMesh(4, { perNodeRounds: i => i === 0 ? only([100, 101]) : baseRounds(), timeoutMs: 400 });
        quickFill(mesh);
        for (let node of mesh.nodes.slice(1)) {
            node.signer.handleFillReq = async () => node.signer.peerManager.broadcast(
                'XPRICEB_FILL', { first_round: 100, last_round: 105, held: [100, 101, 105], rounds: [] });
        }
        let h = leaderPublisher(only([100, 101]));
        await h.p.assembleWindow(0);

        expect(h.broadcasts).to.have.length(0);
        expect(h.p._assembledWindows.has(0)).to.equal(false);
    });

    it('publishes the held span when a quorum answers and no hub finalized the rest', async function () {
        // A round no hub finalized is a legitimate absence, not a hole.
        mesh = buildMesh(4, { rounds: only([100, 101]), timeoutMs: 400 });
        quickFill(mesh);
        let h = leaderPublisher(only([100, 101]));
        await h.p.assembleWindow(0);

        expect(h.broadcasts).to.have.length(1);
        expect(header(h.broadcasts[0])).to.equal('100|101|5001|2');
        expect(h.p._assembledWindows.has(0)).to.equal(true);
    });
}

function registerLandedTests() {
    it('leaves rounds shed after their batch landed out of the fill and the wire', async function () {
        mesh = buildMesh(4, { perNodeRounds: i => i === 0 ? only([102, 103, 104, 105])
                                                          : only([102, 103, 104, 105]), timeoutMs: 400 });
        quickFill(mesh);
        let h = leaderPublisher(only([102, 103, 104, 105]));
        h.p.markRoundLanded(100);
        h.p.markRoundLanded(101);
        await h.p.assembleWindow(0);

        expect(sentOf(mesh.nodes[0], 'XPRICEB_FILL_REQ'), 'nothing to fill').to.have.length(0);
        expect(h.broadcasts).to.have.length(1);
        expect(header(h.broadcasts[0])).to.equal('102|105|5005|4');
    });

    it('treats a round held only as a landed batch\'s copy as on chain, not as a gap to propose', async function () {
        // A restart lost the in-memory record of shed rounds and the chain read is
        // unavailable; the leader's own rows still mark 100 and 101 as batch-sourced.
        mesh = buildMesh(4, { perNodeRounds: i => i === 0 ? landedCopy([100, 101])
                                                          : only([102, 103, 104, 105]), timeoutMs: 400 });
        quickFill(mesh);
        let h = leaderPublisher(only([102, 103, 104, 105]));
        await h.p.assembleWindow(0);

        expect(h.broadcasts).to.have.length(1);
        expect(header(h.broadcasts[0])).to.equal('102|105|5005|4');
    });
}

describe('OraclePublisher PRICE batch rail: a restarted leader proposes the whole window', function () {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
        sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
        sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
    });
    afterEach(function () {
        if (mesh) mesh.stop();
        mesh = null;
        cleanupPublisherBatch();
    });
    registerFillTests();
    registerWithholdTests();
    registerLandedTests();
});
