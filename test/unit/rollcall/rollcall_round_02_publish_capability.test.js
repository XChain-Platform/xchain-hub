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

function atRank(rank, env, hubOpts) {
            const order = orderFor(PKS, EPOCH);
            const idx   = PKS.indexOf(order[rank]);
            return makeEngine(Object.assign({ identity: IDS[idx] }, hubOpts || {}),
                              Object.assign({ ROLLCALL_SELF_PUBLISH_BLOCKS: 99 }, env || {}));
        }

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('publish', function () {
it('an on-chain row under a DIFFERENT ledger_hash does not count as present', async function () {
            // Such a row is one the BTC close discards, so treating it as presence
            // would suppress the real publish and read as an absence.
            const order   = orderFor(PKS, EPOCH);
            const onChain = {};
            for (const pk of order) onChain[pk] = 'c'.repeat(64);
            wireRpc({ tip: 38, onChain });
            const eng = atRank(0, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 1);
        });
it('publishes nothing when every collected signature is already on chain', async function () {
            const onChain = {};
            for (const pk of PKS) onChain[pk] = LEDGER_HASH;
            wireRpc({ tip: 38, onChain });
            const eng = atRank(0, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('on an undecidable DOGE read the leader publishes and a sweeper defers', async function () {
            wireRpc({ tip: 38, dogeFail: true });
            const leader = atRank(0, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await leader._tick();
            assert.strictEqual(leader.hub.oraclePublisher.broadcastFn.callCount, 1,
                'the leader publishes every epoch; a duplicate costs a fee the union rule absorbs');

            loadModule();
            wireRpc({ tip: 38, dogeFail: true });
            const sweeper = atRank(1, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_ELECTION_TOLERANCE_BLOCKS: 2 });
            await sweeper._tick();
            assert.strictEqual(sweeper.hub.oraclePublisher.broadcastFn.callCount, 0,
                'a sweeper that cannot see the gaps has nothing to add');
        });
it('a null hcut is not a positive "nobody signed"', async function () {
            wireRpc({ tip: 38, dogeHcutNull: true });
            const eng = atRank(1, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_ELECTION_TOLERANCE_BLOCKS: 2 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('a key outside the elected set never publishes as leader or sweeper', async function () {
            wireRpc({ tip: 42 });
            const eng = makeEngine({ identity: IDS[0], candidates: [PKS[1], PKS[2]] },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_SELF_PUBLISH_BLOCKS: 99 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
            assert.strictEqual(eng.rounds.get(EPOCH).myRank, -1);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('publish', function () {
it('splits past 41 pairs into several actions', async function () {
            const many = [];
            const ids  = [];
            for (let i = 0; i < 45; i++) {
                const id = new ValidatorIdentity(i.toString(16).padStart(2, '0').repeat(32));
                ids.push(id);
                many.push(id.getPubkeyHex().toLowerCase());
            }
            const order = orderFor(many, EPOCH);
            const leaderIdx = many.indexOf(order[0]);
            // Round created at since = 6 with the delay at 8, so the first tick
            // collects and does not publish; the peers' signatures land, then the
            // tip moves to since = 8 and the whole set goes out at once.
            wireRpc({ tip: 36 });
            const eng = makeEngine({ identity: ids[leaderIdx], members: many, candidates: many },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 8, ROLLCALL_SELF_PUBLISH_BLOCKS: 99 });
            await eng._tick();
            const canon = eng._canonical(EPOCH, LEDGER_HASH);
            for (let i = 0; i < ids.length; i++)
                eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                     data: { epoch: EPOCH, pubkey: many[i], sig: ids[i].sign(canon) } });
            wireRpc({ tip: 38 });
            await eng._tick();
            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 2);
            assert.deepStrictEqual(bc.getCalls().map(c => parseWire(c.args[0]).sigCount), [41, 4]);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('self-publish', function () {
it('lands a one-signature roll call when our own signature is not on chain', async function () {
            // Not in the elected set, so no ladder rank will ever carry us; the
            // escape hatch is the only route this key has to the chain.
            wireRpc({ tip: 42, onChain: {} });                 // since = 12 >= self-publish 6
            const eng = makeEngine({ identity: IDS[0], candidates: [PKS[1], PKS[2]] },
                                   { ROLLCALL_SELF_PUBLISH_BLOCKS: 6 });
            await eng._tick();
            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 1);
            const w = parseWire(bc.getCall(0).args[0]);
            assert.strictEqual(w.sigCount, 1);
            assert.strictEqual(w.pairs[0].pubkey, PKS[0]);
            assert.strictEqual(w.publisher, PKS[0]);
            assert.strictEqual(ValidatorIdentity.verify(eng._canonical(EPOCH, LEDGER_HASH),
                                                        w.pairs[0].sig, PKS[0]), true);
        });
it('does not self-publish before E + ROLLCALL_SELF_PUBLISH_BLOCKS', async function () {
            wireRpc({ tip: 38 });                              // since = 8 < 9
            const eng = makeEngine({ identity: IDS[0], candidates: [PKS[1], PKS[2]] },
                                   { ROLLCALL_SELF_PUBLISH_BLOCKS: 9 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('does not self-publish when our signature is already on chain', async function () {
            wireRpc({ tip: 42, onChain: { [PKS[0]]: LEDGER_HASH } });
            const eng = makeEngine({ identity: IDS[0], candidates: [PKS[1], PKS[2]] },
                                   { ROLLCALL_SELF_PUBLISH_BLOCKS: 6 });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('does not self-publish when our own publish already carried it', async function () {
            wireRpc({ tip: 42 });
            const order = orderFor(PKS, EPOCH);
            const eng = makeEngine({ identity: IDS[PKS.indexOf(order[0])] },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_SELF_PUBLISH_BLOCKS: 6 });
            await eng._tick();
            const bc = eng.hub.oraclePublisher.broadcastFn;
            assert.strictEqual(bc.callCount, 1, 'the leader publish, and no second self-publish behind it');
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('broadcast capability', function () {
it('never publishes without a signer module exporting broadcast(payload)', async function () {
            // walletSign alone loads cleanly through signer-loader and can sign
            // every roll call, but the built-in pipeline fails closed on the P2SH
            // two-phase encoding, so a publish would strand the payload.
            wireRpc({ tip: 42 });
            const order = orderFor(PKS, EPOCH);
            const eng = makeEngine({
                identity: IDS[PKS.indexOf(order[0])],
                oraclePublisher: { broadcastFn: null, walletSignFn: sinon.stub(),
                                   getBalanceFn: sinon.stub().resolves(1000), encoder: {} }
            }, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, ROLLCALL_SELF_PUBLISH_BLOCKS: 6 });
            await eng._tick();
            assert.strictEqual(eng.broadcastCapable(), false);
            assert.strictEqual(eng.rounds.get(EPOCH).txids.length, 0);
            assert.strictEqual(fs.existsSync(process.env.ROLLCALL_SPEND_LOG_PATH), false,
                'no publish was even attempted, so no fee intent was ever recorded');
        });
it('reports capability off the resolved signer, hooks or borrowed', function () {
            const eng = makeEngine({ oraclePublisher: null });
            assert.strictEqual(eng.broadcastCapable(), false);
            eng.setBroadcastHook(() => {});
            assert.strictEqual(eng.broadcastCapable(), true);
        });
});
});
