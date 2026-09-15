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
// RollcallRound engine behaviour, driven through the real _tick() against a
// stubbed indexer pair. Everything signature-shaped uses REAL Ed25519 identities:
// a stubbed verifier would certify a canonical nobody ever checked.
//
// Regtest constants are in force throughout (interval 30, accept window 12,
// reorg buffer 6, publish delay 1, ladder step 2, self-publish 6), so the epoch
// under test is 30 and the window runs from tip 36 to tip 42.

const sinon        = require('sinon');
const assert       = require('assert');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const proxyquire   = require('proxyquire');
const EventEmitter = require('events');

const ValidatorIdentity    = require('../../../src/validators/identity.js');
const StateAnchorPublisher = require('../../../src/anchor/publisher.js');
const rca                  = require('../../../src/rollcall_activation.js');
const rga                  = require('../../../src/rollcall_gates_activation.js');
const { knownGateKeys }    = require('../../../src/consensus_rules_digest.js');

const BTC_URL  = 'http://btc-indexer.test';
const DOGE_URL = 'http://doge-indexer.test';
const LEDGER_HASH = '4a7f1e93c25b8d0617ae42f9308c5b7de1409263a8f5c07be3d4192c6f8ab5e1';
const EPOCH = 30;

// Distinct real keys. Seeds are fixed so a failure is reproducible.
const SEEDS = ['11', '22', '33', '44', '55'].map(s => s.repeat(32));
const IDS   = SEEDS.map(s => new ValidatorIdentity(s));
const PKS   = IDS.map(i => i.getPubkeyHex().toLowerCase());

const ENV_KEYS = ['ROLLCALL_ENABLED', 'ROLLCALL_POLL_MS', 'ROLLCALL_PUBLISH_DELAY_BLOCKS',
                  'ROLLCALL_ELECTION_TOLERANCE_BLOCKS', 'ROLLCALL_SELF_PUBLISH_BLOCKS',
                  'ROLLCALL_SPEND_LOG_PATH', 'ROLLCALL_SIGN_LOG_PATH',
                  'ROLLCALL_MAX_PUBLISHES_PER_WINDOW',
                  'BTC_INDEXER_URL', 'DOGE_INDEXER_URL', 'DOGE_INDEXER_API_URL',
                  'DOGE_LOW_BALANCE_THRESHOLD', 'DOGE_ADDRESS', 'DOGE_ENCODER_URL',
                  'HUB_SIGNER_MODULE'];

let axiosStub, RollcallRound, tmpDir, savedEnv;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    RollcallRound = proxyquire('../../../src/rollcall/round.js', { axios: axiosStub });
}

// Indexer dispatcher: the BTC indexer answers getblockhashes (tip and per-block
// ledger_hash), the DOGE indexer answers getrollcallsigners.
function wireRpc({ tip = 36, ledgerHash = LEDGER_HASH, onChain = {}, hcut = 100,
                   btcFail = false, dogeFail = false, dogeHcutNull = false } = {}) {
    axiosStub.post.callsFake(async (url, body) => {
        if (url === BTC_URL) {
            if (btcFail) throw new Error('btc indexer unreachable');
            if (body.method !== 'getblockhashes') return { data: { result: null } };
            const bi = (body.params && body.params.block_index !== undefined) ? body.params.block_index : tip;
            return { data: { result: { block_index: bi, ledger_hash: ledgerHash } } };
        }
        if (url === DOGE_URL) {
            if (dogeFail) throw new Error('doge indexer unreachable');
            if (body.method !== 'getrollcallsigners') return { data: { result: null } };
            const signers = {};
            for (const pk of (body.params.pubkeys || [])) {
                signers[pk] = onChain[pk]
                    ? { sig: 'f'.repeat(128), ledger_hash: onChain[pk], publisher: PKS[0],
                        action_index: 1, block_index: 5 }
                    : null;
            }
            return { data: { result: { hcut: dogeHcutNull ? null : hcut, tip_block_index: 200,
                                       tip_block_time: 1, manifest_hash: 'x', signers,
                                       publishers: {} } } };
        }
        return { data: { result: null } };
    });
}

