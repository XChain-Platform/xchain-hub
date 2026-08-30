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

const ValidatorIdentity    = require('../../src/ValidatorIdentity.js');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher.js');

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
                  'BTC_INDEXER_URL', 'DOGE_INDEXER_URL', 'DOGE_INDEXER_API_URL',
                  'DOGE_LOW_BALANCE_THRESHOLD', 'DOGE_ADDRESS', 'DOGE_ENCODER_URL',
                  'HUB_SIGNER_MODULE'];

let axiosStub, RollcallRound, tmpDir, savedEnv;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    RollcallRound = proxyquire('../../src/RollcallRound.js', { axios: axiosStub });
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
        _btcIndexerHeaders: () => ({ 'Content-Type': 'application/json' }),
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

describe('RollcallRound', function () {

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

    // ── epoch selection ──────────────────────────────────────────────────────

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

        it('treats epoch 0 as a real epoch on regtest', function () {
            const eng = makeEngine({});
            assert.strictEqual(eng.newestSignableEpoch(6), 0, 'a falsy height check would skip epoch 0');
        });

        it('is inert where ROLLCALL_ACTIVATION is null (mainnet)', function () {
            const eng = makeEngine({});
            eng.network = 'mainnet';
            eng.interval = 1008;
            eng.acceptWindow = 144;
            // `0 >= null` is true in JS; only the Number.isFinite guard keeps this
            // from arming mainnet at height 0.
            assert.strictEqual(eng.newestSignableEpoch(1008 + 10), null);
        });
    });

    // ── sign + gossip ────────────────────────────────────────────────────────

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
            second._loadSignLog();
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
            second._loadSignLog();
            await second._tick();
            assert.strictEqual(signSpy.callCount, 1,
                'a stored signature over a superseded ledger_hash must not be re-emitted');
        });
    });

    // ── collect ──────────────────────────────────────────────────────────────

    describe('collect', function () {

        async function collecting() {
            wireRpc({ tip: 36 });
            const eng = makeEngine({});
            await eng._tick();
            return eng;
        }

        function signOf(eng, idx) {
            return IDS[idx].sign(eng._canonical(EPOCH, LEDGER_HASH));
        }

        it('keeps a peer signature that verifies and is in the snapshot', async function () {
            const eng = await collecting();
            eng._handleMessage({ type: 'XROLLCALL_SIGN',
                                 data: { epoch: EPOCH, pubkey: PKS[1], sig: signOf(eng, 1) } });
            assert.strictEqual(eng.rounds.get(EPOCH).sigs.has(PKS[1]), true);
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

    // ── elect ────────────────────────────────────────────────────────────────

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

    // ── publish ──────────────────────────────────────────────────────────────

    describe('publish', function () {

        // Build an engine whose identity sits at `rank` in the real election order.
        //
        // The self-publish deadline is pushed out of reach unless a test sets it:
        // at the REGTEST defaults it is 6, equal to CANONICAL_REORG_BUFFER, so it is
        // already past on the first tick a round can exist at and would fire in
        // every one of these cases (see the pinned finding in
        // RollcallRound.invariants.test.js). The escape hatch has its own describe
        // block below; here it must not stand in for the publish path.
        function atRank(rank, env, hubOpts) {
            const order = orderFor(PKS, EPOCH);
            const idx   = PKS.indexOf(order[rank]);
            return makeEngine(Object.assign({ identity: IDS[idx] }, hubOpts || {}),
                              Object.assign({ ROLLCALL_SELF_PUBLISH_BLOCKS: 99 }, env || {}));
        }

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

    // ── self-publish ─────────────────────────────────────────────────────────

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

    // ── the broadcast gate ───────────────────────────────────────────────────

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

    // ── spend guard + durable intent ─────────────────────────────────────────

    describe('spend safety', function () {

        // Self-publish pushed out of reach for the same reason as in `publish`
        // above: this block is about the fee-bearing sweep path.
        function leader(env, hubOpts) {
            const order = orderFor(PKS, EPOCH);
            return makeEngine(Object.assign({ identity: IDS[PKS.indexOf(order[0])] }, hubOpts || {}),
                              Object.assign({ ROLLCALL_SELF_PUBLISH_BLOCKS: 99 }, env || {}));
        }

        it('refuses to publish with the wallet under DOGE_LOW_BALANCE_THRESHOLD', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, DOGE_LOW_BALANCE_THRESHOLD: '10' },
                               { oraclePublisher: { broadcastFn: sinon.stub().resolves({ txid: 't' }),
                                                    walletSignFn: sinon.stub(),
                                                    getBalanceFn: sinon.stub().resolves(1), encoder: null } });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });

        it('fails closed when the wallet balance is unreadable', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1, DOGE_LOW_BALANCE_THRESHOLD: '10' },
                               { oraclePublisher: { broadcastFn: sinon.stub().resolves({ txid: 't' }),
                                                    walletSignFn: sinon.stub(),
                                                    getBalanceFn: sinon.stub().rejects(new Error('rpc down')),
                                                    encoder: null } });
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });

        it('refuses to publish while the effector is paused', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            eng.spendGuard.pause('drill');
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0);
        });

        it('writes a durable intent BEFORE the money moves and gates the send on it', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await eng._tick();
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
            sinon.stub(eng, '_recordSpend').returns(false);
            await eng._tick();
            assert.strictEqual(eng.hub.oraclePublisher.broadcastFn.callCount, 0,
                'a real DOGE fee must never be spent with no recoverable trace');
            assert.strictEqual(eng.rounds.get(EPOCH).published, false, 'the slot is released for a retry');
        });

        it('a restart does not re-publish an epoch a prior process committed', async function () {
            wireRpc({ tip: 38 });
            const first = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            await first._tick();
            assert.strictEqual(first.hub.oraclePublisher.broadcastFn.callCount, 1);

            loadModule();
            wireRpc({ tip: 38 });
            const second = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 });
            second._loadSpendLog();
            await second._tick();
            assert.strictEqual(second.hub.oraclePublisher.broadcastFn.callCount, 0);
        });

        it('a definitively FAILED publish clears the commitment so a retry can run', async function () {
            wireRpc({ tip: 38 });
            const eng = leader({ ROLLCALL_PUBLISH_DELAY_BLOCKS: 1 },
                               { oraclePublisher: { broadcastFn: sinon.stub().rejects(Object.assign(
                                                        new Error('encoder rejected: bad payload'), { response: { status: 400 } })),
                                                    walletSignFn: sinon.stub(),
                                                    getBalanceFn: sinon.stub().resolves(1000), encoder: null } });
            await eng._tick();
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
            await eng._tick();
            assert.strictEqual(eng.rounds.get(EPOCH).published, true, 'the slot stays claimed');
            assert.strictEqual(eng._committed.has(String(EPOCH)), true);
            const phases = fs.readFileSync(process.env.ROLLCALL_SPEND_LOG_PATH, 'utf8')
                             .trim().split('\n').map(l => JSON.parse(l).phase);
            assert.deepStrictEqual(phases, ['intent', 'ambiguous']);
        });
    });

    // ── status ───────────────────────────────────────────────────────────────

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

    // ── lifecycle ────────────────────────────────────────────────────────────

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

    // ── tunables ─────────────────────────────────────────────────────────────

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
