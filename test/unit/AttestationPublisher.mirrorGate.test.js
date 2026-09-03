/*********************************************************************
 *
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
 * XChain Hub - AttestationPublisher mirror-activation gate unit tests
 * (the ATTEST response mirror design, decision D58).
 *
 * A focused sibling of AttestationPublisher.test.js (kept separate: that
 * file is already ~98 KB). Drives the per-request early return added to
 * onRequestFinalized: above the activation height for the request's own
 * network the publisher must produce NO queue append and NO broadcast for
 * that finalized event, because the response rides the hub mirror instead.
 * Below the height, or on a network whose activation entry is `null`
 * (unratified), the legacy on-chain path must run byte for byte, so the
 * gate is exercised from BOTH sides rather than asserted only on a stub's
 * call arguments.
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const sinon = require('sinon');
const { expect } = require('chai');
const AttestationPublisher = require('../../src/AttestationPublisher');

const MY_PUB = 'aa'.repeat(32);

// ---------- hub factory (same shape as AttestationPublisher.test.js) --------

function makeHub(myPub, overrides) {
    overrides = overrides || {};
    return Object.assign({
        network: 'regtest',   // overridden per-test; ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest === 0
        getIdentity: () => ({ getPubkeyHex: () => myPub }),
        p2pConfig: {},
        attestationConsensus: null,
        capabilitySnapshot: {
            getSnapshot: async () => ({ validators: [{ pubkey: myPub }] })
        },
        _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
        _btcIndexerHeaders: () => ({})
    }, overrides);
}

function makePublisher(myPub, hubOverrides) {
    const pub = new AttestationPublisher(makeHub(myPub || MY_PUB, hubOverrides));
    pub.queuePath = path.join(os.tmpdir(), 'attest-pub-mirrorgate-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    fs.writeFileSync(pub.queuePath, '');
    return pub;
}

function readQueue(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function cleanup(pub) {
    try { fs.unlinkSync(pub.queuePath); } catch (_) {}
}

// A finalized event shaped exactly like the happy-path tests in the main
// suite: a solo-responsible leader (redundancy 1, sole validator in the
// snapshot), signed, well under the wire size cap.
function finalizedEvent(rid, blockIndex) {
    return {
        requestId:    rid,
        providerId:   'http_get',
        responseBody: Buffer.from('ok'),
        status:       'ok',
        meta:         '',
        signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
        leaderPubkey: MY_PUB,
        request:      { block_index: blockIndex, redundancy: 1 }
    };
}

describe('AttestationPublisher: mirror-activation gate (D58)', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('regtest, request block at the activation height (0): no queue append, no broadcast', async function () {
        const pub = makePublisher(MY_PUB, { network: 'regtest' });
        const bcast = sinon.stub().resolves({ txid: 'should-not-be-called' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized(finalizedEvent('11'.repeat(32), 0));

        expect(bcast.called).to.equal(false, 'the mirror-era gate must skip the broadcast entirely');
        expect(readQueue(pub.queuePath)).to.have.length(0, 'the mirror-era gate must skip the WAL append entirely');
        cleanup(pub);
    });

    it('regtest, request block well above the activation height: still gated', async function () {
        const pub = makePublisher(MY_PUB, { network: 'regtest' });
        const bcast = sinon.stub().resolves({ txid: 'should-not-be-called' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized(finalizedEvent('22'.repeat(32), 500));

        expect(bcast.called).to.equal(false);
        expect(readQueue(pub.queuePath)).to.have.length(0);
        cleanup(pub);
    });

    it('regtest, missing request.block_index: NOT gated, falls to the legacy on-chain path', async function () {
        // isResponseMirrorActive must fail closed to "not gated" on an
        // unparseable block, which is the safe direction: the request still
        // gets an on-chain ATTEST v1 rather than silently losing its response.
        const pub = makePublisher(MY_PUB, { network: 'regtest' });
        const bcast = sinon.stub().resolves({ txid: 'legacy-tx-1' });
        pub.setBroadcastHook(bcast);

        const event = finalizedEvent('33'.repeat(32), undefined);
        delete event.request.block_index;
        await pub.onRequestFinalized(event);

        expect(bcast.calledOnce).to.equal(true, 'an unparseable block_index must not gate the legacy broadcast');
        cleanup(pub);
    });

    it('mainnet (activation entry null, unratified): NOT gated, legacy path runs even at a high block', async function () {
        const pub = makePublisher(MY_PUB, { network: 'mainnet' });
        const bcast = sinon.stub().resolves({ txid: 'legacy-tx-2' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized(finalizedEvent('44'.repeat(32), 999999));

        expect(bcast.calledOnce).to.equal(true, 'null in the activation map means unratified/off, so the legacy path must run');
        cleanup(pub);
    });

    it('testnet (activation entry null, unratified): NOT gated, legacy path runs', async function () {
        const pub = makePublisher(MY_PUB, { network: 'testnet' });
        const bcast = sinon.stub().resolves({ txid: 'legacy-tx-3' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized(finalizedEvent('55'.repeat(32), 999999));

        expect(bcast.calledOnce).to.equal(true);
        cleanup(pub);
    });

    it('the SAME event: gated on regtest, not gated on mainnet (direct contrast)', async function () {
        const rid = '66'.repeat(32);

        const regtestPub = makePublisher(MY_PUB, { network: 'regtest' });
        const regtestBcast = sinon.stub().resolves({ txid: 'x' });
        regtestPub.setBroadcastHook(regtestBcast);
        await regtestPub.onRequestFinalized(finalizedEvent(rid, 0));
        expect(regtestBcast.called).to.equal(false);
        expect(readQueue(regtestPub.queuePath)).to.have.length(0);
        cleanup(regtestPub);

        const mainnetPub = makePublisher(MY_PUB, { network: 'mainnet' });
        const mainnetBcast = sinon.stub().resolves({ txid: 'y' });
        mainnetPub.setBroadcastHook(mainnetBcast);
        await mainnetPub.onRequestFinalized(finalizedEvent(rid, 0));
        expect(mainnetBcast.calledOnce).to.equal(true);
        cleanup(mainnetPub);
    });
});
