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
    FullNodeChallengeRound = proxyquire('../../../src/consensus/full_node_challenge_round', {
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

const ANSWER = 'deadbeef';

const block = { tx: [{ vout: [{ scriptPubKey: { hex: ANSWER } }] }] };

let clock;

async function startEpoch(hub) {
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

const fs   = require('fs');

const os   = require('os');

const path = require('path');

let dir;

function writeLog(records) {
                const p = path.join(dir, 'verdict.spend.jsonl');
                fs.writeFileSync(p, records.map(r => JSON.stringify(Object.assign({ effector: 'FULLNODE_VERDICT', ts: 1 }, r))).join('\n') + '\n');
                return p;
            }

async function restartWith(logPath) {
                // A restarted engine: same config, spend log of the PREVIOUS process.
                const hub = makeHub();
                const eng = await startEpoch(hub);
                eng.spendLogPath = logPath;
                eng.loadSpendLog();                 // what start() now does before the first tick
                return { hub, eng };
            }

function installSuiteHooks4() {
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnc-replay-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
}

describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('round flow', function () {
    installSuiteHooks3();
it('writes a real fsynced line to the configured spend log', async function () {
            const fs   = require('fs');
            const os   = require('os');
            const path = require('path');
            const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'fnc-spend-'));
            const logPath = path.join(dir, 'nested', 'verdict.spend.jsonl');
            const hub = makeHub();
            const eng = await startEpoch(hub);
            eng.spendLogPath = logPath;                  // directory does not exist yet
            const st = eng.rounds.get(288);
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
            expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'sent']);
            expect(lines[0].effector).to.equal('FULLNODE_VERDICT');
            expect(lines[0].challengeId).to.equal(st.challengeId);
            expect(lines[0].ts).to.be.a('number');
            fs.rmSync(dir, { recursive: true, force: true });
        });
it('a non-leader does not broadcast a verdict', async function () {
            // identity V2 is eligible (we add it to genesis) but rank may not be 0;
            // force two verifiers so quorum is 2 and a single self-sign cannot finalize.
            setGenesisVerifiers([V1, V2]);
            const hub = makeHub({ identity: makeIdentity(V2) });
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng.closeCollection(288);
            // quorum is 2 (V=2) but only one self-sign so far → no finalize
            expect(eng.broadcastFn.called).to.equal(false);
        });
it('a verifier that is not a claimant computes its answer silently (so it can lead)', async function () {
            // V2 is a genesis verifier but NOT in the claimant snapshot ([V1, P1]).
            setGenesisVerifiers([V1, V2]);
            const hub = makeHub({ identity: makeIdentity(V2) });
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            expect(st.myAnswer).to.equal(ANSWER);                 // computed for leading/verifying
            const ans = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_ANSWER' && c.args[1].sig_pubkey === V2);
            expect(ans, 'a verifier-only node must NOT broadcast a possession claim').to.not.exist;
        });
});
});

// item 3463 wrote the intent but nothing read it back, so the guard
// only bound one process lifetime. The epoch is recomputed deterministically
// from the tip, so a restart inside acceptWindow rebuilds the SAME round and
// re-wins leadership; these pin that the recovered log, not the empty in-memory
// rounds map, is what decides whether the fee has already been committed.
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('round flow', function () {
    installSuiteHooks3();
describe('#4249 restart replay of a committed verdict', function () {
    installSuiteHooks4();
it('a sent verdict is not re-broadcast after a restart', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'sent', epoch: 288, txid: 'TXPRIOR' },
                ]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.called, 'no second BTC fee for an epoch already spent').to.equal(false);
                expect(st.finalized, 'the round is claimed, not left retrying').to.equal(true);
            });
it('a bare intent (crashed mid-flight) also blocks the re-broadcast', async function () {
                const { eng } = await restartWith(writeLog([{ phase: 'intent', epoch: 288 }]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.called, 'a dangling intent may already have paid').to.equal(false);
            });
it('an ambiguous send blocks it too (the case the audit trail exists for)', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'ambiguous', epoch: 288, error: 'socket hang up' },
                ]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.called).to.equal(false);
            });
// The liveness half: only a DEFINITIVE pre-send failure spent nothing, and
// that is the one shape that must still retry after a restart.
it('a definitively failed send still retries after a restart', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'failed', epoch: 288, error: 'rejected' },
                ]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.calledOnce, 'a never-sent verdict must still land').to.equal(true);
            });
// The retry's OWN intent has to re-arm the guard. A first-record-wins fold
// reads this log as 'failed' and re-broadcasts, which is the double spend
// the whole item is about, reached through the one path that appends twice.
it('a retry after a definitive failure re-arms the guard when it crashes mid-flight', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'failed', epoch: 288, error: 'rejected' },
                    { phase: 'intent', epoch: 288 },
                ]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.called, 'the retry may already have paid the fee').to.equal(false);
            });
});
});
});

describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('round flow', function () {
    installSuiteHooks3();
describe('#4249 restart replay of a committed verdict', function () {
    installSuiteHooks4();
it('two definitive failures in a row still leave the verdict retryable', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'failed', epoch: 288, error: 'rejected' },
                    { phase: 'intent', epoch: 288 }, { phase: 'failed', epoch: 288, error: 'rejected again' },
                ]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.calledOnce, 'nothing was ever spent, so liveness wins').to.equal(true);
            });
it('a paid epoch is never unlocked by a later record', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'sent', epoch: 288, txid: 'TXPRIOR' },
                    { phase: 'failed', epoch: 288, error: 'a trailing line must not clear a paid epoch' },
                ]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.called).to.equal(false);
            });
it('another epoch in the log never gates this one', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 144 }, { phase: 'sent', epoch: 144, txid: 'TXOLD' },
                ]));
                const st = eng.rounds.get(288);
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng.broadcastFn.calledOnce).to.equal(true);
            });
it('an absent log (first run) and a torn tail line both load quietly', async function () {
                const hub = makeHub();
                const eng = await startEpoch(hub);
                eng.spendLogPath = path.join(dir, 'does-not-exist.jsonl');
                expect(() => eng.loadSpendLog()).to.not.throw();
                expect(eng._committedEpochs.size).to.equal(0);
                const p = path.join(dir, 'torn.jsonl');
                fs.writeFileSync(p, JSON.stringify({ phase: 'sent', epoch: 288 }) + '\n{"phase":"sen');
                eng.spendLogPath = p;
                eng.loadSpendLog();
                expect([...eng._committedEpochs]).to.deep.equal([288]);
            });
});
});
});

describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('round flow', function () {
    installSuiteHooks3();
describe('#4249 restart replay of a committed verdict', function () {
    installSuiteHooks4();
it('an in-process send marks the epoch committed, matching the reload rule', async function () {
                const hub = makeHub();
                const eng = await startEpoch(hub);
                const st  = eng.rounds.get(288);
                eng.recordSpend = () => true;
                eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng.answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng.closeCollection(288);
                expect(eng._committedEpochs.has(288)).to.equal(true);
            });
});
});
});
