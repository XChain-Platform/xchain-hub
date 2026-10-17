'use strict';

// Copyright © 2025–2026 Dankest, LLC
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
const SIG   = 'ef'.repeat(64);
const GROUP = [{ chain: 'BTC', block_index: 10, checkpoint_seq: 1, snapshot_block: 50 }];

function makePublisher(exists) {
    let sent = [];
    let pub = Object.create(StateAnchorPublisher.prototype);
    pub.identity = { getPubkeyHex: () => ME, sign: () => SIG };
    pub.peerManager = { broadcast: (type, message) => sent.push({ type, message }) };
    pub.bundlePublisherOrder = async () => [ME];
    pub.standsDownFromBundle = () => false;
    pub.bundleHeldByIntent = async () => false;
    pub.collectBundleAttestation = async () => ({
        attested: true,
        attestSigs: [{ pubkey: ME, sig: SIG }]
    });
    pub.buildBundleWire = () => 'wire';
    pub.sendBundle = async () => ({ txid: TXID, exists });
    pub.notePendingConfirmation = () => {};
    pub.stampBundleSections = async () => {};
    pub.completeFoldArchive = async () => {};
    pub.noteBundlePublished = () => {};
    pub.recordBundleReward = async () => {};
    return { pub, sent };
}

async function expectBundleDone(network, exists) {
    let { pub, sent } = makePublisher(exists);
    await pub.publishBundle({}, network, GROUP, 60, false, [], { rows: 0 }, null);

    expect(sent, 'one peer broadcast').to.have.length(1);
    expect(sent[0].type).to.equal('XANC_BUNDLE_DONE');
    expect(sent[0].message).to.deep.equal({
        network,
        snapshot_block: 50,
        txid: TXID,
        sections: [{ chain: 'BTC', block_index: 10, checkpoint_seq: 1 }],
        sig_pubkey: ME,
        sig: SIG
    });
}

describe('StateAnchorPublisher: bundle completion announcement below the gate', function () {
    for (let network of ['mainnet', 'testnet']) {
        it('broadcasts one BUNDLE_DONE for an adopted bundle on ' + network, async function () {
            await expectBundleDone(network, true);
        });

        it('broadcasts one BUNDLE_DONE for a fresh publish on ' + network, async function () {
            await expectBundleDone(network, false);
        });
    }
});
