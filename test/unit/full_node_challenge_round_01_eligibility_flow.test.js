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

// single-tx block → deterministic answer; computeAnswer lowercases the hex.
const ANSWER = 'deadbeef';

const block = { tx: [{ vout: [{ scriptPubKey: { hex: ANSWER } }] }] };

let clock;

async function startEpoch(hub) {
            // single-tx block so the answer is deterministic; identity is genesis
            // verifier V1 AND a claimant, so it both answers and can sign.
            wireRpc({ ledgerHash: SEED, tip: 300, verifiers: [], block });
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: V1 }, { pubkey: P1 }] });
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX123' });
            await eng.runEpoch(288, 300);
            return eng;
        }

function installSuiteHooks3() {
    beforeEach(() => { clock = sinon.useFakeTimers({ now: 1000, toFake: ['setTimeout', 'setInterval'] }); });
    afterEach(() => clock.restore());
}

// ── eligible verifiers + claimant set ──────────────────────────────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('eligibility', function () {
it('does not alarm when the indexer does not mark the set truncated', async function () {
            wireRpc({ verifiers: [{ pubkey: V2 }] });
            const logged = sinon.stub(console, 'error');
            const eng = new FullNodeChallengeRound(makeHub());
            await eng._eligibleVerifiers(288);
            expect(logged.calledWithMatch('TRUNCATED')).to.equal(false);
        });
it('runEpoch abstains (creates no round, emits no verdict) when the verifier set is unresolved', async function () {
            // RPC-failure abstain regression: getblockhashes succeeds (so runEpoch is
            // reached) but getfullnodeverifiers fails. The hub must skip the epoch:
            // no round state, no leadership, no sign request, no verdict broadcast.
            const block = { tx: [{ vout: [{ scriptPubKey: { hex: 'deadbeef' } }] }] };
            axiosStub.post.callsFake(async (url, body) => {
                const m = body.method;
                if (m === 'getblockhashes')       return { data: { result: { block_index: 288, ledger_hash: SEED } } };
                if (m === 'getfullnodeverifiers') throw new Error('indexer timeout');
                if (m === 'getblockhash')         return { data: { result: 'HASH' } };
                if (m === 'getblock')             return { data: { result: block } };
                return { data: { result: null } };
            });
            const hub = makeHub();
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });
            await eng.runEpoch(288, 300);
            expect(eng.rounds.has(288), 'no round state created on abstain').to.equal(false);
            expect(eng.broadcastFn.called, 'no verdict broadcast on abstain').to.equal(false);
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'no sign request on abstain').to.not.exist;
        });
it('claimantSet reads the full_node capability snapshot', async function () {
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: P1 }, { pubkey: P2 }] });
            const eng = new FullNodeChallengeRound(hub);
            const set = await eng.claimantSet(288);
            expect([...set].sort()).to.deep.equal([P1, P2].sort());
            expect(hub.capabilitySnapshot.getSnapshot.calledWith('full_node', 288)).to.equal(true);
        });
it('claimantSet returns null (fail closed) when the snapshot is unresolved (null)', async function () {
            // #2646: getSnapshot signals every failure mode by returning null, so an
            // unresolved snapshot must abstain, not degrade to an empty claimant set.
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves(null);
            const eng = new FullNodeChallengeRound(hub);
            expect(await eng.claimantSet(288)).to.equal(null);
        });
it('claimantSet returns null when the snapshot shape is malformed (validators not an array)', async function () {
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: 'nope' });
            const eng = new FullNodeChallengeRound(hub);
            expect(await eng.claimantSet(288)).to.equal(null);
        });
});
});

// ── round flow: answer → sign-req → sign → finalize ────────────────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('eligibility', function () {
it('claimantSet returns a real empty Set for a legitimately empty snapshot', async function () {
            // A genuinely empty validators array is distinct from unresolved and
            // must NOT abstain (it yields a real, empty claimant set).
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [] });
            const eng = new FullNodeChallengeRound(hub);
            const set = await eng.claimantSet(288);
            expect(set).to.be.instanceOf(Set);
            expect(set.size).to.equal(0);
        });
