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

// A leader whose own rows lack a round its peers finalized must fetch it before it
// proposes. Without the fill step the followers refuse the proposal ("finalized here
// but not proposed") and the round times out short of quorum.
const { expect, buildMesh, buildCanonical, baseRounds, clone } = require('./oracle_batch_signer.test.js');
const { makePublisher, bodyOf, cleanupPublisherBatch } =
    require('./publisher/batch/oracle_publisher_batch.test.js');

const MISSING = 103;
let mesh;

function withoutMissing(rounds) {
    return rounds.filter(r => r.round !== MISSING);
}

function bufferedProposal(rounds) {
    return rounds.map(r => Object.assign({ bufferedAt: 1 }, r));
}

function leaderLacksRound(i) {
    return i === 0 ? withoutMissing(baseRounds()) : baseRounds();
}

function quickFill(mesh) {
    for (let node of mesh.nodes) node.signer.fillTimeoutMs = 80;
}

function signReqs(node) {
    return node.sent.filter(m => m.type === 'XPRICEB_SIGN_REQ');
}

function within(promise, ms) {
    return new Promise((resolve, reject) => {
        let timer = setTimeout(() => reject(new Error('fill round did not stop at quorum')), ms);
        promise.then(value => {
            clearTimeout(timer);
            resolve(value);
        }, error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function cleanupTest() {
    if (mesh) mesh.stop();
    mesh = null;
    cleanupPublisherBatch();
}

function registerPeerFillTests() {
    it('reaches quorum once a peer supplies the missing round', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        let rounds = bufferedProposal(withoutMissing(baseRounds()));
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        expect(res.met).to.equal(true);
        expect(res.sigs.length).to.be.at.least(3);
        expect(res.canonical).to.equal(buildCanonical(100, 105, 5005, baseRounds()));
    });

    it('splices the fetched round into the caller\'s array in order', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        let rounds = bufferedProposal(withoutMissing(baseRounds()));
        await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        expect(rounds.map(r => r.round)).to.deep.equal([100, 101, 102, 103, 104, 105]);
        expect(rounds[3]).to.deep.equal(clone(baseRounds())[3]);
    });
}

function registerUnfilledWindowTests() {
    it('skips the window without a wire when no peer can fill the gap', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        for (let node of mesh.nodes.slice(1)) node.signer.handleFillReq = async () => {};
        let res = await mesh.nodes[0].signer.collectBatchSignatures(
            100, 105, 5005, bufferedProposal(withoutMissing(baseRounds())));
        expect(res.met).to.equal(false);
        expect(signReqs(mesh.nodes[0])).to.have.length(0);
    });

    it('skips when an answering peer holds a round it cannot supply', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        for (let node of mesh.nodes.slice(1)) {
            node.signer.handleFillReq = async () => node.signer.peerManager.broadcast(
                'XPRICEB_FILL', { first_round: 100, last_round: 105, held: [MISSING], rounds: [] });
        }
        let res = await mesh.nodes[0].signer.collectBatchSignatures(
            100, 105, 5005, bufferedProposal(withoutMissing(baseRounds())));
        expect(res.met).to.equal(false);
        expect(signReqs(mesh.nodes[0])).to.have.length(0);
    });

    it('proposes without the round once a quorum replies and none holds it', async function () {
        mesh = buildMesh(4, { rounds: withoutMissing(baseRounds()), timeoutMs: 400 });
        mesh.nodes[0].signer.fillTimeoutMs = 1000;
        mesh.nodes[3].signer.handleFillReq = async () => {};
        let rounds = bufferedProposal(withoutMissing(baseRounds()));
        let pending = mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        let res = await within(pending, 400);
        expect(res.met).to.equal(true);
        expect(rounds.map(r => r.round)).to.deep.equal([100, 101, 102, 104, 105]);
    });
}

function registerLocalFillTests() {
    it('adds a locally finalized round omitted from the initial proposal', async function () {
        mesh = buildMesh(4, { timeoutMs: 400 });
        let rounds = bufferedProposal(withoutMissing(baseRounds()));
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        expect(res.met).to.equal(true);
        expect(rounds.map(r => r.round)).to.deep.equal([100, 101, 102, 103, 104, 105]);
        expect(rounds[3]).to.deep.equal(clone(baseRounds())[3]);
    });

    it('rejects a proposal edited after gap filling', async function () {
        mesh = buildMesh(4, { timeoutMs: 400 });
        let signer = mesh.nodes[0].signer;
        signer.fillWindowGaps = async (first, last, rounds) => {
            let held = new Set(rounds.map(r => r.round));
            rounds.splice(rounds.findIndex(r => r.round === MISSING), 1);
            return held;
        };
        let res = await signer.collectBatchSignatures(100, 105, 5005, bufferedProposal(baseRounds()));
        expect(res.met).to.equal(false);
        expect(signReqs(mesh.nodes[0])).to.have.length(0);
    });
}

function registerPublicationTests() {
    it('publishes a batch wire that carries the filled round', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        let leader = mesh.nodes[0];
        let publisher = makePublisher({ signer: leader.signer });
        publisher.p.windowPlan.rangeOf = () => ({ first: 100, last: 105 });
        for (let round of bufferedProposal(withoutMissing(baseRounds())))
            publisher.p._buffer.set(round.round, round);
        await publisher.p.assembleWindow(0);
        expect(publisher.broadcasts).to.have.length(1);
        expect(bodyOf(publisher.broadcasts[0])).to.include(
            '|103|1700001800|5003|2|BTC/USD|60003|LTC/USD|83|');
        expect(publisher.p.getStats()).to.include({
            batchWindowsPublished: 1,
            lastPublishedRound: 105
        });
    });
}

function registerSkippedRoundTests() {
    it('signs without a round that was recorded as skipped', async function () {
        let rounds = baseRounds().map(r => r.round === MISSING
            ? Object.assign({}, r, { status: 'skipped' }) : r);
        mesh = buildMesh(1, { rounds });
        mesh.nodes[0].signer.peerManager = null;
        let res = await mesh.nodes[0].signer.collectBatchSignatures(
            100, 105, 5005, bufferedProposal(withoutMissing(baseRounds())));
        expect(res.met).to.equal(true);
        expect(res.canonical).to.equal(buildCanonical(100, 105, 5005, withoutMissing(baseRounds())));
    });
}

describe('OracleBatchSigner leader fills a round its own rows lack', function () {
    afterEach(cleanupTest);
    registerPeerFillTests();
    registerUnfilledWindowTests();
    registerLocalFillTests();
    registerPublicationTests();
    registerSkippedRoundTests();
});
