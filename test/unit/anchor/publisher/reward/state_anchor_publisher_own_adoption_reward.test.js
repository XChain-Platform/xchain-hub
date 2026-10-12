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

// A bundle the publisher adopts can be its OWN lost-ACK send, and that publisher is
// the only writer of the bundle's reward attestation. So an attested adoption the
// indexer binds to this hub records and defers the reward like a fresh send; a peer's
// bundle, or one whose ownership cannot be read, still records nothing.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');

const ME    = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const TXID  = 'ab'.repeat(32);
const NET   = 'regtest';
const SNAP  = 100;
const SIGS  = [{ pubkey: '11'.repeat(32), sig: '22'.repeat(64) }];
const GROUP = [{ chain: 'BTC', network: NET, block_index: 494, checkpoint_seq: 7, snapshot_block: SNAP }];

function anchorRow(version, over) {
    return Object.assign({ version: version, status: 'valid', checkpoint_network: NET, checkpoint_chain: 'BTC',
        publisher: ME, snapshot_block: SNAP, action_index: 0, confirmations: 1 }, over);
}

function makePub(answer) {
    let pub = Object.create(StateAnchorPublisher.prototype);
    pub.dogeConfirmations = 6;
    pub.announceQueueMax = 100;
    pub._deferredRewardAttest = new Map();
    pub.rewardCalls = [];
    pub.recordReward = (...a) => { pub.rewardCalls.push(a); };
    pub.rpcCalls = 0;
    pub.indexerCall = async (coin, method, params) => {
        pub.rpcCalls++;
        if (typeof answer === 'function') return answer(coin, method, params);
        return answer;
    };
    return pub;
}

function adopt(pub, attested, anchorVersion) {
    return pub.recordBundleReward(GROUP, ME, attested, attested ? SIGS : [], { exists: true, txid: TXID },
                                  NET, SNAP, TXID, anchorVersion);
}

function onlyEntry(pub) {
    expect(pub._deferredRewardAttest.size, 'exactly one deferred reward attestation').to.equal(1);
    return [...pub._deferredRewardAttest.values()][0];
}

describe('StateAnchorPublisher: reward on an adopted own bundle', function () {
    registerOwnAdoptionCases();
    registerSkippedAdoptionCases();
    registerPublishOrderCase();
});

function registerOwnAdoptionCases() {
    for (let version of [0, 3]) {
        it('defers the reward for an attested adoption of its own v' + version + ' bundle', async function () {
            let pub = makePub({ exists: true, truncated: false, anchors: [anchorRow(version)] });
            await adopt(pub, true, version);
            let e = onlyEntry(pub);
            expect(e.txid).to.equal(TXID);
            expect(e.publisher).to.equal(ME);
            expect(e.federate).to.equal(true);
            expect(e.rewardType).to.equal('anchor_bundle');
            expect(e.anchorVersion).to.equal(version);
            expect(e.attestSigs).to.deep.equal(SIGS);
            expect(pub.rewardCalls.length, 'records the hub-local reward once').to.equal(1);
        });
    }

    it('still defers the reward for a fresh send, with no ownership lookup', async function () {
        let pub = makePub(() => { throw new Error('a fresh send must not look ownership up'); });
        await pub.recordBundleReward(GROUP, ME, true, SIGS, { txid: TXID }, NET, SNAP, TXID, 0);
        expect(onlyEntry(pub).txid).to.equal(TXID);
        expect(pub.rpcCalls).to.equal(0);
    });
}

function registerSkippedAdoptionCases() {
    for (let version of [0, 3]) {
        it("records nothing when the adopted v" + version + " bundle is a peer's", async function () {
            let pub = makePub({ exists: true, truncated: false, anchors: [anchorRow(version, { publisher: OTHER })] });
            await adopt(pub, true, version);
            expect(pub._deferredRewardAttest.size).to.equal(0);
            expect(pub.rewardCalls.length).to.equal(0);
        });
    }

    it('records nothing, and counts it, when the ownership lookup fails', async function () {
        let pub = makePub(() => { throw new Error('indexer down'); });
        await adopt(pub, true, 0);
        expect(pub._deferredRewardAttest.size).to.equal(0);
        expect(pub.rewardCalls.length).to.equal(0);
        expect(pub._adoptedOwnershipUndetermined).to.equal(1);
    });

    it('records nothing when the indexer knows no anchor on the adopted txid', async function () {
        let pub = makePub({ exists: false });
        await adopt(pub, true, 0);
        expect(pub._deferredRewardAttest.size).to.equal(0);
        expect(pub.rewardCalls.length).to.equal(0);
    });

    it('skips the lookup entirely for an unattested adoption', async function () {
        let pub = makePub({ exists: true, truncated: false, anchors: [anchorRow(0)] });
        await adopt(pub, false, 0);
        expect(pub.rpcCalls).to.equal(0);
        expect(pub._deferredRewardAttest.size).to.equal(0);
        expect(pub.rewardCalls.length).to.equal(0);
    });
}

// The ownership lookup sits between the stamp and the BUNDLE_DONE announcement, so a
// failing lookup must never stop peers from hearing the bundle is anchored.
function registerPublishOrderCase() {
    it('announces BUNDLE_DONE for an adopted bundle even when the ownership lookup fails', async function () {
        let pub = makePub(() => { throw new Error('indexer down'); });
        let announced = 0;
        pub.identity = { getPubkeyHex: () => ME };
        pub.bundlePublisherOrder = async () => [ME];
        pub.standsDownFromBundle = () => false;
        pub.bundleHeldByIntent = async () => false;
        pub.collectBundleAttestation = async () => ({ attested: true, attestSigs: SIGS });
        pub.buildBundleWire = () => 'wire';
        pub.sendBundle = async () => ({ exists: true, txid: TXID });
        pub.stampBundleSections = async () => {};
        pub.completeFoldArchive = async () => {};
        pub.noteBundlePublished = () => {};
        pub.announceBundleDone = () => { announced++; };
        pub.adoptedBundleOwnership = async () => { throw new Error('ownership check blew up'); };
        await pub.publishBundle({}, NET, GROUP, SNAP, false, [], { rows: 0 }, null);
        expect(announced, 'peers still hear the bundle is anchored').to.equal(1);
        expect(pub._deferredRewardAttest.size).to.equal(0);
    });
}
