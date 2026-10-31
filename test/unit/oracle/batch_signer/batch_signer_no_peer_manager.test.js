'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A batch-sign leader with no peer manager reports quorum only for a genuine one-member
// price set; a multi-member set publishes nothing rather than a lone-signature batch.
const { expect, buildMesh, baseRounds } = require('../oracle_batch_signer.test.js');

let mesh;

describe('OracleBatchSigner without a peer manager', function () {
    afterEach(function () {
        if (mesh) mesh.stop();
        mesh = null;
    });

    it('returns met false on a multi-member price set and counts no quorum', async function () {
        mesh = buildMesh(4);
        let signer = mesh.nodes[0].signer;
        signer.peerManager = null;
        let before = signer.stats.batchSignQuorums;
        let res = await signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        expect(res.met).to.equal(false);
        expect(res.sigs).to.deep.equal([]);
        expect(signer.stats.batchSignQuorums).to.equal(before);
    });

    it('still self-signs a one-member price set', async function () {
        mesh = buildMesh(1);
        let signer = mesh.nodes[0].signer;
        signer.peerManager = null;
        let res = await signer.collectBatchSignatures(100, 105, 5005, baseRounds());
        expect(res.met).to.equal(true);
        expect(res.sigs.map(s => s.pubkey)).to.deep.equal([mesh.pubkeys[0]]);
    });

    it('treats unfilled gaps on a multi-member set as unfillable', async function () {
        mesh = buildMesh(4);
        let signer = mesh.nodes[0].signer;
        signer.peerManager = null;
        let set = mesh.pubkeys.map(pk => ({ pubkey: pk }));
        let filled = await signer.fillFromPeers(100, 105, new Set([103]), set, mesh.pubkeys[0], [], new Set());
        expect(filled).to.equal(false);
    });
});
