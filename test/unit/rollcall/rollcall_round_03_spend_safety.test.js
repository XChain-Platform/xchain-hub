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
// RollcallRound engine behaviour, driven through the real tick() against a
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
const rca                  = require('../../../src/consensus/gates/rollcall_gate.js');
const rga                  = require('../../../src/consensus/gates/rollcall_gates_gate.js');
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
        resolveBtcIndexerUrl: async () => BTC_URL,
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

function leader(env, hubOpts) {
            const order = orderFor(PKS, EPOCH);
            return makeEngine(Object.assign({ identity: IDS[PKS.indexOf(order[0])] }, hubOpts || {}),
                              Object.assign({ ROLLCALL_SELF_PUBLISH_BLOCKS: 99 }, env || {}));
        }

async function twoChunkLeader(env) {
            const many = [];
            const ids  = [];
            for (let i = 0; i < 45; i++) {
                const id = new ValidatorIdentity(i.toString(16).padStart(2, '0').repeat(32));
                ids.push(id);
                many.push(id.getPubkeyHex().toLowerCase());
            }
            const order     = orderFor(many, EPOCH);
            const leaderIdx = many.indexOf(order[0]);
            wireRpc({ tip: 36 });
            const eng = makeEngine({ identity: ids[leaderIdx], members: many, candidates: many },
                                   Object.assign({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 8,
                                                   ROLLCALL_SELF_PUBLISH_BLOCKS: 99 }, env || {}));
            await eng.tick();
            const canon = eng.canonical(EPOCH, LEDGER_HASH);
            for (let i = 0; i < ids.length; i++)
                eng.handleMessage({ type: 'XROLLCALL_SIGN',
                                     data: { epoch: EPOCH, pubkey: many[i], sig: ids[i].sign(canon) } });
            wireRpc({ tip: 38 });
            return { eng, many, myPubkey: many[leaderIdx] };
        }

function spendPhases() {
            let text;
            try { text = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8'); }
            catch (_) { return []; }
            return text.trim() ? text.trim().split('\n').map(l => JSON.parse(l).phase) : [];
        }

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('spend safety', function () {
it('refuses to publish with the wallet under DOGE_LOW_BALANCE_THRESHOLD', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, DOGE_LOW_BALANCE_THRESHOLD: '10' },
                               { oraclePublisher: { broadcastFn: sinon.stub().resolves({ txid: 't' }),
                                                    walletSignFn: sinon.stub(),
                                                    getBalanceFn: sinon.stub().resolves(1), encoder: null } });
            await eng.tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('fails closed when the wallet balance is unreadable', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, DOGE_LOW_BALANCE_THRESHOLD: '10' },
                               { oraclePublisher: { broadcastFn: sinon.stub().resolves({ txid: 't' }),
                                                    walletSignFn: sinon.stub(),
                                                    getBalanceFn: sinon.stub().rejects(new Error('rpc down')),
                                                    encoder: null } });
            await eng.tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('refuses to publish while the effector is paused', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            eng.spendGuard.pause('drill');
            await eng.tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('writes a durable intent BEFORE the money moves and gates the send on it', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await eng.tick();
            const lines = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8')
                            .trim().split('\n').map(JSON.parse);
            assert.strictEqual(lines[0].phase, 'intent');
            assert.strictEqual(lines[0].epoch, EPOCH);
            assert.strictEqual(lines[1].phase, 'sent');
            assert.strictEqual(lines[1].txid, 'txid-1');
        });
it('defers the publish when the spend-audit path is unwritable', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            sinon.stub(eng, 'recordSpend').returns(false);
            await eng.tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0,
                'a real DOGE fee must never be spent with no recoverable trace');
            assert.strictEqual(eng.rounds.get(EPOCH).published, false, 'the slot is released for a retry');
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('spend safety', function () {
it('a restart does not re-publish an epoch a prior process committed', async function () {
            wireRpc({ tip: 38 });
            const first = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await first.tick();
            assert.strictEqual(first.hub.oraclePublisher.broadcastFn.callCount, 1);

            loadModule();
            wireRpc({ tip: 38 });
            const second = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            second.loadSpendLog();
            await second.tick();
            assert.strictEqual(second.hub.oraclePublisher.broadcastFn.callCount, 0);
        });
it('a definitively FAILED publish clears the commitment so a retry can run', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 },
                               { oraclePublisher: { broadcastFn: sinon.stub().rejects(Object.assign(
                                                        new Error('encoder rejected: bad payload'), { response: { status: 400 } })),
                                                    walletSignFn: sinon.stub(),
                                                    getBalanceFn: sinon.stub().resolves(1000), encoder: null } });
            await eng.tick();
            assert.strictEqual(eng.rounds.get(EPOCH).published, false);
            const phases = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8')
                             .trim().split('\n').map(l => JSON.parse(l).phase);
            assert.deepStrictEqual(phases, ['intent', 'failed']);
            assert.strictEqual(eng._committed.has(String(EPOCH)), false);
        });
