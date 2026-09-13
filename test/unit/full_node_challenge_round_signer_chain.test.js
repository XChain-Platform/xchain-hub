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
//
// The hub has ONE operator signer (HUB_SIGNER_MODULE), holding the
// DOGE_ADDRESS key, and wiring it into every publisher is the trap. NODEPROOF
// verdicts are built, funded and broadcast on BTC, so the DOGE signer served
// them: measured 2026-09-04, BTC-intended payloads were signed and broadcast on
// Dogecoin, burning DOGE fees, while the BTC side showed an invalid REQUEST_ID
// and zero responses.
//
// These tests drive a verdict through the REFERENCE DOGE signer template
// (examples/doge-signer.example.js, the module operators copy) and assert the
// refusal lands before any fee is spent: no walletSign call, no encoder call.

const assert       = require('assert');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const vm           = require('vm');
const sinon        = require('sinon');
const EventEmitter = require('events');

const FullNodeChallengeRound = require('../../src/FullNodeChallengeRound.js');
const { applySignerHooks, buildSignerHooks } = require('../../src/lib/signer-loader.js');

const TEMPLATE = path.join(__dirname, '..', '..', 'examples', 'doge-signer.example.js');
const source   = fs.readFileSync(TEMPLATE, 'utf8').replace(/^#!.*\n/, '');

const ME = 'a'.repeat(64);

// Load the reference template for real with the SDK and dotenv stubbed (it fails
// closed at load without operator credentials, so it cannot be require()d here).
// Same sandbox examples-doge-signer.test.js uses; the spies are what let a test
// prove the signing key was never asked to do anything.
function loadTemplate(spies) {
    const sandboxModule = { exports: {} };
    const sandboxRequire = (id) => {
        if (id === 'path')       return path;
        if (id === 'dotenv')     return { config: () => ({ parsed: {} }) };
        if (id === 'xchain-sdk') return { XChainSDK: function () {
            this._requireEncoder = () => spies.encoder;
            this.wallet = spies.wallet;
        } };
        throw new Error('unexpected require in the reference signer: ' + id);
    };
    vm.runInNewContext(source, {
        require:  sandboxRequire,
        module:   sandboxModule,
        exports:  sandboxModule.exports,
        __dirname: path.dirname(TEMPLATE),
        console,
        process:  { env: {
            DOGE_NETWORK:     'dogecoin-testnet',
            DOGE_WIF:         'test-wif',
            DOGE_ADDRESS:     'test-address',
            DOGE_ENCODER_URL: 'http://encoder.invalid'
        } },
        Number, String, Error, Promise, Object
    }, { filename: 'doge-signer.example.js' });
    return sandboxModule.exports;
}

function makeSpies() {
    return {
        encoder: {
            createTx:    sinon.stub().resolves({ psbt: 'psbt-1', encoding: 'P2SH' }),
            broadcastTx: sinon.stub().resolves({ txid: 'f'.repeat(64) }),
            spendP2sh:   sinon.stub().resolves({ psbt: 'psbt-2' }),
            getUtxos:    sinon.stub().resolves([{ txid: 'a'.repeat(64), vout: 0, value: 100000 }])
        },
        wallet: {
            signPsbt:       sinon.stub().returns({ txHex: 'hex-1', txid: 'f'.repeat(64) }),
            signRevealPsbt: sinon.stub().returns({ txHex: 'hex-2', txid: 'e'.repeat(64) })
        }
    };
}

// The BTC-side encoder the round would build and fund its verdict through. Every
// stub here is a spy on money moving: a call means the refusal came too late.
function btcEncoderSpy() {
    return {
        getUtxos:    sinon.stub().resolves([{ txid: 'b'.repeat(64), vout: 0, value: 100000 }]),
        createTx:    sinon.stub().resolves({ psbt: 'btc-psbt', encoding: 'BARE' }),
        broadcastTx: sinon.stub().resolves({ txid: 'c'.repeat(64) })
    };
}

function makeHub() {
    let pm = new EventEmitter();
    pm.broadcast = sinon.stub();
    return {
        peerManager: pm,
        identity: { getPubkeyHex: () => ME, sign: () => 'sig:' + ME },
        capabilitySnapshot: { getSnapshot: sinon.stub().resolves({ validators: [] }) },
        network: 'regtest',
        p2pConfig: {
            FULLNODE: { POLL_MS: 30000, COLLECT_MS: 20000, BTC_RPC: 'http://coin' },
            cross_chain: { chains: { BTC: { rpc: 'http://coin' } } },
            BTC_INDEXER_URL: 'http://ix'
        }
    };
}

function makeRound(encoder) {
    let eng = new FullNodeChallengeRound(makeHub());
    eng.btcAddress = 'btc-publisher-address';
    eng.setEncoder(encoder);
    return eng;
}

function captureWarn(fn) {
    let lines = [];
    let original = console.warn;
    console.warn = (...args) => lines.push(args.join(' '));
    return Promise.resolve()
        .then(fn)
        .then(() => { console.warn = original; return lines; },
              (e) => { console.warn = original; throw e; });
}

describe('FullNodeChallengeRound signer chain gate', function () {

    afterEach(() => sinon.restore());

    it('declares BTC as the chain its verdicts settle on', function () {
        assert.strictEqual(makeRound(btcEncoderSpy()).signingChain, 'BTC');
    });

    it('the reference DOGE template declares DOGE only', function () {
        let hooks = buildSignerHooks(loadTemplate(makeSpies()), TEMPLATE);
        assert.deepStrictEqual(hooks.chains, ['DOGE']);
    });

    // The ledger's acceptance test: a NODEPROOF verdict driven through the DOGE
    // signer template ends in refusal BEFORE any fee spend.
    it('refuses to wire the DOGE template, and a verdict then spends nothing', async function () {
        let spies   = makeSpies();
        let hooks   = buildSignerHooks(loadTemplate(spies), TEMPLATE);
        let encoder = btcEncoderSpy();
        let eng     = makeRound(encoder);

        let warned = await captureWarn(() => {
            assert.strictEqual(applySignerHooks(eng, hooks, 'BTC'), false);
        });
        assert.strictEqual(warned.length, 1);
        assert.match(warned[0], /FullNodeChallengeRound/);
        assert.match(warned[0], /settles on BTC/);
        assert.match(warned[0], /declares chains \[DOGE\]/);

        assert.strictEqual(eng.walletSignFn, null, 'the DOGE key must not be reachable from a BTC verdict');
        assert.strictEqual(eng.broadcastFn,  null);
        assert.strictEqual(eng.getBalanceFn, undefined,
            'a DOGE balance must not be read as the BTC publisher wallet');

        await assert.rejects(() => eng._broadcastVerdict('NODEPROOF|wire'),
            /no broadcast pipeline/);

        assert.strictEqual(spies.wallet.signPsbt.callCount, 0, 'no walletSign call');
        assert.strictEqual(spies.encoder.createTx.callCount, 0, 'no DOGE encoder call');
        assert.strictEqual(encoder.getUtxos.callCount, 0, 'no BTC encoder call either');
        assert.strictEqual(encoder.createTx.callCount, 0);
    });

    // Defence in depth: the loader is the only production wiring path, but a hook
    // set directly must still not sign a BTC verdict with a DOGE key.
    it('refuses at send time when a DOGE-tagged hook was wired directly', async function () {
        let spies   = makeSpies();
        let template = loadTemplate(spies);
        let hooks   = buildSignerHooks(template, TEMPLATE);
        let encoder = btcEncoderSpy();
        let eng     = makeRound(encoder);

        eng.setWalletSignHook(hooks.walletSignFn, 'DOGE');
        eng.setBroadcastHook(hooks.broadcastFn, 'DOGE');

        let warned = await captureWarn(async () => {
            await assert.rejects(() => eng._broadcastVerdict('NODEPROOF|wire'),
                /REFUSING to publish a NODEPROOF verdict/);
        });
        assert.strictEqual(warned.length, 1, 'one loud line, not one per attempt');
        assert.match(warned[0], /settles on BTC/);
        assert.match(warned[0], /broadcast hook wired for DOGE and wallet-sign hook wired for DOGE/);

        assert.strictEqual(spies.encoder.createTx.callCount, 0, 'the template must not fund phase 1');
        assert.strictEqual(spies.wallet.signPsbt.callCount, 0);
        assert.strictEqual(encoder.getUtxos.callCount, 0);

        // A second attempt still refuses, and still costs nothing, without repeating
        // the line every poll tick.
        let again = await captureWarn(async () => {
            await assert.rejects(() => eng._broadcastVerdict('NODEPROOF|wire'), /REFUSING/);
        });
        assert.strictEqual(again.length, 0);
    });

    it('accepts a BTC-tagged wiring, proving the gate is about the chain and not the hook', async function () {
        let encoder = btcEncoderSpy();
        let eng     = makeRound(encoder);
        let signed  = sinon.stub().resolves({ txid: 'd'.repeat(64) });
        eng.setBroadcastHook(signed, 'BTC');
        let res = await eng._broadcastVerdict('NODEPROOF|wire');
        assert.strictEqual(res.txid, 'd'.repeat(64));
        assert.strictEqual(signed.callCount, 1);
    });

    it('an untagged direct wiring stays trusted (pre-declaration drivers keep working)', async function () {
        let eng    = makeRound(btcEncoderSpy());
        let signed = sinon.stub().resolves({ txid: 'd'.repeat(64) });
        eng.setBroadcastHook(signed);
        await eng._broadcastVerdict('NODEPROOF|wire');
        assert.strictEqual(signed.callCount, 1);
    });

    // The spend guard reserves budget before the broadcast, so the refusal has to
    // land ahead of it: a standing misconfiguration must not eat a window's spend
    // allowance, nor claim the round.
    it('does not reserve spend budget or claim the round on a wrong-chain wiring', async function () {
        let spies   = makeSpies();
        let hooks   = buildSignerHooks(loadTemplate(spies), TEMPLATE);
        let encoder = btcEncoderSpy();
        let eng     = makeRound(encoder);
        eng.setWalletSignHook(hooks.walletSignFn, 'DOGE');

        eng.spendGuard = {
            check:   sinon.stub().returns({ ok: true }),
            reserve: sinon.stub().returns('token'),
            commit:  sinon.stub(),
            release: sinon.stub()
        };

        const epoch = 144;
        const challengeId = crypto.createHash('sha256').update('cid').digest('hex');
        eng.rounds.set(epoch, {
            finalized: false,
            passList: ['c'.repeat(64)],
            eligible: new Set([ME]),
            sigs: new Map([[ME, 'sig']]),
            challengeId,
            target: 'HASH@1',
            leadRank: 0
        });

        let warned = await captureWarn(() => eng._maybeFinalize(epoch));
        assert.strictEqual(warned.length, 1);
        assert.match(warned[0], /REFUSING to publish a NODEPROOF verdict/);
        assert.strictEqual(eng.spendGuard.check.callCount, 0, 'budget must not be touched');
        assert.strictEqual(eng.spendGuard.reserve.callCount, 0);
        assert.strictEqual(eng.rounds.get(epoch).finalized, false,
            'the round stays unclaimed so a correctly-configured restart can still publish it');
        assert.strictEqual(spies.wallet.signPsbt.callCount, 0);
        assert.strictEqual(encoder.getUtxos.callCount, 0);
    });
});
