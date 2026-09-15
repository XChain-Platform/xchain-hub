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
 * XChain Hub - AttestationPublisher unit tests
 *
 * Covers: constructor defaults, start/stop lifecycle, buildAttestationResponseWire,
 * _enqueue/readQueue/rewriteQueue/removeFromQueue, getBroadcaster, myRank,
 * computeResponsible, fetchPendingRequestIds, resolveBtcIndexerUrl,
 * defaultBroadcast, onRequestFinalized edge cases (no-sigs, oversized payload).
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const sinon = require('sinon');
const nock  = require('nock');
const { expect } = require('chai');
const AttestationPublisher = require('../../../../../src/attestation/publisher');
const { waitUntil } = require('../../../../helpers/waitUntil');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const MY_PUB     = 'aa'.repeat(32);
const LEADER_PUB = 'bb'.repeat(32);
const OTHER_PUB  = 'cc'.repeat(32);

// ---------- hub factory (mirrors AttestationPublisherReplay pattern) --------

function makeHub(myPub, overrides) {
    overrides = overrides || {};
    return Object.assign({
        getIdentity: () => ({ getPubkeyHex: () => myPub }),
        p2pConfig: {},
        attestationConsensus: null,
        capabilitySnapshot: {
            getSnapshot: async () => ({ validators: [{ pubkey: myPub }, { pubkey: LEADER_PUB }] })
        },
        resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
        btcIndexerHeaders: () => ({})
    }, overrides);
}

// Create a publisher with a unique tmpdir queue path per test.
function makePublisher(myPub, hubOverrides) {
    const pub = new AttestationPublisher(makeHub(myPub || MY_PUB, hubOverrides));
    pub.queuePath = path.join(os.tmpdir(), 'attest-pub-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    return pub;
}

function writeQueue(file, entries) {
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function readQueue(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ---------- constructor --------------------------------------------------

// ---------- setBroadcastHook / setWalletSignHook / setEncoder ---------------

// ---------- start / stop ----------------------------------------------------

// ---------- buildAttestationResponseWire ------------------------------------

// ---------- _enqueue / readQueue / rewriteQueue / removeFromQueue --------

// ---------- getBroadcaster -------------------------------------------------

// ---------- myRank ---------------------------------------------------------

// ---------- computeResponsible ---------------------------------------------

// ---------- resolveBtcIndexerUrl -------------------------------------------

// ---------- fetchPendingRequestIds -----------------------------------------

// ---------- onRequestFinalized edge cases -----------------------------------

// ---------- processQueue extra paths not covered by replay suite -----------

// ---------- defaultBroadcast -----------------------------------------------

// ---------- items 2674 / 2676 / 2678 / 2681: effector-safety guards ----------

// ── attest_published_requests retention (#4869) ────────────────────────────────
// The durable marker table gained one row per paid ATTEST request and never lost
// one, so a money-bearing broadcast path grew a table without bound while its
// oracle_published_rounds sibling was swept. Retention may only ever touch
// CONFIRMED rows (a sent_at NULL row is the quarantine marker an operator
// reconciles by hand), may never touch a request still on the durable WAL, and may
// never reach inside the horizon in which a live path can still surface the
// request, which is the longest provider deadline_window_blocks.

{
const hookAt62782 = function () { sinon.restore(); };

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when encoder is not configured', async function () {
        const pub = makePublisher();
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no encoder/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when walletSignFn is not configured', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no wallet sign hook/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when btcAddress is not configured', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no BTC_ADDRESS/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when btcPubkeyHex is not configured', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress = '1Test';
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no BTC_PUBKEY_HEX/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when encoder returns no UTXOs', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub().resolves([]) });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no UTXOs/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when encoder returns null UTXOs', async function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub().resolves(null) });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no UTXOs/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when encoder.createTx returns no PSBT', async function () {
        const pub = makePublisher();
        const encoder = {
            getUtxos:  sinon.stub().resolves([{ txid: 'tx', vout: 0, value: 1000 }]),
            createTx:  sinon.stub().resolves(null)  // returns null → no psbt
        };
        pub.setEncoder(encoder);
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no PSBT/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('throws when walletSignFn returns invalid tx hex', async function () {
        const pub = makePublisher();
        const encoder = {
            getUtxos: sinon.stub().resolves([{ txid: 'tx', vout: 0, value: 1000 }]),
            createTx: sinon.stub().resolves({ psbt: 'psbt-hex' })
        };
        pub.setEncoder(encoder);
        pub.setWalletSignHook(sinon.stub().resolves(null));  // returns null, invalid
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);
        let err;
        try { await pub.defaultBroadcast('wire'); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/invalid tx hex/);
    }); });

describe('AttestationPublisher: defaultBroadcast', function () { afterEach(hookAt62782); it('succeeds end-to-end: getUtxos → createTx → walletSign → broadcastTx', async function () {
        const pub = makePublisher();
        const encoder = {
            getUtxos:    sinon.stub().resolves([{ txid: 'tx', vout: 0, value: 1000 }]),
            createTx:    sinon.stub().resolves({ psbt: 'psbt-hex' }),
            broadcastTx: sinon.stub().resolves({ txid: 'broadcast-txid' })
        };
        pub.setEncoder(encoder);
        pub.setWalletSignHook(sinon.stub().resolves('signed-tx-hex'));
        pub.btcAddress   = '1Test';
        pub.btcPubkeyHex = 'ab'.repeat(33);

        const result = await pub.defaultBroadcast('wire-payload');
        expect(result.txid).to.equal('broadcast-txid');
        expect(encoder.createTx.calledOnce).to.equal(true);
        const createTxArgs = encoder.createTx.args[0][0];
        expect(createTxArgs.data).to.equal('wire-payload');
        expect(createTxArgs.encoding).to.equal('P2SH');
    }); });
}
