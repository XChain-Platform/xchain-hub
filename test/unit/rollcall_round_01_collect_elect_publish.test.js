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

const ValidatorIdentity    = require('../../src/validators/identity.js');
const StateAnchorPublisher = require('../../src/anchor/publisher.js');
const rca                  = require('../../src/rollcall_activation.js');
const rga                  = require('../../src/rollcall_gates_activation.js');
const { knownGateKeys }    = require('../../src/consensus_rules_digest.js');

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
    RollcallRound = proxyquire('../../src/rollcall/round.js', { axios: axiosStub });
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

async function collecting() {
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            await eng._tick();
            return eng;
        }

function signOf(eng, idx) {
            return IDS[idx].sign(eng._canonical(EPOCH, LEDGER_HASH));
        }

function atRank(rank, env, hubOpts) {
            const order = orderFor(PKS, EPOCH);
            const idx   = PKS.indexOf(order[rank]);
            return makeEngine(Object.assign({ identity: IDS[idx] }, hubOpts || {}),
                              Object.assign({ ROLLCALL_SELF_PUBLISH_BLOCKS: 99 }, env || {}));
        }

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('collect', function () {
it('keeps a peer signature that verifies and is in the snapshot', async function () {
            const eng = await collecting();
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: signOf(eng, 1) } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), true);
        });
it('keeps a peer signature that arrived BEFORE this hub opened the epoch', async function () {
            // A peer broadcasts once, when it signs, and never again. On the
            // acceptance venue (epoch 4980, 2026-09-04) the elected leader was the
            // hub that signed last, so it dropped the earlier signer's gossip on
            // "no such round" and led with a partial set for the whole window.
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: signOf(eng, 1) } });
            assert.strictEqual(eng.rounds.has(EPOCH), false, 'the round is not open yet');
            await eng._tick();
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), true,
                'the early signature must be applied when the round opens');
            assert.strictEqual(eng._earlySigs.size, 0, 'the holding area is drained');
        });
it('judges an early signature by the same rule as a live one', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: IDS[1].sign(eng._canonical(60, LEDGER_HASH)) } });
            await eng._tick();
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), false,
                'a held signature that does not verify is dropped at the drain, never admitted unverified');
        });
it('drops a signature that does not verify over OUR canonical', async function () {
            const eng = await collecting();
            // A real signature by the right key over a DIFFERENT epoch: correct
            // shape, correct signer, wrong binding.
            const wrongEpochSig = IDS[1].sign(eng._canonical(60, LEDGER_HASH));
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: wrongEpochSig } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), false);
        });
it('drops a signer that is not in the federation snapshot', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({ members: [PKS[0]] });
            await eng._tick();
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: signOf(eng, 1) } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), false);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('collect', function () {
it('a garbage pair arriving FIRST cannot suppress the real signature', async function () {
            // Marking a key seen on first sight instead of after verification is
            // how a spam pair reads downstream as an absence, and an absence over
            // K epochs is an eviction.
            const eng = await collecting();
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: 'a'.repeat(128) } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), false);
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: signOf(eng, 1) } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.get(PKS[1]), signOf(eng, 1));
        });
it('dedupes by pubkey: the first verified signature wins', async function () {
            const eng = await collecting();
            const real = signOf(eng, 1);
            eng._handleMessage({ type: 'XROLLCALL_SIGN', data: { epoch: EPOCH, pubkey: PKS[1], sig: real } });
            // A second, differently-shaped payload for the same key must not replace it.
            eng._handleMessage({ type: 'XROLLCALL_SIGN', data: { epoch: EPOCH, pubkey: PKS[1], sig: 'b'.repeat(128) } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.get(PKS[1]), real);
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.size, 2, 'ours plus one peer');
        });