it('runEpoch abstains (no round, no verdict) when the claimant snapshot is unresolved', async function () {
            // #2646: eligible set resolves, but the full_node capability snapshot is
            // null. The hub must abstain rather than lock an empty claimant set that
            // diverges from hubs whose snapshot resolved.
            wireRpc({ ledgerHash: SEED, tip: 300, verifiers: [], block: { tx: [{ vout: [{ scriptPubKey: { hex: 'deadbeef' } }] }] } });
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves(null);
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });
            await eng.runEpoch(288, 300);
            expect(eng.rounds.has(288), 'no round state created on claimant abstain').to.equal(false);
            expect(eng.broadcastFn.called, 'no verdict broadcast on claimant abstain').to.equal(false);
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'no sign request on claimant abstain').to.not.exist;
        });
});
});

// item 3463: the fee-bearing verdict send was the only one of the four hub
// effectors leaving no durable trace of its INTENT. These pin the record and,
// more importantly, the gate: an unwritable audit path must defer the verdict,
// not spend a BTC fee that nothing on disk remembers.
// The other half of that branch: a fee the round has permanently claimed must
// also be CHARGED to the spend window. record() therefore runs on the ambiguous
// verdict too, not only after a successful broadcast; charging on success alone
// leaves the window untouched and lets a later epoch spend an allowance this
// possibly-paid fee has already consumed.
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('round flow', function () {
    installSuiteHooks3();
it('computes the challenge and broadcasts its own answer digest (never plaintext, R2-FN2)', async function () {
            const hub = makeHub();                     // identity V1
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            expect(st.challengeId).to.equal(deriveChallengeId('regtest', 288, SEED, 188));
            expect(st.myAnswer).to.equal(ANSWER);
            const ans = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_ANSWER');
            expect(ans, 'XNODE_ANSWER broadcast').to.exist;
            expect(ans.args[1].answer_digest).to.equal(eng.answerDigest(st.challengeId, V1, ANSWER));
            expect(ans.args[1].answer, 'plaintext answer must never ride the wire').to.not.exist;
            expect(JSON.stringify(ans.args[1])).to.not.include(ANSWER);
        });
it('leader proposes the PASS list of claimants whose answer matches', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            // P1 (a claimant) submitted the CORRECT pubkey-bound digest.
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            // V1 is the only eligible verifier → it is leader → broadcasts a sign request
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'XNODE_SIGN_REQ broadcast').to.exist;
            expect(req.args[1].passList).to.include(P1);
        });
it('finalizes on quorum and broadcasts the on-chain verdict', async function () {
            const hub = makeHub();                       // V1 = sole genesis verifier → quorum 1
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);             // leader self-signs (V1) → quorum 1 met
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
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            // Hold the verdict broadcast open so a second finalize can race the first's await.
            let release = null, calls = 0;
            eng.broadcastFn = () => { calls++; return new Promise(res => { release = () => res({ txid: 'TX' + calls }); }); };
            const p1 = eng.closeCollection(288);        // leader self-signs → quorum 1 → maybeFinalize (broadcast held open)
            const p2 = eng.maybeFinalize(288);          // a second trigger during the broadcast await must NOT re-broadcast
            release();
            await Promise.all([p1, p2]);
            expect(calls, 'verdict broadcast exactly once').to.equal(1);
            expect(st.finalized).to.equal(true);
        });
});
});

describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('round flow', function () {
    installSuiteHooks3();
it('fsyncs an intent record BEFORE the verdict spend, then the outcome', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            let seen = [], sawIntentBeforeSpend = false;
            eng.recordSpend = (entry) => { seen.push(entry); return true; };
            eng.broadcastFn = () => {
                sawIntentBeforeSpend = seen.some(e => e.phase === 'intent');
                return Promise.resolve({ txid: 'TX' });
            };
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            expect(sawIntentBeforeSpend, 'intent must be durable before the fee moves').to.equal(true);
            expect(seen.map(e => e.phase)).to.deep.equal(['intent', 'sent']);
            expect(seen[0].challengeId).to.equal(st.challengeId);
            expect(seen[0].epoch).to.equal(288);
            expect(seen[1].txid).to.equal('TX');
        });
it('defers the verdict instead of spending when the audit path is unwritable', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            eng.recordSpend = () => false;              // disk full / bad permissions
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            expect(eng.broadcastFn.called, 'no BTC fee without a durable record').to.equal(false);
            // Deferred, not lost: the finalize lock is released so a later tick retries.
            expect(st.finalized).to.equal(false);
        });
it('records an ambiguous send, which is the case the audit trail exists for', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            let seen = [];
            eng.recordSpend = (entry) => { seen.push(entry); return true; };
            eng.broadcastFn = () => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            expect(seen.map(e => e.phase)).to.deep.equal(['intent', 'ambiguous']);
            // The round stays claimed: an ambiguous send may already have cost the fee.
            expect(st.finalized).to.equal(true);
        });
it('charges the spend window for an AMBIGUOUS verdict, not just for a clean one', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            eng.recordSpend = () => true;
            eng.broadcastFn = () => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            expect(eng.spendGuard.spentInWindow(),
                   'a possibly-paid BTC fee consumes the window').to.equal(eng.spendGuard.estSpendUsdCents);
        });
});
});

// The mirror: a DEFINITIVE rejection left nothing on the wire, so the budget
// goes back and a later tick can retry inside the same window.
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('round flow', function () {
    installSuiteHooks3();
it('hands the window back when the verdict is definitively rejected', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            eng.recordSpend = () => true;
            eng.broadcastFn = () => Promise.reject(new Error('Encoder RPC error: bad-txns-inputs-missingorspent'));
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            expect(eng.spendGuard.spentInWindow(),
                   'nothing left the process, so nothing is charged').to.equal(0);
            expect(st.finalized, 'and the round unlocks for a later retry').to.equal(false);
        });
// A failover verdict (state.leadRank > 0, the _tick ladder promoting the next
// rank after the elected leader landed nothing) was otherwise byte-identical to a
// healthy rank-0 verdict in every observable signal, so a dead elected leader
// stayed invisible while the ladder quietly absorbed its rounds. Pin the rank on
// the durable record and the marker on the log line, both directions.
it('names the broadcast rank on the sent record and marks a failover verdict', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            let seen = [];
            eng.recordSpend = (entry) => { seen.push(entry); return true; };
            st.leadRank = 2;                   // _tick promoted rank 2: nothing landed at 0 or 1
            const logged = sinon.stub(console, 'log');
            try {
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
            } finally { logged.restore(); }
            const sent = seen.find(e => e.phase === 'sent');
            expect(sent, 'verdict sent').to.exist;
            expect(sent.leadRank, 'the durable record names the rank that spent the fee').to.equal(2);
            const line = logged.getCalls().map(c => String(c.args[0])).find(s => /verdict broadcast/.test(s));
            expect(line, 'verdict log line').to.exist;
            expect(line).to.include('[FAILOVER');
        });
it('leaves a healthy rank-0 verdict unmarked', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            let seen = [];
            eng.recordSpend = (entry) => { seen.push(entry); return true; };
            const logged = sinon.stub(console, 'log');
            try {
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
            } finally { logged.restore(); }
            const sent = seen.find(e => e.phase === 'sent');
            expect(sent.leadRank, 'the elected leader broadcasts at rank 0').to.equal(0);
            const line = logged.getCalls().map(c => String(c.args[0])).find(s => /verdict broadcast/.test(s));
            expect(line).to.not.include('FAILOVER');
        });
});
});
