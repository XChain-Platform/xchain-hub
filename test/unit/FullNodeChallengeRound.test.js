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

const V1 = 'a'.repeat(64);   // genesis verifier / full node
const V2 = 'b'.repeat(64);   // second verifier
const P1 = 'c'.repeat(64);   // claimant full node
const P2 = 'd'.repeat(64);   // second claimant
const X  = 'e'.repeat(64);   // outsider

const SEED = 'ab'.repeat(32); // 64-hex ledger hash

// Stub ValidatorIdentity (static verify) + axios; keep the REAL
// equivocation_header so the canonical bytes are exercised for real.
let axiosStub, ValidatorIdentityStub, FullNodeChallengeRound;
function loadModule() {
    axiosStub = { post: sinon.stub() };
    ValidatorIdentityStub = function () {};
    ValidatorIdentityStub.verify = sinon.stub().returns(true);
    FullNodeChallengeRound = proxyquire('../../src/FullNodeChallengeRound', {
        axios: axiosStub,
        './ValidatorIdentity.js': ValidatorIdentityStub,
    });
}

function makeIdentity(pubkey) {
    return { getPubkeyHex: () => pubkey, sign: (s) => 'sig:' + pubkey };
}

function fullnodeCfg(overrides) {
    return Object.assign({
        CHALLENGE_INTERVAL_BLOCKS: 144,
        CONFIRM_DEPTH: 100,
        PROOF_WINDOW_BLOCKS: 300,
        VERDICT_ACCEPT_WINDOW_BLOCKS: 24,
        POLL_MS: 30000,
        COLLECT_MS: 20000,
        REWARD_SHARE: '0.25',
        GENESIS_VERIFIERS: [V1],
        BTC_RPC: 'http://coin',
    }, overrides || {});
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

// axios dispatcher keyed on JSON-RPC method (indexer + coin RPCs share axios).
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

describe('FullNodeChallengeRound', function () {

    beforeEach(loadModule);
    afterEach(() => sinon.restore());

    // ── construction / config ─────────────────────────────────────────────────
    describe('constructor', function () {
        it('reads FULLNODE config + genesis verifiers', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng.interval).to.equal(144);
            expect(eng.confirmDepth).to.equal(100);
            expect(eng.acceptWindow).to.equal(24);
            expect(eng.genesis.has(V1)).to.equal(true);
            expect(eng.coinRpcUrl).to.equal('http://coin');
        });
        it('falls back to defaults when FULLNODE absent', function () {
            const hub = makeHub();
            hub.p2pConfig.FULLNODE = {};
            const eng = new FullNodeChallengeRound(hub);
            expect(eng.interval).to.equal(144);
            expect(eng.genesis.size).to.equal(0);
        });
        it('drops malformed genesis pubkeys', function () {
            const eng = new FullNodeChallengeRound(makeHub({ fullnode: { GENESIS_VERIFIERS: [V1, 'nope', 'AB'] } }));
            expect([...eng.genesis]).to.deep.equal([V1]);
        });
    });

    // ── canonical bytes (CONSENSUS-CRITICAL: must match indexer nodeproof.js) ──
    describe('canonical / wire', function () {
        it('_verdictCanonical = challenge|epoch|sorted-pass, EQUIV-wrapped on regtest', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const cid = 'f'.repeat(64);
            const out = eng._verdictCanonical(cid, 288, [P1, P2]);
            // regtest activates EQUIV at genesis → header-wrapped
            expect(out.startsWith('EQUIV|XNODEPROOF|' + cid + '|0||')).to.equal(true);
            expect(out.endsWith(cid + '|288|' + [P1, P2].join(','))).to.equal(true);
        });
        it('_answerCanonical binds challenge + answer', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng._answerCanonical('cid', 'deadbeef')).to.equal('XNODEANS|cid|deadbeef');
        });
        it('_buildVerdictWire emits NODEPROOF|0|cid|epoch|n|pass…|m|pk|sig…', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const state = {
                challengeId: 'cid', epoch: 288,
                passList: [P2, P1],                       // unsorted on input
                sigs: new Map([[V1, 'sigV1'], [V2, 'sigV2']]),
            };
            const wire = eng._buildVerdictWire(state).split('|');
            expect(wire.slice(0, 5)).to.deep.equal(['NODEPROOF', '0', 'cid', '288', '2']);
            expect(wire.slice(5, 7)).to.deep.equal([P1, P2]);          // pass sorted
            expect(wire[7]).to.equal('2');                              // sig count
            expect(wire.slice(8)).to.deep.equal([V1, 'sigV1', V2, 'sigV2']);
        });
    });

    // ── leader election + failover ladder ──────────────────────────────────────
    describe('_isLeader', function () {
        function state(eligible, startedAt) {
            return { challengeId: 'cid', eligible: new Set(eligible), startedAt };
        }
        it('a non-eligible node is never leader', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng._isLeader(state([V1, V2], 0), X)).to.equal(false);
        });
        it('rank-0 (lowest hash) leads immediately; others wait', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            eng.collectMs = 1000;
            // rank by sha256(cid||pk)
            const ranked = [V1, V2].map(pk => ({ pk, h: crypto.createHash('sha256').update('cid').update(pk).digest('hex') }))
                .sort((a, b) => a.h < b.h ? -1 : 1).map(r => r.pk);
            const now = Date.now();
            const st = state([V1, V2], now);
            sinon.stub(Date, 'now').returns(now);                 // 0 windows elapsed
            expect(eng._isLeader(st, ranked[0])).to.equal(true);
            expect(eng._isLeader(st, ranked[1])).to.equal(false);
        });
        it('promotes the next rank as a chain-based failover (state.leadRank)', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const ranked = [V1, V2].map(pk => ({ pk, h: crypto.createHash('sha256').update('cid').update(pk).digest('hex') }))
                .sort((a, b) => a.h < b.h ? -1 : 1).map(r => r.pk);
            const st = state([V1, V2], 0);
            st.leadRank = 1;                                      // _tick promoted rank 1 (no verdict landed)
            expect(eng._isLeader(st, ranked[1])).to.equal(true);
            expect(eng._isLeader(st, ranked[0])).to.equal(false); // rank-0 stood down
        });
    });

    // ── deterministic possession answer ───────────────────────────────────────
    describe('_computeAnswer', function () {
        const block = { tx: [
            { vout: [{ scriptPubKey: { hex: 's00' } }, { scriptPubKey: { hex: 's01' } }] },
            { vout: [{ scriptPubKey: { hex: 's10' } }] },
            { vout: [{ scriptPubKey: { hex: 's20' } }, { scriptPubKey: { hex: 's21' } }, { scriptPubKey: { hex: 's22' } }] },
        ] };
        it('selects the seed-derived output scriptPubKey hex', async function () {
            wireRpc({ block });
            const eng = new FullNodeChallengeRound(makeHub());
            const txIdx  = Number(BigInt('0x' + SEED.slice(0, 16)) % BigInt(block.tx.length));
            const vIdx   = Number(BigInt('0x' + SEED.slice(16, 32)) % BigInt(block.tx[txIdx].vout.length));
            const expected = block.tx[txIdx].vout[vIdx].scriptPubKey.hex;
            expect(await eng._computeAnswer(188, SEED)).to.equal(expected);
        });
        it('throws without a coin RPC', async function () {
            const hub = makeHub();
            hub.p2pConfig.cross_chain = {}; hub.p2pConfig.FULLNODE.BTC_RPC = '';
            const eng = new FullNodeChallengeRound(hub);
            let threw = false;
            try { await eng._computeAnswer(188, SEED); } catch (e) { threw = true; }
            expect(threw).to.equal(true);
        });
        it('throws on an empty target block', async function () {
            wireRpc({ block: { tx: [] } });
            const eng = new FullNodeChallengeRound(makeHub());
            let threw = false;
            try { await eng._computeAnswer(188, SEED); } catch (e) { threw = true; }
            expect(threw).to.equal(true);
        });
    });

    // ── eligible verifiers + claimant set ──────────────────────────────────────
    describe('eligibility', function () {
        it('_eligibleVerifiers = genesis ∪ indexer-verified', async function () {
            wireRpc({ verifiers: [{ pubkey: V2 }] });
            const eng = new FullNodeChallengeRound(makeHub());      // genesis = [V1]
            const set = await eng._eligibleVerifiers(288);
            expect([...set].sort()).to.deep.equal([V1, V2].sort());
        });
        it('falls back to genesis-only when the verifiers RPC is unavailable', async function () {
            axiosStub.post.rejects(new Error('no rpc'));
            const eng = new FullNodeChallengeRound(makeHub());
            const set = await eng._eligibleVerifiers(288);
            expect([...set]).to.deep.equal([V1]);
        });
        it('falls back to genesis-only on an in-band indexer result.error (200 with error body)', async function () {
            // The indexer reports failures as result.error, not the top-level JSON-RPC
            // error envelope; _indexerCall must surface it so a degraded indexer does
            // not silently widen the verifier set with an error object.
            axiosStub.post.callsFake(async () => ({ data: { result: { error: 'indexer unavailable' } } }));
            const eng = new FullNodeChallengeRound(makeHub());
            const set = await eng._eligibleVerifiers(288);
            expect([...set]).to.deep.equal([V1]);
        });
        it('_claimantSet reads the full_node capability snapshot', async function () {
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: P1 }, { pubkey: P2 }] });
            const eng = new FullNodeChallengeRound(hub);
            const set = await eng._claimantSet(288);
            expect([...set].sort()).to.deep.equal([P1, P2].sort());
            expect(hub.capabilitySnapshot.getSnapshot.calledWith('full_node', 288)).to.equal(true);
        });
    });

    // ── round flow: answer → sign-req → sign → finalize ────────────────────────
    describe('round flow', function () {
        // single-tx block → deterministic answer; _computeAnswer lowercases the hex.
        const ANSWER = 'deadbeef';
        const block = { tx: [{ vout: [{ scriptPubKey: { hex: ANSWER } }] }] };
        let clock;
        beforeEach(() => { clock = sinon.useFakeTimers({ now: 1000, toFake: ['setTimeout', 'setInterval'] }); });
        afterEach(() => clock.restore());

        async function startEpoch(hub) {
            // single-tx block so the answer is deterministic; identity is genesis
            // verifier V1 AND a claimant, so it both answers and can sign.
            wireRpc({ ledgerHash: SEED, tip: 300, verifiers: [], block });
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: V1 }, { pubkey: P1 }] });
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX123' });
            await eng._runEpoch(288, 300);
            return eng;
        }

        it('computes the challenge and broadcasts its own answer', async function () {
            const hub = makeHub();                     // identity V1
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            expect(st.challengeId).to.equal(deriveChallengeId('regtest', 288, SEED, 188));
            expect(st.myAnswer).to.equal(ANSWER);
            const ans = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_ANSWER');
            expect(ans, 'XNODE_ANSWER broadcast').to.exist;
            expect(ans.args[1].answer).to.equal(ANSWER);
        });

        it('leader proposes the PASS list of claimants whose answer matches', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            // P1 (a claimant) submitted the CORRECT answer.
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer: ANSWER, sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);
            // V1 is the only eligible verifier → it is leader → broadcasts a sign request
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'XNODE_SIGN_REQ broadcast').to.exist;
            expect(req.args[1].passList).to.include(P1);
        });

        it('finalizes on quorum and broadcasts the on-chain verdict', async function () {
            const hub = makeHub();                       // V1 = sole genesis verifier → quorum 1
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer: ANSWER, sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);             // leader self-signs (V1) → quorum 1 met
            expect(eng.broadcastFn.calledOnce, 'verdict broadcast on-chain').to.equal(true);
            const wire = eng.broadcastFn.firstCall.args[0];
            expect(wire.startsWith('NODEPROOF|0|' + st.challengeId + '|288|')).to.equal(true);
            expect(wire).to.include(P1);
            expect(st.finalized).to.equal(true);
            const done = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_DONE');
            expect(done, 'XNODE_DONE broadcast').to.exist;
        });

        it('does not double-broadcast when two triggers cross quorum concurrently (NODE-DOUBLECAST-1)', async function () {
            const hub = makeHub();                       // V1 = sole genesis verifier → quorum 1
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer: ANSWER, sig_pubkey: P1, sig: 's' });
            // Hold the verdict broadcast open so a second finalize can race the first's await.
            let release = null, calls = 0;
            eng.broadcastFn = () => { calls++; return new Promise(res => { release = () => res({ txid: 'TX' + calls }); }); };
            const p1 = eng._closeCollection(288);        // leader self-signs → quorum 1 → _maybeFinalize (broadcast held open)
            const p2 = eng._maybeFinalize(288);          // a second trigger during the broadcast await must NOT re-broadcast
            release();
            await Promise.all([p1, p2]);
            expect(calls, 'verdict broadcast exactly once').to.equal(1);
            expect(st.finalized).to.equal(true);
        });

        it('a non-leader does not broadcast a verdict', async function () {
            // identity V2 is eligible (we add it to genesis) but rank may not be 0;
            // force two verifiers so quorum is 2 and a single self-sign cannot finalize.
            const hub = makeHub({ identity: makeIdentity(V2), fullnode: { GENESIS_VERIFIERS: [V1, V2] } });
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer: ANSWER, sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);
            // quorum is 2 (V=2) but only one self-sign so far → no finalize
            expect(eng.broadcastFn.called).to.equal(false);
        });

        it('a verifier that is not a claimant computes its answer silently (so it can lead)', async function () {
            // V2 is a genesis verifier but NOT in the claimant snapshot ([V1, P1]).
            const hub = makeHub({ identity: makeIdentity(V2), fullnode: { GENESIS_VERIFIERS: [V1, V2] } });
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            expect(st.myAnswer).to.equal(ANSWER);                 // computed for leading/verifying
            const ans = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_ANSWER' && c.args[1].sig_pubkey === V2);
            expect(ans, 'a verifier-only node must NOT broadcast a possession claim').to.not.exist;
        });
    });

    // ── chain-anchored collection close (the keystone: all hubs close a round at
    //    the same chain height, so the leader has every answer regardless of when
    //    each hub locally detected the epoch) ──────────────────────────────────────
    describe('_tick chain-anchored close', function () {
        const block = { tx: [{ vout: [{ scriptPubKey: { hex: 'deadbeef' } }] }] };
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
    });
});
