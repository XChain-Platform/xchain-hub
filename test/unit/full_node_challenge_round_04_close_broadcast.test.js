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

const sinon        = require('sinon');
const crypto       = require('crypto');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');
const EventEmitter = require('events');

const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);
const P1 = 'c'.repeat(64);
const P2 = 'd'.repeat(64);
const X  = 'e'.repeat(64);

const SEED = 'ab'.repeat(32);

let axiosStub, ValidatorIdentityStub, FullNodeChallengeRound;
function loadModule() {
    axiosStub = { post: sinon.stub() };
    ValidatorIdentityStub = function () {};
    ValidatorIdentityStub.verify = sinon.stub().returns(true);
    FullNodeChallengeRound = proxyquire('../../src/consensus/full_node_challenge_round', {
        axios: axiosStub,
        '../validators/identity.js': ValidatorIdentityStub,
    });
}

function makeIdentity(pubkey) {
    return { getPubkeyHex: () => pubkey, sign: (s) => 'sig:' + pubkey };
}

function fullnodeCfg(overrides) {
    return Object.assign({
        POLL_MS: 30000,
        COLLECT_MS: 20000,
        BTC_RPC: 'http://coin',
    }, overrides || {});
}

function setGenesisVerifiers(list) {
    if (list === undefined || list === null) delete process.env.FULLNODE_GENESIS_VERIFIERS;
    else process.env.FULLNODE_GENESIS_VERIFIERS = [].concat(list).join(',');
}

function makeHub(overrides) {
    overrides = overrides || {};
    let pm = new EventEmitter();
    pm.broadcast = sinon.stub();
    let hub = {
        peerManager: pm,
        identity: overrides.identity !== undefined ? overrides.identity : makeIdentity(V1),
        capabilitySnapshot: {
            getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: P1 }] }),
        },
        network: 'regtest',
        p2pConfig: {
            FULLNODE: fullnodeCfg(overrides.fullnode),
            cross_chain: { chains: { BTC: { rpc: 'http://coin' } } },
            BTC_INDEXER_URL: 'http://ix',
        },
    };
    hub._pm = pm;
    return Object.assign(hub, overrides.hub || {});
}

function wireRpc({ ledgerHash = SEED, tip = 300, verifiers = [], block } = {}) {
    axiosStub.post.callsFake(async (url, body) => {
        const m = body.method;
        if (m === 'getblockhashes') {
            const bi = body.params && body.params.block_index !== undefined ? body.params.block_index : tip;
            return { data: { result: { block_index: bi, ledger_hash: ledgerHash } } };
        }
        if (m === 'getfullnodeverifiers') return { data: { result: { validators: verifiers } } };
        if (m === 'getblockhash')         return { data: { result: 'HASH@' + (body.params && body.params[0]) } };
        if (m === 'getblock')             return { data: { result: block } };
        return { data: { result: null } };
    });
}

function deriveChallengeId(network, epoch, ledger, target) {
    return crypto.createHash('sha256')
        .update(String(network) + ':' + epoch + ':' + String(ledger) + ':' + target).digest('hex');
}

function installSuiteHooks1() {
    beforeEach(() => { loadModule(); setGenesisVerifiers(V1); });
    afterEach(() => { sinon.restore(); setGenesisVerifiers(null); });
}

const block = { tx: [{ vout: [{ scriptPubKey: { hex: 'deadbeef' } }] }] };

function makeMockEncoder() {
            return {
                createTxArgs: null,
                getUtxos:    sinon.stub().resolves([{ txid: 'a'.repeat(64), vout: 0, value: 1 }]),
                createTx:    function (args) { this.createTxArgs = args; return Promise.resolve({ psbt: 'deadbeef' }); },
                broadcastTx: sinon.stub().resolves({ txid: 'verdict-txid' })
            };
        }

function wireEncoder(eng, encoder) {
            eng.broadcastFn  = null;
            eng.encoder      = encoder;
            eng.walletSignFn = sinon.stub().resolves('00'.repeat(32));
            eng.btcAddress   = '1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        }

// ── chain-anchored collection close (the keystone: all hubs close a round at
// the same chain height, so the leader has every answer regardless of when
// each hub locally detected the epoch) ──────────────────────────────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('_tick chain-anchored close', function () {
it('closes a round only once the tip reaches epoch + closeDepth', async function () {
            const hub = makeHub();   // identity V1 (genesis verifier + claimant)
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: V1 }] });
            const eng = new FullNodeChallengeRound(hub);   // closeDepth defaults to 3
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });

            // tip = 288 → round created for epoch 288; close not due until tip ≥ 291.
            wireRpc({ ledgerHash: SEED, tip: 288, verifiers: [], block });
            await eng._tick();
            expect(eng.rounds.has(288), 'round started').to.equal(true);
            expect(eng.rounds.get(288).closed, 'open at tip 288').to.equal(false);

            // tip = 290 (< epoch + closeDepth) → still open.
            wireRpc({ ledgerHash: SEED, tip: 290, verifiers: [], block });
            await eng._tick();
            expect(eng.rounds.get(288).closed, 'open at tip 290').to.equal(false);

            // tip = 291 (= epoch + closeDepth) → closes.
            wireRpc({ ledgerHash: SEED, tip: 291, verifiers: [], block });
            await eng._tick();
            expect(eng.rounds.get(288).closed, 'closed at tip 291').to.equal(true);
        });
