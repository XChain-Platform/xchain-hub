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

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('epoch selection', function () {
it('picks the newest epoch that is buried and still inside the accept window', function () {
            const eng = makeEngine({});
            assert.strictEqual(eng.newestSignableEpoch(36), EPOCH, 'buried by exactly the reorg buffer');
            assert.strictEqual(eng.newestSignableEpoch(42), EPOCH, 'the last block of the window');
        });
it('refuses an epoch that is not yet buried by CANONICAL_REORG_BUFFER', function () {
            const eng = makeEngine({});
            // A signature over a ledger_hash that can still be reorged out is a
            // signature no peer will ever be able to verify.
            assert.strictEqual(eng.newestSignableEpoch(35), null, 'since=5 is inside the reorg buffer');
            assert.strictEqual(eng.newestSignableEpoch(30), null, 'the epoch block itself');
        });
it('refuses an epoch whose accept window has closed', function () {
            const eng = makeEngine({});
            assert.strictEqual(eng.newestSignableEpoch(43), null, 'since=13 is past the 12-block window');
        });
it('treats epoch 0 as a real epoch where a network is armed from genesis', function () {
            const eng = makeEngine({});
            assert.strictEqual(eng.newestSignableEpoch(6), 0, 'a falsy height check would skip epoch 0');
        });
it('is inert on a network whose ROLLCALL_ACTIVATION is null', function () {
            const NET = 'unarmednet';
            rca.ROLLCALL_ACTIVATION[NET] = null;
            try {
                const eng = makeEngine({});
                eng.network = NET;
                eng.interval = 1008;
                eng.acceptWindow = 144;
                // `0 >= null` is true in JS; only the Number.isFinite guard keeps this
                // from arming an unarmed network at height 0.
                assert.strictEqual(eng.newestSignableEpoch(1008 + 10), null);
            } finally { delete rca.ROLLCALL_ACTIVATION[NET]; }
        });
it('signs epochs on a genesis-armed mainnet', function () {
            const eng = makeEngine({});
            eng.network = 'mainnet';
            eng.interval = 1008;
            eng.acceptWindow = 144;
            // Ruled 2026-09-09: mainnet carries 0 validators and 0 roll-calls, so epochs
            // exist from genesis and the newest signable one is the last interval boundary.
            assert.strictEqual(eng.newestSignableEpoch(1008 + 10), 1008);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('sign and gossip', function () {
it('signs the ledger-hash-bound canonical and broadcasts XROLLCALL_SIGN', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            await eng._tick();

            const calls = eng.hub._pm.broadcast.getCalls().filter(c => c.args[0] === 'XROLLCALL_SIGN');
            assert.strictEqual(calls.length, 1);
            const d = calls[0].args[1];
            assert.strictEqual(d.epoch, EPOCH);
            assert.strictEqual(d.pubkey, PKS[0]);
            // The broadcast signature must verify over the canonical the landed
            // indexer handler rebuilds, or the whole rail is dead.
            const canon = eng._canonical(EPOCH, LEDGER_HASH);
            assert.strictEqual(ValidatorIdentity.verify(canon, d.sig, PKS[0]), true);
        });
it('signs even with no DOGE wallet and no broadcast rail', async function () {
            // The sweepers exist precisely so a wallet-less validator still gets
            // rolled; gating signing on a publish rail would evict exactly those.
            wireRpc({ tip: 36 });
            const eng = makeEngine({ oraclePublisher: null });
            await eng._tick();
            assert.strictEqual(eng.broadcastCapable(), false);
            assert.strictEqual(eng.hub._pm.broadcast.getCalls()
                .filter(c => c.args[0] === 'XROLLCALL_SIGN').length, 1);
        });
it('ABSTAINS for the epoch when the federation snapshot is unresolved', async function () {
            wireRpc({ tip: 36 });
            const eng = makeEngine({ members: null });
            await eng._tick();
            assert.strictEqual(eng.rounds.size, 0, 'no round state is created');
            assert.strictEqual(eng.hub._pm.broadcast.callCount, 0, 'nothing is gossiped');
        });
it('does not sign when the BTC indexer has no ledger_hash for the epoch', async function () {
            wireRpc({ tip: 36, ledgerHash: null });
            const eng = makeEngine({});
            await eng._tick();
            assert.strictEqual(eng.rounds.size, 0);
            assert.strictEqual(eng.hub._pm.broadcast.callCount, 0);
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('sign and gossip', function () {
it('writes the signature durably and re-emits it after a restart without re-signing', async function () {
            wireRpc({ tip: 36 });
            const first = makeEngine({});
            await first._tick();
            const emitted = first.hub._pm.broadcast.getCalls()
                .filter(c => c.args[0] === 'XROLLCALL_SIGN')[0].args[1].sig;

            const onDisk = fs.readFileSync(process.env.ROLLCALL_SIGN_LOG_PATH, 'utf8').trim();
            assert.ok(onDisk.length > 0, 'the signature must survive the process');
            assert.strictEqual(JSON.parse(onDisk).sig, emitted);

            // Second boot: same identity, but the identity must not be asked to
            // sign again. Ed25519 is deterministic, so comparing bytes alone could
            // not tell a re-emit from a fresh signature; the spy can.
            const id2 = new ValidatorIdentity(SEEDS[0]);
            const signSpy = sinon.spy(id2, 'sign');
            const second = makeEngine({ identity: id2 });
            second.loadSignLog();
            await second._tick();
            assert.strictEqual(signSpy.callCount, 0, 'a restart must re-emit, not re-sign');
            const reEmitted = second.hub._pm.broadcast.getCalls()
                .filter(c => c.args[0] === 'XROLLCALL_SIGN')[0].args[1].sig;
            assert.strictEqual(reEmitted, emitted);
        });
it('re-signs after a restart when the epoch ledger_hash changed under it', async function () {
            wireRpc({ tip: 36 });
            const first = makeEngine({});
            await first._tick();

            loadModule();
            wireRpc({ tip: 36, ledgerHash: 'b'.repeat(64) });
            const id2 = new ValidatorIdentity(SEEDS[0]);
            const signSpy = sinon.spy(id2, 'sign');
            const second = makeEngine({ identity: id2 });
            second.loadSignLog();
            await second._tick();
            assert.strictEqual(signSpy.callCount, 1,
                'a stored signature over a superseded ledger_hash must not be re-emitted');
        });
});
});

describe('RollcallRound', function () {
    installSuiteHooks1();
describe('sign and gossip', function () {
it('ignores a stored signature another identity wrote and signs fresh under its own key', async function () {
            wireRpc({ tip: 36 });
            const first = makeEngine({});
            await first._tick();
            const foreign = first.hub._pm.broadcast.getCalls()
                .filter(c => c.args[0] === 'XROLLCALL_SIGN')[0].args[1];

            // Same log file, DIFFERENT identity: the line on disk is somebody
            // else's. Re-emitting it would broadcast a signature no peer can
            // verify under this pubkey, and this hub would then read as absent.
            const id2 = new ValidatorIdentity(SEEDS[1]);
            const signSpy = sinon.spy(id2, 'sign');
            const second = makeEngine({ identity: id2 });
            second.loadSignLog();
            await second._tick();
            assert.strictEqual(signSpy.callCount, 1, 'a foreign line must not stand in for this hub\'s own signature');
            const own = second.hub._pm.broadcast.getCalls()
                .filter(c => c.args[0] === 'XROLLCALL_SIGN')[0].args[1];
            assert.strictEqual(own.pubkey, id2.getPubkeyHex().toLowerCase());
            assert.notStrictEqual(own.sig, foreign.sig, 'the broadcast signature must be this identity\'s, not the stored one');
            const state = Array.from(second.rounds.values())[0];
            assert.ok(ValidatorIdentity.verify(state.canonical, own.sig, own.pubkey),
                'what this hub broadcasts must verify under its own pubkey');
        });
it('keeps only its own spend records, treating a record that names no pubkey as its own', function () {
            const eng   = makeEngine({});
            const mine  = eng.ownPubkey();
            const other = new ValidatorIdentity(SEEDS[1]).getPubkeyHex().toLowerCase();
            assert.ok(mine && mine !== other);
            fs.writeFileSync(process.env.ROLLCALL_SPEND_LOG_PATH,
                JSON.stringify({ phase: 'sent', epoch: 30, kind: 'sweep', pubkey: other }) + '\n' +
                JSON.stringify({ phase: 'sent', epoch: 60, kind: 'sweep' }) + '\n' +
                JSON.stringify({ phase: 'sent', epoch: 90, kind: 'self',  pubkey: mine }) + '\n');
            eng.loadSpendLog();
            assert.ok(!eng._committed.has('30'), 'another identity\'s spend is not this hub\'s commitment');
            assert.ok(eng._committed.has('60'), 'a record predating the pubkey field is this hub\'s own');
            assert.ok(eng._committed.has('90:self'));

            // And what this hub writes from now on names it.
            eng.recordSpend({ phase: 'intent', epoch: 120, kind: 'sweep' });
            const last = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8').trim().split('\n').pop();
            assert.strictEqual(JSON.parse(last).pubkey, mine);
        });
});
});
