'use strict';

// Regression coverage for the publisher default-broadcast pipeline.
//
// Both publishers call the encoder's createTx with encoding 'P2SH'. The encoder's
// P2SH path runs bitcoin.address.fromBase58Check() on the `pubkey` field, so that
// field MUST carry the base58check address — not the raw hex public key. The e2e
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

describe('Publisher _defaultBroadcast — pubkey field carries the base58check address', function () {

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
