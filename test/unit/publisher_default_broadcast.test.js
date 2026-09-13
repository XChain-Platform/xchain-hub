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
//
// The canned answer deliberately omits `encoding`, which the REAL create_tx always
// reports. That omission is what keeps the argument-shape cases below reachable:
// against a faithful P2SH answer the pipeline now refuses to sign at all
// (src/lib/two_phase_guard.js), because the P2SH lane is two transactions and this
// pipeline can only broadcast the first. The refusal is exercised against a faithful
// answer in the last describe block, so the simplification here narrows what these
// cases cover without hiding the contract.
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

// The encoder's P2SH lane is a TWO-transaction contract: the funding tx creates the
// carrier outputs and a later reveal tx spends them, and only the reveal carries the
// payload an indexer decodes. This pipeline builds one transaction, signs it with the
// operator's walletSign hook and broadcasts once, so on that lane it published the
// FUNDING tx, returned its txid as success, and discarded carrierScripts - the only
// material a reveal or a sweep could be rebuilt from. It cannot finish the job either:
// the reveal PSBT needs the SDK's signRevealPsbt finalizer, which walletSign is not.
// So it must refuse, and refuse BEFORE the wallet hook runs: nothing signed, no fee
// spent, no value stranded.
describe('Publisher _defaultBroadcast: refuses phase 1 of a two-transaction encoding', function () {

    afterEach(function () {
        sinon.restore();
    });

    // Same stub, answering the way the real create_tx answers a P2SH build.
    function faithfulP2shEncoder() {
        const encoder = makeMockEncoder();
        const inner = encoder.createTx;
        encoder.createTx = function (args) {
            return inner.call(this, args).then(() => ({
                psbt: 'deadbeef', encoding: 'P2SH', carrierScripts: ['00ff', '11ee']
            }));
        };
        return encoder;
    }

    it('OraclePublisher refuses to sign or broadcast a P2SH funding transaction', async function () {
        const pub = new OraclePublisher({});
        const encoder = faithfulP2shEncoder();
        const walletSign = sinon.stub().resolves('00'.repeat(32));
        pub.encoder       = encoder;
        pub.walletSignFn  = walletSign;
        pub.dogeAddress   = 'DAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        pub.dogePubkeyHex = '02' + 'cd'.repeat(32);

        let threw = null;
        try { await pub._defaultBroadcast('PRICE|0|...'); } catch (e) { threw = e; }

        expect(threw).to.be.an('error');
        expect(threw.message).to.contain('two-transaction');
        expect(threw.message).to.contain('OraclePublisher');
        expect(walletSign.called).to.equal(false, 'must abort before the wallet hook');
        expect(encoder.broadcastTx.called).to.equal(false, 'no funding transaction may reach the chain');
    });

    it('AttestationPublisher refuses the same answer on the BTC rail', async function () {
        const pub = new AttestationPublisher({});
        const encoder = faithfulP2shEncoder();
        const walletSign = sinon.stub().resolves('00'.repeat(32));
        pub.encoder      = encoder;
        pub.walletSignFn = walletSign;
        pub.btcAddress   = '1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        pub.btcPubkeyHex = '02' + 'ab'.repeat(32);

        let threw = null;
        try { await pub._defaultBroadcast('ATTEST|1|...'); } catch (e) { threw = e; }

        expect(threw).to.be.an('error');
        expect(threw.message).to.contain('two-transaction');
        expect(walletSign.called).to.equal(false, 'must abort before the wallet hook');
        expect(encoder.broadcastTx.called).to.equal(false, 'no funding transaction may reach the chain');
    });

    it('still publishes when the encoder answers a single-transaction encoding', async function () {
        // The guard reads the encoder's ANSWER, not the requested encoding, so a build
        // the encoder downgraded to OP_RETURN goes through untouched.
        const pub = new OraclePublisher({});
        const encoder = makeMockEncoder();
        const inner = encoder.createTx;
        encoder.createTx = function (args) {
            return inner.call(this, args).then(() => ({ psbt: 'deadbeef', encoding: 'OP_RETURN' }));
        };
        pub.encoder       = encoder;
        pub.walletSignFn  = () => Promise.resolve('00'.repeat(32));
        pub.dogeAddress   = 'DAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        pub.dogePubkeyHex = '02' + 'cd'.repeat(32);

        const result = await pub._defaultBroadcast('PRICE|0|...');
        expect(result.txid).to.equal('broadcast-txid');
    });
});

