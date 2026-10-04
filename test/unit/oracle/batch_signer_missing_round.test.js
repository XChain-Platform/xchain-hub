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
const OraclePublisher = require('../../../src/oracle/publisher.js');
const { expect, buildMesh, buildCanonical, baseRounds, clone } = require('./oracle_batch_signer.test.js');

const MISSING = 103;

function withoutMissing(rounds) {
    return rounds.filter(r => r.round !== MISSING);
}

function leaderLacksRound(i) {
    return i === 0 ? withoutMissing(baseRounds()) : baseRounds();
}

function quickFill(mesh) {
    for (let node of mesh.nodes) node.signer.fillTimeoutMs = 80;
}

function publisherFor(node) {
    let pub = Object.create(OraclePublisher.prototype);
    pub.hub = node.hub;
    pub.network = node.hub.network;
    return pub;
}

function signReqs(node) {
    return node.sent.filter(m => m.type === 'XPRICEB_SIGN_REQ');
}

describe('OracleBatchSigner leader fills a round its own rows lack', function () {
    let mesh;
    afterEach(() => mesh.stop());

    it('reaches quorum once a peer supplies the missing round', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        let rounds = withoutMissing(baseRounds());
        let res = await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        expect(res.met).to.equal(true);
        expect(res.sigs.length).to.be.at.least(3);
        expect(res.canonical).to.equal(buildCanonical(100, 105, 5005, baseRounds()));
    });

    it('splices the fetched round into the caller\'s array in order', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        let rounds = withoutMissing(baseRounds());
        await mesh.nodes[0].signer.collectBatchSignatures(100, 105, 5005, rounds);
        expect(rounds.map(r => r.round)).to.deep.equal([100, 101, 102, 103, 104, 105]);
        expect(rounds[3]).to.deep.equal(clone(baseRounds())[3]);
    });

    it('skips the window without a wire when no peer can fill the gap', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        for (let node of mesh.nodes.slice(1)) node.signer.handleFillReq = async () => {};
        let res = await mesh.nodes[0].signer.collectBatchSignatures(
            100, 105, 5005, withoutMissing(baseRounds()));
        expect(res.met).to.equal(false);
        expect(signReqs(mesh.nodes[0])).to.have.length(0);
    });

    it('still proposes when a quorum of peers confirms the round is absent everywhere', async function () {
        mesh = buildMesh(4, { rounds: withoutMissing(baseRounds()), timeoutMs: 400 });
        quickFill(mesh);
        let res = await mesh.nodes[0].signer.collectBatchSignatures(
            100, 105, 5005, withoutMissing(baseRounds()));
        expect(res.met).to.equal(true);
        expect(signReqs(mesh.nodes[0])).to.have.length(1);
    });

    it('publishes a batch wire that carries the filled round', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        let leader = mesh.nodes[0];
        let published = await publisherFor(leader).signAndSizeRange(
            leader.signer, withoutMissing(baseRounds()));
        expect(published).to.be.an('object');
        expect(published.wire).to.be.a('string').and.match(/^PRICE\|0\|/);
        expect(published.rounds.map(r => r.round)).to.deep.equal([100, 101, 102, 103, 104, 105]);
        expect(published.sigCount).to.be.at.least(3);
    });

    it('publishes nothing when no peer can fill the gap', async function () {
        mesh = buildMesh(4, { perNodeRounds: leaderLacksRound, timeoutMs: 400 });
        quickFill(mesh);
        for (let node of mesh.nodes.slice(1)) node.signer.handleFillReq = async () => {};
        let leader = mesh.nodes[0];
        let published = await publisherFor(leader).signAndSizeRange(
            leader.signer, withoutMissing(baseRounds()));
        expect(published).to.equal(null);
    });
});