function makeHub(o) {
    o = o || {};
    const pm = new EventEmitter();
    pm.broadcast = sinon.stub();
    const hub = {
        network: 'regtest',
        peerManager: o.peerManager === null ? null : pm,
        identity: o.identity !== undefined ? o.identity : IDS[0],
        capabilitySnapshot: {
            // The advisory whole-federation set. Null models any indexer failure.
            getActiveWeightSnapshot: sinon.stub().resolves(
                o.members === null ? null
                    : { validators: (o.members || PKS).map(pk => ({ pubkey: pk, source: 's', weight: '1000' })) }),
            // The election set (oracle_publish capability members).
            getWeightSnapshot: sinon.stub().resolves(
                o.candidates === null ? null
                    : { validators: (o.candidates || PKS).map(pk => ({ pubkey: pk, source: 's', weight: '1000' })) }),
        },
        oraclePublisher: o.oraclePublisher !== undefined ? o.oraclePublisher : {
            broadcastFn:  sinon.stub().resolves({ txid: 'txid-1' }),
            walletSignFn: sinon.stub(),
            getBalanceFn: sinon.stub().resolves(1000),
            encoder:      null
        },
        stateAnchorPublisher: o.stateAnchorPublisher || null,
        p2pConfig: {},
        _resolveBtcIndexerUrl: async () => BTC_URL,
        btcIndexerHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    hub._pm = pm;
    return hub;
}

function makeEngine(hubOpts, env) {
    for (const [k, v] of Object.entries(env || {})) process.env[k] = String(v);
    const hub = makeHub(hubOpts);
    const eng = new RollcallRound(hub);
    eng.hub = hub;
    return eng;
}

// Election order for a candidate set, computed with the real hashOrder so a test
// never asserts against a rank it guessed.
function orderFor(candidates, epoch) {
    return StateAnchorPublisher.hashOrder('XROLLCALL|regtest|' + epoch, candidates);
}

// Parse a broadcast ROLLCALL payload back into its fields.
function parseWire(payload) {
    const f = payload.split('|');
    const pairs = [];
    for (let i = 6; i < f.length; i += 2) pairs.push({ pubkey: f[i], sig: f[i + 1] });
    return { action: f[0], version: f[1], epoch: Number(f[2]), ledgerHash: f[3],
             publisher: f[4], sigCount: Number(f[5]), pairs };
}

let savedRegtestActivation;

function installSuiteHooks1() {
    before(function () {
            savedRegtestActivation = rca.ROLLCALL_ACTIVATION.regtest;
            rca.ROLLCALL_ACTIVATION.regtest = 0;
        });
    after(function () { rca.ROLLCALL_ACTIVATION.regtest = savedRegtestActivation; });
    beforeEach(function () {
            savedEnv = {};
            for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-test-'));
            for (const k of ENV_KEYS) delete process.env[k];
            process.env.BTC_INDEXER_URL   = BTC_URL;
            process.env.DOGE_INDEXER_URL  = DOGE_URL;
            process.env.ROLLCALL_SPEND_LOG_PATH = path.join(tmpDir, 'spend.jsonl');
            process.env.ROLLCALL_SIGN_LOG_PATH  = path.join(tmpDir, 'sign.jsonl');
            // Keep the SpendGuard's state file out of the checkout.
            process.env.ROLLCALL_SPEND_STATE_PATH = path.join(tmpDir, 'guard.json');
            loadModule();
        });
    afterEach(function () {
            sinon.restore();
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k];
                else process.env[k] = savedEnv[k];
            }
            delete process.env.ROLLCALL_SPEND_STATE_PATH;
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        });
}

const GATES = knownGateKeys().join(',');

let savedGates;

function parseWireV1(payload) {
            const f = payload.split('|');
            const pairs = [];
            for (let i = 7; i < f.length; i += 2) pairs.push({ pubkey: f[i], sig: f[i + 1] });
            return { action: f[0], version: f[1], epoch: Number(f[2]), ledgerHash: f[3],
                     publisher: f[4], gates: f[5], sigCount: Number(f[6]), pairs };
        }