// Review board #7752: an abandoned build kept the encoder's input reservation.
//
// create_tx is not read-only. A SUCCESSFUL build reserves every input it selected and
// returns the receipt on result.reservation; the encoder's own selection then skips those
// outpoints for five minutes. The refusal above happens AFTER that build (it has to: the
// verdict is read off the encoder's answer, never off the requested encoding), and nothing
// handed the ticket back - so a refused pass made a funded publishing address unavailable
// to every other publisher and to wallet operations for the rest of the TTL, and a retry
// loop reserved a fresh set of outputs each time without ever broadcasting.
//
// The release is confined to the pre-broadcast section on purpose. Past the send, holding
// the inputs is the protective behaviour: releasing there would invite a second build that
// double-spends a transaction which may already have landed.
describe('Publisher _defaultBroadcast: releases the encoder reservation of an abandoned build', function () {

    afterEach(function () { sinon.restore(); });

    // A create_tx answer shaped the way the real encoder answers: `reservation` rides on
    // every successful build, whatever the encoding.
    function reservingEncoder(over) {
        const encoder = makeMockEncoder();
        const inner = encoder.createTx;
        encoder.createTx = function (args) {
            return inner.call(this, args).then(() => Object.assign({
                psbt: 'deadbeef', reservation: { id: 'f'.repeat(32) }
            }, over || {}));
        };
        encoder.releaseInputs = sinon.stub().resolves({ found: true });
        return encoder;
    }

    function oraclePub(encoder, walletSign) {
        const pub = new OraclePublisher({});
        pub.encoder       = encoder;
        pub.walletSignFn  = walletSign || sinon.stub().resolves('00'.repeat(32));
        pub.dogeAddress   = 'DAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        pub.dogePubkeyHex = '02' + 'cd'.repeat(32);
        return pub;
    }

    it('hands the ticket back when the two-phase guard refuses the build', async function () {
        const encoder = reservingEncoder({ encoding: 'P2SH', carrierScripts: ['00ff'] });
        const pub = oraclePub(encoder);

        let threw = null;
        try { await pub._defaultBroadcast('PRICE|0|...'); } catch (e) { threw = e; }

        expect(threw, 'the refusal must still surface').to.be.an('error');
        expect(threw.message).to.contain('two-transaction');
        expect(encoder.releaseInputs.calledOnce, 'the reserved inputs must not be held to TTL').to.equal(true);
        expect(encoder.releaseInputs.firstCall.args[0]).to.equal('f'.repeat(32));
        expect(encoder.broadcastTx.called, 'nothing was sent').to.equal(false);
    });

    it('hands the ticket back when the wallet hook fails after a good build', async function () {
        const encoder = reservingEncoder({ encoding: 'OP_RETURN' });
        const pub = oraclePub(encoder, sinon.stub().rejects(new Error('signer offline')));

        let threw = null;
        try { await pub._defaultBroadcast('PRICE|0|...'); } catch (e) { threw = e; }

        expect(threw.message).to.contain('signer offline');
        expect(encoder.releaseInputs.calledOnce,
               'a wallet-sign abandon strands the same reservation').to.equal(true);
    });

    it('does NOT release once the transaction has been broadcast', async function () {
        const encoder = reservingEncoder({ encoding: 'OP_RETURN' });
        const pub = oraclePub(encoder);

        const result = await pub._defaultBroadcast('PRICE|0|...');
        expect(result.txid).to.equal('broadcast-txid');
        expect(encoder.releaseInputs.called,
               'the inputs a sent transaction spends must stay claimed').to.equal(false);
    });

    it('does not release after an AMBIGUOUS send, where holding the inputs is protective', async function () {
        const encoder = reservingEncoder({ encoding: 'OP_RETURN' });
        encoder.broadcastTx = sinon.stub().rejects(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        const pub = oraclePub(encoder);

        let threw = null;
        try { await pub._defaultBroadcast('PRICE|0|...'); } catch (e) { threw = e; }

        expect(threw, 'the send failure surfaces').to.be.an('error');
        expect(encoder.releaseInputs.called,
               'a send that may have landed must not have its inputs freed for a second build').to.equal(false);
    });

    it('is inert when the encoder minted no reservation (older encoder)', async function () {
        const encoder = reservingEncoder({ encoding: 'P2SH', carrierScripts: ['00ff'], reservation: undefined });
        const pub = oraclePub(encoder);

        let threw = null;
        try { await pub._defaultBroadcast('PRICE|0|...'); } catch (e) { threw = e; }

        expect(threw.message).to.contain('two-transaction');
        expect(encoder.releaseInputs.called, 'nothing to release, nothing called').to.equal(false);
    });

    it('a failing release never replaces the refusal the caller must see', async function () {
        const encoder = reservingEncoder({ encoding: 'P2SH', carrierScripts: ['00ff'] });
        encoder.releaseInputs = sinon.stub().rejects(new Error('encoder unreachable'));
        const pub = oraclePub(encoder);

        let threw = null;
        try { await pub._defaultBroadcast('PRICE|0|...'); } catch (e) { threw = e; }

        expect(threw.message, 'best effort: the TTL is the backstop').to.contain('two-transaction');
    });
});