it('an AMBIGUOUS send keeps the epoch claimed rather than risking a double spend', async function () {
            wireRpc({ tip: 38 });
            const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 },
                               { oraclePublisher: { broadcastFn: sinon.stub().rejects(timeout),
                                                    walletSignFn: sinon.stub(),
                                                    getBalanceFn: sinon.stub().resolves(1000), encoder: null } });
            await eng.tick();
            assert.strictEqual(eng.rounds.get(EPOCH).published, true, 'the slot stays claimed');
            assert.strictEqual(eng._committed.has(String(EPOCH)), true);
            const phases = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8')
                             .trim().split('\n').map(l => JSON.parse(l).phase);
            assert.deepStrictEqual(phases, ['intent', 'ambiguous']);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('multi-chunk publish', function () {
it('does not send a two-action roll call with only one publish left in the window', async function () {
            // The ceiling is checked once before chunking, so without a per-chunk
            // reservation both actions go out and the window overruns by one fee.
            const { eng } = await twoChunkLeader({ ROLLCALL_MAX_PUBLISHES_PER_WINDOW: 1 });
            await eng.tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0,
                'a batch the window cannot afford in full must send nothing');
            assert.strictEqual(eng.rounds.get(EPOCH).published, false, 'the slot is released for a later tick');
            assert.deepStrictEqual(spendPhases(), [],
                'a declined batch leaves no orphan intent line on disk');
            assert.strictEqual(eng.spendGuard.ceiling.countInWindow(), 0,
                'a publish that never went out consumes no budget');
            assert.ok(eng.spendGuard.blocked.spend >= 1,
                'the COUNT ceiling is what refused the second action, not some other gate');
        });
it('spends exactly one window slot per action, never one per batch', async function () {
            const { eng } = await twoChunkLeader({ ROLLCALL_MAX_PUBLISHES_PER_WINDOW: 2 });
            await eng.tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 2);
            assert.strictEqual(eng.spendGuard.ceiling.countInWindow(), 2,
                'two transactions are two spends, not one');
            assert.strictEqual(eng.spendGuard.spentInWindow(),
                2 * eng.spendGuard.estSpendUsdCents,
                'the reservation IS the spend; record() alongside it would double-count');
        });
it('a mid-batch failure gives back the budget the untried action never spent', async function () {
            const bad = Object.assign(new Error('encoder rejected: bad payload'), { response: { status: 400 } });
            const { eng } = await twoChunkLeader({ ROLLCALL_MAX_PUBLISHES_PER_WINDOW: 4 });
            eng.hub.oraclePublisher.broadcastFn = sinon.stub();
            eng.hub.oraclePublisher.broadcastFn.onCall(0).resolves({ txid: 'txid-a' });
            eng.hub.oraclePublisher.broadcastFn.onCall(1).rejects(bad);
            await eng.tick();
            assert.strictEqual(eng.spendGuard.ceiling.countInWindow(), 1,
                'the action that landed is a spend; the one that was refused is not');
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('multi-chunk publish', function () {
it('retries only the actions that never reached the wire', async function () {
            const bad = Object.assign(new Error('encoder rejected: bad payload'), { response: { status: 400 } });
            const { eng } = await twoChunkLeader();
            const bc = sinon.stub();
            bc.onCall(0).resolves({ txid: 'txid-a' });
            bc.onCall(1).rejects(bad);
            bc.resolves({ txid: 'txid-b' });
            eng.hub.oraclePublisher.broadcastFn = bc;

            await eng.tick();
            const state = eng.rounds.get(EPOCH);
            assert.strictEqual(state.published, false, 'the slot is released so the tail can still land');
            assert.strictEqual(state.sent.size, 41, 'the action that landed is remembered');
            assert.strictEqual(eng._committed.has(String(EPOCH)), false);

            wireRpc({ tip: 39 });
            await eng.tick();
            assert.strictEqual(bc.callCount, 3, 'the retry sends one action, not the whole set again');
            const first = parseWire(bc.getCall(0).args[0]).pairs.map(p => p.pubkey);
            const retry = parseWire(bc.getCall(2).args[0]).pairs.map(p => p.pubkey);
            assert.strictEqual(retry.length, 4);
            for (const pk of retry)
                assert.ok(!first.includes(pk), 'a signature already broadcast is never re-paid for');
            const everySent = first.concat(retry).sort();
            assert.strictEqual(new Set(everySent).size, 45, 'every signature reached the wire exactly once');
        });
it('counts our own signature as on the wire once ITS action landed', async function () {
            // ownSigOnWire was all-or-nothing on the batch, so a later action's
            // failure left it false and provoked a redundant self-publish of a
            // signature this hub had already broadcast and paid for.
            const bad = Object.assign(new Error('encoder rejected: bad payload'), { response: { status: 400 } });
            const { eng, myPubkey } = await twoChunkLeader();
            const bc = sinon.stub();
            bc.onCall(0).resolves({ txid: 'txid-a' });
            bc.onCall(1).rejects(bad);
            eng.hub.oraclePublisher.broadcastFn = bc;
            await eng.tick();
            const state = eng.rounds.get(EPOCH);
            assert.ok(state.sent.has(myPubkey), 'our signature rode the first action');
            assert.strictEqual(state.ownSigOnWire, true,
                'our own signature is on the wire even though a later action failed');
        });
});
});