function installSuiteHooks2() {
    beforeEach(function () { savedGates = rga.ROLLCALL_GATES_ACTIVATION.regtest; });
    afterEach(function () { rga.ROLLCALL_GATES_ACTIVATION.regtest = savedGates; });
}

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('ROLLCALL v1 above the gates height', function () {
    installSuiteHooks2();
it('publishes v1 carrying this build\'s gate list, signed over the v1 canonical', async function () {
            rga.ROLLCALL_GATES_ACTIVATION.regtest = 0;
            wireRpc({ tip: 42 });
            const order = orderFor(PKS, EPOCH);
            const eng = makeEngine({ identity: IDS[PKS.indexOf(order[0])] },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_SELF_PUBLISH_BLOCKS: 99 });
            await eng._tick();

            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 1);
            const w = parseWireV1(bc.getCall(0).args[0]);
            assert.strictEqual(w.version, '1');
            assert.strictEqual(w.gates, GATES, 'GATES is knownGateKeys() joined, as published');
            assert.strictEqual(w.sigCount, w.pairs.length);
            // The signature on the wire must verify over the canonical the DOGE parser
            // rebuilds from the CARRIED gates, and must NOT verify over the v0 form:
            // a site that quietly dropped GATES would still accept it otherwise.
            const v1 = eng._canonical(EPOCH, LEDGER_HASH, GATES);
            const v0 = eng._canonical(EPOCH, LEDGER_HASH);
            const mine = w.pairs.find(p => p.pubkey === order[0]);
            assert.ok(mine, 'the publisher signed its own roll call');
            assert.strictEqual(ValidatorIdentity.verify(v1, mine.sig, order[0]), true);
            assert.strictEqual(ValidatorIdentity.verify(v0, mine.sig, order[0]), false,
                'the v1 signature must be bound to the gates commitment');
        });
it('verifies a peer\'s signature against the SAME canonical for the epoch', async function () {
            rga.ROLLCALL_GATES_ACTIVATION.regtest = 0;
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            await eng._tick();
            const state = eng.rounds.get(EPOCH);
            assert.strictEqual(state.gates, GATES);
            assert.strictEqual(state.canonical, eng._canonical(EPOCH, LEDGER_HASH, GATES));

            // A peer on the same build: counted.
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: IDS[1].sign(state.canonical) } });
            assert.strictEqual(state.sigs.has(PKS[1]), true);
            // A peer still signing the v0 canonical (an un-upgraded build, or one whose
            // gate list differs) verifies against nothing and is simply absent. This is
            // the cost §7.2 names: roll the fleet BETWEEN epochs, never across one.
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[2],
                                         sig: IDS[2].sign(eng._canonical(EPOCH, LEDGER_HASH)) } });
            assert.strictEqual(state.sigs.has(PKS[2]), false);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('ROLLCALL v1 above the gates height', function () {
    installSuiteHooks2();
it('is v0, byte for byte, for an epoch BELOW the gates height', async function () {
            // The same engine, one block of threshold apart: the only thing that
            // decides the form is the epoch height.
            rga.ROLLCALL_GATES_ACTIVATION.regtest = EPOCH + 1;
            wireRpc({ tip: 42 });
            const order = orderFor(PKS, EPOCH);
            const eng = makeEngine({ identity: IDS[PKS.indexOf(order[0])] },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_SELF_PUBLISH_BLOCKS: 99 });
            await eng._tick();
            assert.strictEqual(eng.rounds.get(EPOCH).gates, null);
            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 1);
            const w = parseWire(bc.getCall(0).args[0]);
            assert.strictEqual(w.version, '0');
            assert.strictEqual(w.sigCount, w.pairs.length);
            const mine = w.pairs.find(p => p.pubkey === order[0]);
            assert.strictEqual(ValidatorIdentity.verify(eng._canonical(EPOCH, LEDGER_HASH),
                                                        mine.sig, order[0]), true);
        });