// The poll is a plain setInterval, so a tick that outruns pollMs (three
// sequential indexer calls at a 15s timeout each, against a 30s poll) would
// otherwise overlap: both runs pass the rounds.has(epoch) test before either
// reaches rounds.set inside runEpoch, starting one epoch twice.
it('a second overlapping tick returns instead of starting the epoch twice', async function () {
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: V1 }] });
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });
            wireRpc({ ledgerHash: SEED, tip: 288, verifiers: [], block });

            // A slow indexer: the first tick is still awaiting when the second fires.
            let release;
            const gate = new Promise((res) => { release = res; });
            const realCall = eng._indexerCall.bind(eng);
            let first = true;
            eng._indexerCall = async (m, p) => {
                if (first) { first = false; await gate; }
                return realCall(m, p);
            };
            const runEpoch = sinon.spy(eng, 'runEpoch');

            const a = eng._tick();
            const b = eng._tick();      // fires while a is parked on the gate
            await b;                    // returns immediately, guarded
            expect(runEpoch.callCount, 'the guarded tick did no work').to.equal(0);
            release();
            await a;
            expect(runEpoch.callCount, 'only the first tick ran the epoch').to.equal(1);
            expect(eng._ticking, 'flag released in finally').to.equal(false);
        });
});
});

describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('_tick chain-anchored close', function () {
it('releases the in-flight flag when a tick throws', async function () {
            const hub = makeHub();
            const eng = new FullNodeChallengeRound(hub);
            eng._indexerCall = async () => { throw new Error('indexer down'); };
            try { await eng._tick(); } catch (e) { /* start()'s wrapper swallows this */ }
            expect(eng._ticking, 'a rejected indexer call must not wedge the poll').to.equal(false);
        });
});
});

// ── encoder fallback broadcast ────────────────────────────────────────────
// The no-hook branch (operator signer exports walletSign but not the optional
// broadcast) once called createTx({ source, data }). The encoder has no `source`
// param and rejects a missing pubkey with RangeError('pubkey is required') before
// building anything, so that branch could never land a verdict. Pin the shape
// against the encoder's real contract, the same way PublisherDefaultBroadcast.test.js
// pins it for the four sibling publishers.
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('broadcastVerdict (encoder fallback)', function () {
it('fetches UTXOs and calls createTx with the encoder contract, not { source }', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            wireEncoder(eng, encoder);

            const res = await eng.broadcastVerdict('NODEPROOF|0|cid|288|0|0');

            expect(encoder.getUtxos.calledOnceWith(eng.btcAddress), 'UTXOs fetched first').to.equal(true);
            expect(encoder.createTxArgs).to.be.an('object');
            expect(encoder.createTxArgs.source, 'source is not an encoder param').to.equal(undefined);
            // The encoder's P2SH path runs fromBase58Check on this field, so it carries
            // the address, not a hex pubkey.
            expect(encoder.createTxArgs.pubkey).to.equal(eng.btcAddress);
            expect(encoder.createTxArgs.change).to.equal(eng.btcAddress);
            expect(encoder.createTxArgs.encoding).to.equal('P2SH');
            expect(encoder.createTxArgs.utxos).to.have.lengthOf(1);
            expect(eng.walletSignFn.calledOnceWith('deadbeef'), 'signs the returned .psbt').to.equal(true);
            expect(res.txid).to.equal('verdict-txid');
        });
it('throws before signing when the encoder returns no psbt', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            // create_tx only ever answers with `psbt`; psbtHex/hex were guesses that
            // could only ever hand the signer undefined.
            encoder.createTx = () => Promise.resolve({ psbtHex: 'deadbeef' });
            wireEncoder(eng, encoder);

            let threw = false;
            try { await eng.broadcastVerdict('NODEPROOF|0|cid|288|0|0'); }
            catch (e) { threw = true; expect(e.message).to.include('no PSBT'); }
            expect(threw).to.equal(true);
            expect(eng.walletSignFn.called, 'never signs an absent PSBT').to.equal(false);
            expect(encoder.broadcastTx.called).to.equal(false);
        });
it('throws before createTx when the address has no UTXOs', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            encoder.getUtxos = sinon.stub().resolves([]);
            wireEncoder(eng, encoder);

            let threw = false;
            try { await eng.broadcastVerdict('NODEPROOF|0|cid|288|0|0'); }
            catch (e) { threw = true; expect(e.message).to.include('no UTXOs'); }
            expect(threw).to.equal(true);
            expect(encoder.createTxArgs, 'no build attempted').to.equal(null);
        });
});
});

describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('broadcastVerdict (encoder fallback)', function () {
it('the operator broadcast hook still short-circuits the encoder path', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            wireEncoder(eng, encoder);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'hook-txid' });

            const res = await eng.broadcastVerdict('NODEPROOF|0|cid|288|0|0');
            expect(res.txid).to.equal('hook-txid');
            expect(encoder.getUtxos.called).to.equal(false);
        });
});
});