it('ignores malformed pubkeys, malformed signatures and unknown epochs', async function () {
            const eng = await collecting();
            const before = eng.rounds.get(EPOCH).sigs.size;
            eng._handleMessage({ type: 'XROLLCALL_SIGN', data: { epoch: EPOCH, pubkey: 'zz', sig: signOf(eng, 1) } });
            eng._handleMessage({ type: 'XROLLCALL_SIGN', data: { epoch: EPOCH, pubkey: PKS[1], sig: 'short' } });
            eng._handleMessage({ type: 'XROLLCALL_SIGN', data: { epoch: 999, pubkey: PKS[1], sig: signOf(eng, 1) } });
            eng._handleMessage({ type: 'SOMETHING_ELSE', data: { epoch: EPOCH } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.size, before);
        });
it('applies NO stake floor and computes NO quorum', async function () {
            // A member with dust weight is kept: the chain decides membership, and
            // a hub-side floor could only ever discard a signature it would count.
            wireRpc({ tip: 36 });
            const hub = makeHub({});
            hub.capabilitySnapshot.getActiveWeightSnapshot = sinon.stub().resolves({
                validators: [{ pubkey: PKS[0], source: 's', weight: '1000' },
                             { pubkey: PKS[1], source: 's', weight: '0.00000001' }]
            });
            const eng = new RollcallRound(hub);
            eng.hub = hub;
            await eng._tick();
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: IDS[1].sign(eng._canonical(EPOCH, LEDGER_HASH)) } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), true);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('elect', function () {
it('resolves the election set at the RAW epoch, letting CapabilitySnapshot bury it once', async function () {
            // CapabilitySnapshot subtracts CANONICAL_REORG_BUFFER itself, so E lands
            // on E-6, which is where the chain resolves R(E). Passing an already
            // buried height would resolve at E-12 and elect a leader the BTC close
            // does not pay.
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            await eng._tick();
            const call = eng.hub.capabilitySnapshot.getWeightSnapshot.getCall(0);
            assert.ok(call, 'the election set must be resolved');
            assert.deepStrictEqual(call.args, ['oracle_publish', EPOCH]);
        });
it('borrows StateAnchorPublisher._resolveCapabilitySet when the anchor rail is up', async function () {
            wireRpc({ tip: 36 });
            const resolve = sinon.stub().resolves(PKS.map(pk => ({ pubkey: pk, amount: '1', source: 's' })));
            const eng = makeEngine({ stateAnchorPublisher: { _resolveCapabilitySet: resolve } });
            await eng._tick();
            assert.deepStrictEqual(resolve.getCall(0).args, ['oracle_publish', EPOCH, 'regtest']);
            assert.strictEqual(eng.hub.capabilitySnapshot.getWeightSnapshot.callCount, 0,
                'one resolver, so the hub cannot disagree with the chain two ways');
        });
it('orders by hashOrder over XROLLCALL|network|epoch', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            const order = await eng._electionOrder(EPOCH);
            assert.deepStrictEqual(order, orderFor(PKS, EPOCH));
            // The key really binds the epoch, or every epoch would elect the same leader.
            assert.notDeepStrictEqual(orderFor(PKS, EPOCH), orderFor(PKS, EPOCH + 30));
        });
it('abstains from publishing when the election set is unresolved', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({ candidates: null });
            await eng._tick();
            assert.strictEqual(await eng._electionOrder(EPOCH), null);
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('publish', function () {
it('the leader publishes every collected signature once the delay has passed', async function () {
            wireRpc({ tip: 38 });
            const eng = atRank(0, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 8 });
            await eng._tick();
            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 1);
            const w = parseWire(bc.getCall(0).args[0]);
            assert.strictEqual(w.action, 'ROLLCALL');
            assert.strictEqual(w.epoch, EPOCH);
            assert.strictEqual(w.ledgerHash, LEDGER_HASH);
            assert.strictEqual(w.publisher, eng.identity.getPubkeyHex().toLowerCase());
            assert.strictEqual(w.sigCount, w.pairs.length);
        });
it('the leader does NOT publish before E + ROLLCALL_PUBLISH_DELAY_BLOCKS', async function () {
            wireRpc({ tip: 37 });                       // since = 7, delay = 8
            const eng = atRank(0, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 8 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('a sweeper stays locked until its rank comes up on the ladder', async function () {
            // Rank 2 at ladder step 2 needs since >= 4; the round is created at
            // since = 6, so pin the step high enough that it is still locked.
            wireRpc({ tip: 36 });
            const eng = atRank(2, { ROLLCALL_ELECTION_TOLERANCE_BLOCKS: 5 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0,
                'rank 2 needs since >= 10, and since is 6');
            assert.strictEqual(eng.rounds.get(EPOCH).myRank, 2);
        });
it('a sweeper publishes ONLY the signatures the leader left off chain', async function () {
            const order = orderFor(PKS, EPOCH);
            // Everyone but the last-ranked key is already on chain.
            const onChain = {};
            for (const pk of order.slice(0, order.length - 1)) onChain[pk] = LEDGER_HASH;
            const missing = order[order.length - 1];

            wireRpc({ tip: 38, onChain });
            const eng = atRank(1, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_ELECTION_TOLERANCE_BLOCKS: 2 });
            // Collect every peer's real signature so there is something to sweep.
            await eng._tick();
            const canon = eng._canonical(EPOCH, LEDGER_HASH);
            for (let i = 0; i < IDS.length; i++)
                eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                     data: { epoch: EPOCH, pubkey: PKS[i], sig: IDS[i].sign(canon) } });
            await eng._tick();

            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 1);
            const w = parseWire(bc.getCall(0).args[0]);
            assert.deepStrictEqual(w.pairs.map(p => p.pubkey), [missing],
                'a sweeper that re-publishes what already landed is paying a fee for nothing');
        });
});
});
