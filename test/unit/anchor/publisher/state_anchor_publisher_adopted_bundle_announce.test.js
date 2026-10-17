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

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../src/anchor/publisher');

const ME    = 'ab'.repeat(32);
const TXID  = 'cd'.repeat(32);
const GROUP = [{ chain: 'BTC', block_index: 10, checkpoint_seq: 1, snapshot_block: 50 }];

function makePublisher(exists) {
    let pub = Object.create(StateAnchorPublisher.prototype);
    let announced = 0;
    pub.identity = { getPubkeyHex: () => ME };
    pub.bundlePublisherOrder = async () => [ME];
    pub.standsDownFromBundle = () => false;
    pub.bundleHeldByIntent = async () => false;
    pub.collectBundleAttestation = async () => ({
        attested: true,
        attestSigs: [{ pubkey: ME, sig: '00' }]
    });
    pub.buildBundleWire = () => 'wire';
    pub.sendBundle = async () => ({ txid: TXID, exists });
    pub.notePendingConfirmation = () => {};
    pub.stampBundleSections = async () => {};
    pub.completeFoldArchive = async () => {};
    pub.noteBundlePublished = () => {};
    pub.recordBundleReward = async () => {};
    pub.announceBundleDone = () => { announced++; };
    return { pub, announcements: () => announced };
}

async function announcements(network, exists) {
    let fixture = makePublisher(exists);
    await fixture.pub.publishBundle({}, network, GROUP, 60, false, [], { rows: 0 }, null);
    return fixture.announcements();
}

describe('StateAnchorPublisher: adopted bundle completion announcement', function () {
    it('does not re-announce an adopted bundle under this hub key at the gate', async function () {
        expect(await announcements('regtest', true)).to.equal(0);
    });

    it('still announces a freshly published bundle at the gate', async function () {
        expect(await announcements('regtest', false)).to.equal(1);
    });

    for(let network of ['mainnet', 'testnet']){
        it('preserves adopted bundle announcements below the gate on ' + network, async function () {
            expect(await announcements(network, true)).to.equal(1);
        });
    }
});
