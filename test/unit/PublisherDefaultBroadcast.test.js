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

// Regression coverage for the publisher default-broadcast pipeline.
//
// Both publishers call the encoder's createTx with encoding 'P2SH'. The encoder's
// P2SH path runs bitcoin.address.fromBase58Check() on the `pubkey` field, so that
// field MUST carry the base58check address, not the raw hex public key. The e2e
// harness installs a custom broadcast hook that bypasses _defaultBroadcast, so this
// path is otherwise untested; these tests exercise it directly with a mock encoder.

const sinon              = require('sinon');
const { expect }         = require('chai');
const AttestationPublisher = require('../../src/AttestationPublisher');
const OraclePublisher      = require('../../src/OraclePublisher');

// A minimal encoder stub that records the createTx arguments and returns canned
// values for the rest of the pipeline.
function makeMockEncoder() {
    return {
        createTxArgs: null,
        getUtxos:    sinon.stub().resolves([{ txid: 'a'.repeat(64), vout: 0, value: 1 }]),
        createTx:    function (args) { this.createTxArgs = args; return Promise.resolve({ psbt: 'deadbeef' }); },
        broadcastTx: sinon.stub().resolves({ txid: 'broadcast-txid' })
    };
}

describe('Publisher _defaultBroadcast: pubkey field carries base58check address', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('AttestationPublisher passes btcAddress (base58check), not btcPubkeyHex', async function () {
        const pub = new AttestationPublisher({});
        const encoder = makeMockEncoder();
        pub.encoder      = encoder;
        pub.walletSignFn = () => Promise.resolve('00'.repeat(32));
        pub.btcAddress   = '1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';  // base58check P2PKH
        pub.btcPubkeyHex = '02' + 'ab'.repeat(32);                  // 66-char hex pubkey

        const result = await pub._defaultBroadcast('ATTEST|1|...');

        expect(encoder.createTxArgs).to.be.an('object');
        expect(encoder.createTxArgs.encoding).to.equal('P2SH');
        expect(encoder.createTxArgs.pubkey).to.equal(pub.btcAddress);
        expect(encoder.createTxArgs.pubkey).to.not.equal(pub.btcPubkeyHex);
        expect(result.txid).to.equal('broadcast-txid');
    });

    it('OraclePublisher passes dogeAddress (base58check), not dogePubkeyHex', async function () {
        const pub = new OraclePublisher({});
        const encoder = makeMockEncoder();
        pub.encoder       = encoder;
        pub.walletSignFn  = () => Promise.resolve('00'.repeat(32));
        pub.dogeAddress   = 'DAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';  // base58check DOGE address
        pub.dogePubkeyHex = '02' + 'cd'.repeat(32);                 // 66-char hex pubkey

        const result = await pub._defaultBroadcast('PRICE|0|...');

        expect(encoder.createTxArgs).to.be.an('object');
        expect(encoder.createTxArgs.encoding).to.equal('P2SH');
        expect(encoder.createTxArgs.pubkey).to.equal(pub.dogeAddress);
        expect(encoder.createTxArgs.pubkey).to.not.equal(pub.dogePubkeyHex);
        expect(result.txid).to.equal('broadcast-txid');
    });
});

// The encoder rejects a CALLER-SUPPLIED utxos array longer than MAX_UTXO_COUNT
// (500) with a RangeError -> -32602 before it builds anything, and deliberately
// exempts the set it fetches itself so a large wallet can still transact. The
// fetch-then-forward shape always supplied an array, so it could never reach
// that exemption and every publisher hard-failed past 500 outputs.
describe('Publisher _defaultBroadcast: oversized UTXO sets route to the encoder self-fetch', function () {

    afterEach(function () {
        sinon.restore();
    });

    function utxoSet(n) {
        const out = [];
        for (let i = 0; i < n; i++) out.push({ txid: 'a'.repeat(64), vout: i, value: 100000 });
        return out;
    }

    function oraclePublisherWith(utxos) {
        const pub = new OraclePublisher({});
        const encoder = makeMockEncoder();
        encoder.getUtxos = sinon.stub().resolves(utxos);
        pub.encoder       = encoder;
        pub.walletSignFn  = () => Promise.resolve('00'.repeat(32));
        pub.dogeAddress   = 'DAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        pub.dogePubkeyHex = '02' + 'cd'.repeat(32);
        return { pub, encoder };
    }

    it('forwards the array unchanged at the cap', async function () {
        const { pub, encoder } = oraclePublisherWith(utxoSet(500));
        await pub._defaultBroadcast('PRICE|0|...');
        expect(encoder.createTxArgs.utxos).to.be.an('array').with.lengthOf(500);
    });

    it('omits the utxos param past the cap so the encoder self-fetches', async function () {
        sinon.stub(console, 'warn');
        const { pub, encoder } = oraclePublisherWith(utxoSet(501));
        await pub._defaultBroadcast('PRICE|0|...');
        expect(encoder.createTxArgs.utxos).to.equal(undefined);
        // The wire body is what the encoder validates, and JSON.stringify drops an
        // undefined value, so the param is genuinely absent rather than null.
        expect(JSON.parse(JSON.stringify(encoder.createTxArgs))).to.not.have.property('utxos');
        // The address the encoder will scan comes from `pubkey`, so the omitted
        // set must still resolve to the same spend address.
        expect(encoder.createTxArgs.pubkey).to.equal(pub.dogeAddress);
    });

    it('still refuses an unfunded address before calling create_tx', async function () {
        const { pub, encoder } = oraclePublisherWith([]);
        let threw = null;
        try { await pub._defaultBroadcast('PRICE|0|...'); } catch (e) { threw = e; }
        expect(threw).to.be.an('error');
        expect(threw.message).to.contain('no UTXOs available');
        expect(encoder.createTxArgs).to.equal(null);
    });

    it('AttestationPublisher omits the param past the cap too', async function () {
        sinon.stub(console, 'warn');
        const pub = new AttestationPublisher({});
        const encoder = makeMockEncoder();
        encoder.getUtxos = sinon.stub().resolves(utxoSet(750));
        pub.encoder      = encoder;
        pub.walletSignFn = () => Promise.resolve('00'.repeat(32));
        pub.btcAddress   = '1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        pub.btcPubkeyHex = '02' + 'ab'.repeat(32);

        await pub._defaultBroadcast('ATTEST|1|...');

        expect(encoder.createTxArgs.utxos).to.equal(undefined);
        expect(encoder.createTxArgs.pubkey).to.equal(pub.btcAddress);
    });
});