it('stays v0 where the height is the INERT null placeholder', async function () {
            // `0 >= null` is true in JS; only the isFinite guard keeps an unarmed
            // network on v0, and an accidental v1 there forks the whole federation.
            rga.ROLLCALL_GATES_ACTIVATION.regtest = null;
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            await eng._tick();
            assert.strictEqual(eng.rounds.get(EPOCH).gates, null);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('ROLLCALL v1 above the gates height', function () {
    installSuiteHooks2();
it('splits at the DERIVED v1 cap, not the v0 41', async function () {
            rga.ROLLCALL_GATES_ACTIVATION.regtest = 0;
            const cap = RollcallRound.maxPairsForGates(GATES);
            assert.ok(cap > 0 && cap < RollcallRound.MAX_PAIRS_PER_ACTION,
                'the live gate list must cost pairs, or this case proves nothing');

            const many = [];
            const ids  = [];
            for (let i = 0; i < cap + 4; i++) {
                const id = new ValidatorIdentity(i.toString(16).padStart(2, '0').repeat(32));
                ids.push(id);
                many.push(id.getPubkeyHex().toLowerCase());
            }
            const order = orderFor(many, EPOCH);
            wireRpc({ tip: 36 });
            const eng = makeEngine({ identity: ids[many.indexOf(order[0])], members: many, candidates: many },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 8, ROLLCALL_SELF_PUBLISH_BLOCKS: 99 });
            await eng._tick();
            const canon = eng._canonical(EPOCH, LEDGER_HASH, GATES);
            for (let i = 0; i < ids.length; i++)
                eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                     data: { epoch: EPOCH, pubkey: many[i], sig: ids[i].sign(canon) } });
            wireRpc({ tip: 38 });
            await eng._tick();

            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 2);
            assert.deepStrictEqual(bc.getCalls().map(c => parseWireV1(c.args[0]).sigCount), [cap, 4]);
            // The bound that matters is the byte one: an action past the ceiling is
            // dropped by the decoder with nothing going red anywhere.
            for (const c of bc.getCalls())
                assert.ok(Buffer.byteLength(c.args[0], 'utf8') <= RollcallRound.ACTION_DATA_CEILING,
                    'a published v1 action is ' + Buffer.byteLength(c.args[0], 'utf8') + ' bytes');
            // Every signature rides exactly one action; a split may cost a fee and
            // must never cost a signature.
            const seen = new Set();
            for (const c of bc.getCalls()) for (const p of parseWireV1(c.args[0]).pairs) seen.add(p.pubkey);
            assert.strictEqual(seen.size, cap + 4);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('ROLLCALL v1 above the gates height', function () {
    installSuiteHooks2();
it('refuses to publish rather than build an action past the ceiling', async function () {
            // A GATES list longer than the ceiling leaves room for no pair at all.
            // chunkPairs falls back to the v0 41 on a non-positive size, so without
            // the explicit refusal this would broadcast an action the decoder drops.
            rga.ROLLCALL_GATES_ACTIVATION.regtest = 0;
            wireRpc({ tip: 42 });
            const order = orderFor(PKS, EPOCH);
            const eng = makeEngine({ identity: IDS[PKS.indexOf(order[0])] },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_SELF_PUBLISH_BLOCKS: 99 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 1, 'the normal list publishes');

            loadModule();
            wireRpc({ tip: 42 });
            const eng2 = makeEngine({ identity: IDS[PKS.indexOf(order[0])] },
                                    { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_SELF_PUBLISH_BLOCKS: 99 });
            eng2.gatesFor = () => 'a.B,'.repeat(3000);
            await eng2._tick();
            assert.strictEqual(eng2.hub.oraclePublisher.broadcastFn.callCount, 0,
                'an oversize GATES list must stop the publish, not ride out un-decodable');
            assert.strictEqual(eng2.rounds.get(EPOCH).published, false, 'the slot is released for a retry');
        });
});
});
