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

// A follower bounds the PROPOSE snapshot height against its own BTC tip before it
// locks the quorum and member set, so a proposer cannot pick an old, smaller electorate.

const { expect }       = require('chai');
const CrossChainEngine = require('../../../src/cross_chain/engine');
const { SNAPSHOT_BLOCK_TOLERANCE } = require('../../../src/cross_chain/bridge/constants.js');

const TIP = 900000;

// A follower with every other guard satisfied; records broadcasts and quorum lookups.
function buildFollower(resolveTip) {
    let broadcasts = [];
    let quorumCalls = [];
    let hub = { getPeerManager: () => ({ broadcast: (type) => broadcasts.push(type) }), db: {}, p2pConfig: {},
        network: 'regtest', resolveBtcLatestBlock: resolveTip };
    let engine = new CrossChainEngine(hub);
    engine.isKnownSender        = () => true;
    engine.digest               = () => 'digest-1';
    engine.verifySourceAction   = async () => true;
    engine.resolveQuorum        = async (s, d, height) => { quorumCalls.push(height); return 3; };
    engine.resolveMemberPubkeys = async () => new Set(['leader', 'self', 'v2', 'v3']);
    engine.selfPubkey           = () => 'self';
    return { engine, broadcasts, quorumCalls };
}

async function propose(built, btcBlockHeight) {
    await built.engine.handlePropose({ sender: 'leader', sig_pubkey: 'leader', data: {
        attestationId: 'BTC:1:LTC', sourceChain: 'BTC', sourceActionIndex: 1, destChain: 'LTC',
        confirmations: 6, digest: 'digest-1', btcBlockHeight } });
    return built.engine.pendingAttestations.has('BTC:1:LTC');
}

describe('CrossChainEngine PROPOSE height bound', function () {
    let built;

    afterEach(function () {
        for (let round of built.engine.pendingAttestations.values()) if (round.timer) clearTimeout(round.timer);
    });

    it('opens the round when the height matches our tip', async function () {
        built = buildFollower(async () => TIP);
        expect(await propose(built, TIP)).to.be.true;
        expect(built.broadcasts).to.include('XCHAIN_ATTEST_PREPARE');
        expect(built.quorumCalls).to.deep.equal([TIP]);
    });

    it('accepts a height exactly at the tolerance edge on either side', async function () {
        built = buildFollower(async () => TIP);
        expect(await propose(built, TIP - SNAPSHOT_BLOCK_TOLERANCE)).to.be.true;
        built.engine.pendingAttestations.clear();
        expect(await propose(built, TIP + SNAPSHOT_BLOCK_TOLERANCE)).to.be.true;
    });

    it('drops a stale height before any quorum lookup', async function () {
        built = buildFollower(async () => TIP);
        expect(await propose(built, TIP - SNAPSHOT_BLOCK_TOLERANCE - 1)).to.be.false;
        expect(built.broadcasts).to.deep.equal([]);
        expect(built.quorumCalls).to.deep.equal([]);
    });

    it('drops a height too far above our tip', async function () {
        built = buildFollower(async () => TIP);
        expect(await propose(built, TIP + SNAPSHOT_BLOCK_TOLERANCE + 1)).to.be.false;
        expect(built.quorumCalls).to.deep.equal([]);
    });

    it('drops a missing or malformed height', async function () {
        built = buildFollower(async () => TIP);
        for (let height of [undefined, null, 'abc', 0, -5, 900000.5]) {
            expect(await propose(built, height), String(height)).to.be.false;
        }
        expect(built.quorumCalls).to.deep.equal([]);
    });

    it('drops the PROPOSE when our own tip cannot be resolved', async function () {
        built = buildFollower(async () => null);
        expect(await propose(built, TIP)).to.be.false;
        built = buildFollower(async () => { throw new Error('indexer down'); });
        expect(await propose(built, TIP)).to.be.false;
        built = buildFollower(undefined);
        expect(await propose(built, TIP)).to.be.false;
        expect(built.quorumCalls).to.deep.equal([]);
    });
});
