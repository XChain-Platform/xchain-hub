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

async function startEpoch(hub) {
            wireRpc({ ledgerHash: SEED, tip: 300, verifiers: [], block });
            // Two claimants: P1 (honest full node) and P2 (light mirror).
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: P1 }, { pubkey: P2 }] });
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });
            await eng.runEpoch(288, 300);
            return eng;
        }

function seedRound(eng) {
            const st = {
                epoch: 7, challengeId: 'cidFN3', finalized: false,
                eligible: new Set([V1, V2]),
                claimants: new Set([P1, P2]),
                // Both confirmed correct: pubkey-bound digests of the same answer (R2-FN2).
                answers: new Map([
                    [P1, eng.answerDigest('cidFN3', P1, 'ANS')],
                    [P2, eng.answerDigest('cidFN3', P2, 'ANS')],
                ]),
                myAnswer: 'ANS', target: 188, seed: SEED,
                sigs: new Map(), passList: null, leadRank: 0,
            };
            eng.rounds.set(7, st);
            return st;
        }

// ── R2-FN2: the possession answer is pubkey-bound; a light mirror copying
// an honest claimant's gossiped value must never earn a PASS ─────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('R2-FN2 answer copy attack', function () {
it('a copied digest (another claimant\'s wire value) never earns a PASS', async function () {
            const hub = makeHub();                        // identity V1 = sole verifier/leader
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            const honest = eng.answerDigest(st.challengeId, P1, ANSWER);
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P1, sig: 's' });
            // P2 copies P1's public gossip verbatim and re-signs it as its own.
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P2, sig: 's' });
            await eng.closeCollection(288);
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'XNODE_SIGN_REQ broadcast').to.exist;
            expect(req.args[1].passList).to.include(P1);
            expect(req.args[1].passList, 'copier must not pass').to.not.include(P2);
        });
it('a verifier refuses to sign a PASS list that includes a copier', async function () {
            const hub = makeHub();                        // identity V1 (verifier)
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            const honest = eng.answerDigest(st.challengeId, P1, ANSWER);
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P1, sig: 's' });
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P2, sig: 's' });
            const leader = eng._electedLeader(st);
            await eng.onSignReq({ epoch: 288, challengeId: st.challengeId, sig_pubkey: leader, passList: [P1, P2], sig: 'x' });
            const signed = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN');
            expect(signed, 'must not co-sign a pass list containing a copier').to.not.exist;
        });
it('onAnswer rejects a non-64-hex digest', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            eng.onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: ANSWER, sig_pubkey: P1, sig: 's' });
            expect(st.answers.has(P1)).to.equal(false);
        });
it('answerDigest binds challenge, pubkey, and answer', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const d1 = eng.answerDigest('cid', P1, 'ans');
            expect(d1).to.match(/^[0-9a-f]{64}$/);
            expect(eng.answerDigest('cid', P2, 'ans')).to.not.equal(d1);   // pubkey-bound
            expect(eng.answerDigest('cid2', P1, 'ans')).to.not.equal(d1);  // challenge-bound
            expect(eng.answerDigest('cid', P1, 'ans2')).to.not.equal(d1);  // answer-bound
            expect(eng.answerDigest('cid', P1.toUpperCase(), 'ans')).to.equal(d1); // case-normalized pubkey
        });
});
});

// ── R2-FN3: a verifier must refuse to sign a PASS list that OMITS a claimant
// it independently confirmed correct (a censoring leader dropping honest
// full nodes) ────────────────────────────────────────────────────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('R2-FN3 pass-list completeness', function () {
it('refuses to sign a PASS list that omits a claimant it confirmed correct', async function () {
            setGenesisVerifiers([V1, V2]);
            const hub = makeHub({ identity: makeIdentity(V2) });
            const eng = new FullNodeChallengeRound(hub);
            const st  = seedRound(eng);
            const leader = eng._electedLeader(st);
            // Leader's list drops P2 (which this node independently confirmed).
            await eng.onSignReq({ epoch: 7, challengeId: 'cidFN3', sig_pubkey: leader, passList: [P1], sig: 'x' });
            expect(st.sigs.has(V2)).to.equal(false);
            const signed = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN');
            expect(signed, 'must not sign an incomplete pass list').to.not.exist;
        });
it('signs a complete PASS list', async function () {
            setGenesisVerifiers([V1, V2]);
            const hub = makeHub({ identity: makeIdentity(V2) });
            const eng = new FullNodeChallengeRound(hub);
            const st  = seedRound(eng);
            const leader = eng._electedLeader(st);
            await eng.onSignReq({ epoch: 7, challengeId: 'cidFN3', sig_pubkey: leader, passList: [P1, P2], sig: 'x' });
            const signed = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN');
            expect(signed, 'signs when the pass list is complete').to.exist;
        });
});
});
