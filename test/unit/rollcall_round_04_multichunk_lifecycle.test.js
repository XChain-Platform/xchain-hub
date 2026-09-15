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
            await eng._tick();
            const canon = eng._canonical(EPOCH, LEDGER_HASH);
            for (let i = 0; i < ids.length; i++)
                eng._handleMessage({ type: 'XROLLCALL_SIGN',
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
describe('multi-chunk publish', function () {
it('records how many signatures had already landed when a batch failed', async function () {
            const bad = Object.assign(new Error('encoder rejected: bad payload'), { response: { status: 400 } });
            const { eng } = await twoChunkLeader();
            const bc = sinon.stub();
            bc.onCall(0).resolves({ txid: 'txid-a' });
            bc.onCall(1).rejects(bad);
            eng.hub.oraclePublisher.broadcastFn = bc;
            await eng._tick();
            const lines = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8')
                            .trim().split('\n').map(JSON.parse);
            assert.deepStrictEqual(lines.map(l => l.phase), ['intent', 'sent', 'failed']);
            assert.strictEqual(lines[2].delivered, 41,
                'an operator reconciling on chain needs to know the failure was partial');
        });
it('an operator pause landing mid-batch stops the actions that have not gone out', async function () {
            const { eng } = await twoChunkLeader({ ROLLCALL_MAX_PUBLISHES_PER_WINDOW: 4 });
            const bc = sinon.stub();
            bc.onCall(0).callsFake(async () => {
                eng.spendGuard.pause('operator incident');   // paused while action 1 is in flight
                return { txid: 'txid-a' };
            });
            bc.resolves({ txid: 'txid-b' });
            eng.hub.oraclePublisher.broadcastFn = bc;
            await eng._tick();
            assert.strictEqual(bc.callCount, 1, 'a paused hub broadcasts nothing further');
            const state = eng.rounds.get(EPOCH);
            assert.strictEqual(state.sent.size, 41, 'the action that already landed still counts as sent');
            assert.strictEqual(state.published, false, 'the slot is released so the tail can land after a resume');
            assert.strictEqual(eng.spendGuard.ceiling.countInWindow(), 1,
                'the action the pause stopped gives its budget back');
            const lines = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8')
                            .trim().split('\n').map(JSON.parse);
            assert.deepStrictEqual(lines.map(l => l.phase), ['intent', 'sent', 'failed'],
                'phase failed, not an unknown phase: only failed un-commits the epoch on restart');
            assert.strictEqual(lines[2].remaining, 1);
            assert.match(lines[2].error, /PAUSED/,
                'the PAUSE is what stopped it, not the count ceiling or the wallet floor');
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('getStatus', function () {
it('reports publisher state and NO ledger facts', async function () {
            wireRpc({ tip: 38 });
            const order = orderFor(PKS, EPOCH);
            const eng = makeEngine({ identity: IDS[PKS.indexOf(order[0])] },
                                   { ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await eng._tick();
            const s = eng.getStatus();
            assert.deepStrictEqual(Object.keys(s).sort(),
                ['broadcast_capable', 'epoch', 'gossiped_count', 'leader', 'on_chain_count',
                 'our_rank', 'signed', 'txids'].sort());
            assert.strictEqual(s.epoch, EPOCH);
            assert.strictEqual(s.signed, true);
            assert.strictEqual(s.leader, order[0]);
            assert.strictEqual(s.our_rank, 0);
            assert.strictEqual(s.broadcast_capable, true);
            assert.deepStrictEqual(s.txids, ['txid-1']);
            for (const forbidden of ['last_rolled_epoch', 'absent_streak', 'evicted', 'absences'])
                assert.strictEqual(forbidden in s, false,
                    forbidden + ' is a BTC-indexer ledger fact and is authoritative there, not here');
        });
it('is fully shaped before any epoch has been seen', function () {
            const eng = makeEngine({});
            const s = eng.getStatus();
            assert.strictEqual(s.epoch, null);
            assert.strictEqual(s.signed, false);
            assert.strictEqual(s.gossiped_count, 0);
            assert.strictEqual(s.on_chain_count, null);
            assert.strictEqual(s.our_rank, -1);
            assert.deepStrictEqual(s.txids, []);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('lifecycle', function () {
it('start() subscribes to peer messages and stop() unsubscribes', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({}, { ROLLCALL_POLL_MS: 3600000 });
            await eng.start();
            assert.strictEqual(eng.hub._pm.listenerCount('message'), 1);
            assert.strictEqual(eng.rounds.has(EPOCH), true);
            await eng.stop();
            assert.strictEqual(eng.hub._pm.listenerCount('message'), 0);
        });
it('ROLLCALL_ENABLED=false keeps the engine entirely idle', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({}, { ROLLCALL_ENABLED: 'false' });
            await eng.start();
            assert.strictEqual(eng.rounds.size, 0);
            assert.strictEqual(eng.hub._pm.listenerCount('message'), 0);
            await eng.stop();
        });
it('prunes rounds once the window and its retention have passed', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            await eng._tick();
            assert.strictEqual(eng.rounds.has(EPOCH), true);
            wireRpc({ tip: 200 });
            await eng._tick();
            assert.strictEqual(eng.rounds.has(EPOCH), false);
        });
it('a BTC indexer failure is survived, not fatal', async function () {
            wireRpc({ tip: 36, btcFail: true });
            const eng = makeEngine({});
            await assert.rejects(() => eng._indexerCall('getblockhashes', {}));
            assert.strictEqual(eng._ticking, false, 'the in-flight guard must not wedge on a rejection');
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('tunables', function () {
it('takes the per-network defaults with no env set', function () {
            const eng = makeEngine({});
            assert.strictEqual(eng.publishDelayBlocks, RollcallRound.PUBLISH_DELAY_DEFAULTS.regtest);
            assert.strictEqual(eng.electionToleranceBlocks, RollcallRound.ELECTION_TOLERANCE_DEFAULTS.regtest);
            assert.strictEqual(eng.selfPublishBlocks, RollcallRound.SELF_PUBLISH_DEFAULTS.regtest);
        });
it('the roll-call ladder step is independent of the anchor ladder step', function () {
            process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS = '999';
            const eng = makeEngine({});
            assert.strictEqual(eng.electionToleranceBlocks, RollcallRound.ELECTION_TOLERANCE_DEFAULTS.regtest,
                'a roll-call cadence change must not be able to re-inert the anchor ladder, or the reverse');
            delete process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS;
        });
it('falls back to the default on a garbage tunable rather than disabling the gate', function () {
            // A NaN delay would compare false forever and publish nothing, which is
            // exactly the silent inertness this engine must not have.
            const eng = makeEngine({}, { ROLLCALL_PUBLISH_DELAY_BLOCKS: 'soon' });
            assert.strictEqual(eng.publishDelayBlocks, RollcallRound.PUBLISH_DELAY_DEFAULTS.regtest);
        });
it('reads the consensus constants from the twin, never from env', function () {
            const rca = require('../../src/rollcall_activation.js');
            process.env.ROLLCALL_INTERVAL_BLOCKS = '7';
            process.env.ROLLCALL_ACCEPT_WINDOW_BLOCKS = '7';
            const eng = makeEngine({});
            assert.strictEqual(eng.interval, rca.ROLLCALL_INTERVAL_BLOCKS.regtest);
            assert.strictEqual(eng.acceptWindow, rca.ROLLCALL_ACCEPT_WINDOW_BLOCKS.regtest);
            delete process.env.ROLLCALL_INTERVAL_BLOCKS;
            delete process.env.ROLLCALL_ACCEPT_WINDOW_BLOCKS;
        });
});
});
