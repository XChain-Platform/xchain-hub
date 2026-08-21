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
const srb          = require('../../src/snapshot_reorg_buffer.js');

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

// the consensus-relevant FULLNODE params (interval, depths, windows,
// genesis verifiers) now come from the PINNED coin registry, not from p2pConfig.
// p2pConfig keeps only the operational knobs, so this fixture does too. Tests that
// need different consensus values drive the registry's documented regtest override
// surface (setGenesisVerifiers below), which is the only supported way to move them
// and is exactly what a regtest operator has.
function fullnodeCfg(overrides) {
    return Object.assign({
        POLL_MS: 30000,
        COLLECT_MS: 20000,
        BTC_RPC: 'http://coin',
    }, overrides || {});
}

// Drive FULLNODE.GENESIS_VERIFIERS through the registry's regtest env override
// (resolveFullnode reads it at getCoinConfig() time, so it must be set BEFORE the
// engine is constructed). Restored by the afterEach below.
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

    beforeEach(() => { loadModule(); setGenesisVerifiers(V1); });
    afterEach(() => { sinon.restore(); setGenesisVerifiers(null); });

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
        // An absent p2pConfig.FULLNODE block can no longer affect the consensus params:
        // they come from the registry, which always has them. This is the #3215 property.
        it('uses the pinned registry values even with no p2pConfig FULLNODE block', function () {
            const hub = makeHub();
            hub.p2pConfig.FULLNODE = {};
            const eng = new FullNodeChallengeRound(hub);
            expect(eng.interval).to.equal(144);
            expect(eng.confirmDepth).to.equal(100);
            expect(eng.acceptWindow).to.equal(24);
            expect(eng.closeDepth).to.equal(3);
        });
        it('drops malformed genesis pubkeys', function () {
            setGenesisVerifiers([V1, 'nope', 'AB']);
            const eng = new FullNodeChallengeRound(makeHub());
            expect([...eng.genesis]).to.deep.equal([V1]);
        });
        it('an empty genesis set resolves to an empty set, not a default', function () {
            setGenesisVerifiers(null);
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng.genesis.size).to.equal(0);
        });
    });

    // ── Consensus params come from the PINNED registry ─────────────
    // These used to resolve `process.env.FULLNODE_* || p2pConfig || '<literal>'`,
    // env FIRST, on every network. On mainnet that let an operator env var silently
    // override a pinned consensus parameter while CONSENSUS_CONFIG_PIN still verified
    // clean, because the pin covers the registry and not what this class used. Two
    // hubs with different FULLNODE_CONFIRM_DEPTH compute different possession answers
    // and different PASS lists, both reporting a matching pin.
    describe('#3215 pinned-registry resolution', function () {
        const CONSENSUS_ENV = {
            FULLNODE_CHALLENGE_INTERVAL_BLOCKS:    '7',
            FULLNODE_CONFIRM_DEPTH:                '8',
            FULLNODE_VERDICT_ACCEPT_WINDOW_BLOCKS: '9',
            FULLNODE_COLLECT_DEPTH_BLOCKS:         '11',
        };
        let saved;
        beforeEach(() => {
            saved = {};
            for (const k of Object.keys(CONSENSUS_ENV)) { saved[k] = process.env[k]; process.env[k] = CONSENSUS_ENV[k]; }
        });
        afterEach(() => {
            for (const k of Object.keys(CONSENSUS_ENV)) {
                if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
            }
        });

        for (const net of ['mainnet', 'testnet']) {
            it(`ignores every FULLNODE_* env override on ${net}`, function () {
                const eng = new FullNodeChallengeRound(makeHub({ hub: { network: net } }));
                expect(eng.interval,     'CHALLENGE_INTERVAL_BLOCKS').to.equal(144);
                expect(eng.confirmDepth, 'CONFIRM_DEPTH').to.equal(100);
                expect(eng.acceptWindow, 'VERDICT_ACCEPT_WINDOW_BLOCKS').to.equal(24);
                expect(eng.closeDepth,   'COLLECT_DEPTH_BLOCKS').to.equal(3);
            });
        }

        it('honours the same env overrides on regtest, which is the described surface', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng.interval).to.equal(7);
            expect(eng.confirmDepth).to.equal(8);
            expect(eng.acceptWindow).to.equal(9);
            expect(eng.closeDepth).to.equal(11);
        });

        it('a p2pConfig FULLNODE block cannot move a consensus param on mainnet', function () {
            const hub = makeHub({ hub: { network: 'mainnet' } });
            hub.p2pConfig.FULLNODE = Object.assign({}, hub.p2pConfig.FULLNODE, {
                CHALLENGE_INTERVAL_BLOCKS: 1, CONFIRM_DEPTH: 2,
                VERDICT_ACCEPT_WINDOW_BLOCKS: 3, COLLECT_DEPTH_BLOCKS: 4,
            });
            const eng = new FullNodeChallengeRound(hub);
            expect(eng.interval).to.equal(144);
            expect(eng.confirmDepth).to.equal(100);
            expect(eng.acceptWindow).to.equal(24);
            expect(eng.closeDepth).to.equal(3);
        });

        it('the effective values equal the pinned registry byte for byte (§7 proof)', function () {
            const coins = require('../../src/coins/index.js');
            for (const net of ['mainnet', 'testnet', 'regtest']) {
                const pinned = coins.getCoinConfig('BTC', net).FULLNODE;
                const eng    = new FullNodeChallengeRound(makeHub({ hub: { network: net } }));
                expect(eng.interval,     `${net} interval`).to.equal(pinned.CHALLENGE_INTERVAL_BLOCKS);
                expect(eng.confirmDepth, `${net} confirmDepth`).to.equal(pinned.CONFIRM_DEPTH);
                expect(eng.acceptWindow, `${net} acceptWindow`).to.equal(pinned.VERDICT_ACCEPT_WINDOW_BLOCKS);
                expect(eng.closeDepth,   `${net} closeDepth`).to.equal(pinned.COLLECT_DEPTH_BLOCKS);
            }
        });

        it('fails closed when the registry lacks a consensus param, rather than defaulting', function () {
            const coins = require('../../src/coins/index.js');
            const orig  = coins.getCoinConfig;
            sinon.stub(coins, 'getCoinConfig').callsFake((tick, net) => {
                const cfg = orig.call(coins, tick, net);
                const fn  = Object.assign({}, cfg.FULLNODE);
                delete fn.CONFIRM_DEPTH;
                return Object.assign({}, cfg, { FULLNODE: fn });
            });
            expect(() => new FullNodeChallengeRound(makeHub())).to.throw(/CONFIRM_DEPTH/);
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
        // #3859: the PASS order lands in the signed preimage, so it is consensus. A bare
        // .sort() orders by UTF-16 code unit, which diverges from UTF-8 byte order above
        // the BMP; the indexer VERIFIER (nodeproof.js) is pinned to Buffer.compare, so
        // every producing site here must be too or the two sides sign different bytes.
        it('_buildVerdictWire sorts PASS by BYTE, not UTF-16 code unit', function () {
            const eng    = new FullNodeChallengeRound(makeHub());
            const wide   = '！';      // UTF-8 EF BC 81
            const astral = '\u{1F600}';   // UTF-8 F0 9F 98 80, UTF-16 lead unit D83D
            // The default sort compares D83D < FF01 and would emit the astral one first.
            expect([wide, astral].slice().sort()).to.deep.equal([astral, wide]);
            const wire = eng._buildVerdictWire({
                challengeId: 'cid', epoch: 288, passList: [astral, wide], sigs: new Map(),
            }).split('|');
            expect(wire.slice(5, 7)).to.deep.equal([wide, astral]);
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
        it('resolves the verifier set at the BURIED height, not the tip-adjacent epoch', async function () {
            // The eligible set is the leader-election domain and the 2/3+1 quorum
            // divisor, and a round runs while tip - epoch <= acceptWindow, so the epoch
            // is tip-adjacent and its stake state is not reorg-safe: two hubs whose
            // reads straddled a shallow BTC reorg resolved different member lists for
            // the same epoch. Every other validator-set lock the hub performs already
            // buries, _claimantSet in this same engine included. Gated by the shared
            // snapshot_reorg_buffer flag day so the hub moves in lockstep with the
            // indexer that grades the verdict (nodeproof.js buries through the same
            // gate); regtest is armed from genesis, so the buffer is live here.
            wireRpc({ verifiers: [{ pubkey: V2 }] });
            const eng = new FullNodeChallengeRound(makeHub());
            await eng._eligibleVerifiers(288);
            const call = axiosStub.post.getCalls().find(c => c.args[1] && c.args[1].method === 'getfullnodeverifiers');
            expect(call, 'getfullnodeverifiers was never called').to.not.equal(undefined);
            expect(call.args[1].params.block_index).to.equal(288 - srb.CANONICAL_REORG_BUFFER);
        });
        it('ABSTAINS (returns null) rather than degrading to genesis-only when the verifiers RPC is unavailable', async function () {
            // Consensus-critical: a per-hub, reachability-dependent fallback to the
            // genesis-only subset would split leader election and the quorum
            // denominator across honest hubs. Fail CLOSED instead (see _eligibleVerifiers).
            axiosStub.post.rejects(new Error('no rpc'));
            const eng = new FullNodeChallengeRound(makeHub());
            const set = await eng._eligibleVerifiers(288);
            expect(set).to.equal(null);
        });
        it('ABSTAINS (returns null) on an in-band indexer result.error (200 with error body)', async function () {
            // The indexer reports failures as result.error, not the top-level JSON-RPC
            // error envelope; _indexerCall surfaces it so a degraded indexer causes an
            // abstain, not a silently narrowed (genesis-only) verifier set.
            axiosStub.post.callsFake(async () => ({ data: { result: { error: 'indexer unavailable' } } }));
            const eng = new FullNodeChallengeRound(makeHub());
            const set = await eng._eligibleVerifiers(288);
            expect(set).to.equal(null);
        });
        it('a genuinely genesis-only federation still resolves (empty indexer list is NOT an error)', async function () {
            // Preserve the legitimate genesis-only path: a successful indexer call that
            // returns no verified full nodes yields the configured genesis set, not an abstain.
            wireRpc({ verifiers: [] });
            const eng = new FullNodeChallengeRound(makeHub());       // genesis = [V1]
            const set = await eng._eligibleVerifiers(288);
            expect([...set]).to.deep.equal([V1]);
        });
        it('ALARMS (and still proceeds) when the indexer marks the verifier set truncated', async function () {
            // getfullnodeverifiers carries `truncated` so a hub can say the set hit
            // VALIDATOR_QUERY_LIMIT. This set is the 2/3+1 divisor, so consuming a cap
            // silently lowers the quorum bar with no operator signal. Alarm-and-proceed
            // (not abstain): every indexer truncates identically, so the capped set is
            // still cross-hub deterministic, and refusing would halt the round the
            // moment the verifier set outgrows the cap.
            axiosStub.post.callsFake(async (url, body) => {
                const m = body.method;
                if (m === 'getfullnodeverifiers')
                    return { data: { result: { validators: [{ pubkey: V2 }], truncated: true } } };
                return { data: { result: null } };
            });
            const logged = sinon.stub(console, 'error');
            const eng = new FullNodeChallengeRound(makeHub());
            const set = await eng._eligibleVerifiers(288);
            expect([...set].sort(), 'the capped set is still consumed').to.deep.equal([V1, V2].sort());
            expect(logged.calledWithMatch('TRUNCATED'), 'no truncation alarm was raised').to.equal(true);
        });
        it('does not alarm when the indexer does not mark the set truncated', async function () {
            wireRpc({ verifiers: [{ pubkey: V2 }] });
            const logged = sinon.stub(console, 'error');
            const eng = new FullNodeChallengeRound(makeHub());
            await eng._eligibleVerifiers(288);
            expect(logged.calledWithMatch('TRUNCATED')).to.equal(false);
        });
        it('_runEpoch abstains (creates no round, emits no verdict) when the verifier set is unresolved', async function () {
            // RPC-failure abstain regression: getblockhashes succeeds (so _runEpoch is
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
            await eng._runEpoch(288, 300);
            expect(eng.rounds.has(288), 'no round state created on abstain').to.equal(false);
            expect(eng.broadcastFn.called, 'no verdict broadcast on abstain').to.equal(false);
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'no sign request on abstain').to.not.exist;
        });
        it('_claimantSet reads the full_node capability snapshot', async function () {
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: P1 }, { pubkey: P2 }] });
            const eng = new FullNodeChallengeRound(hub);
            const set = await eng._claimantSet(288);
            expect([...set].sort()).to.deep.equal([P1, P2].sort());
            expect(hub.capabilitySnapshot.getSnapshot.calledWith('full_node', 288)).to.equal(true);
        });
        it('_claimantSet returns null (fail closed) when the snapshot is unresolved (null)', async function () {
            // #2646: getSnapshot signals every failure mode by returning null, so an
            // unresolved snapshot must abstain, not degrade to an empty claimant set.
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves(null);
            const eng = new FullNodeChallengeRound(hub);
            expect(await eng._claimantSet(288)).to.equal(null);
        });
        it('_claimantSet returns null when the snapshot shape is malformed (validators not an array)', async function () {
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: 'nope' });
            const eng = new FullNodeChallengeRound(hub);
            expect(await eng._claimantSet(288)).to.equal(null);
        });
        it('_claimantSet returns a real empty Set for a legitimately empty snapshot', async function () {
            // A genuinely empty validators array is distinct from unresolved and
            // must NOT abstain (it yields a real, empty claimant set).
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [] });
            const eng = new FullNodeChallengeRound(hub);
            const set = await eng._claimantSet(288);
            expect(set).to.be.instanceOf(Set);
            expect(set.size).to.equal(0);
        });
        it('_runEpoch abstains (no round, no verdict) when the claimant snapshot is unresolved', async function () {
            // #2646: eligible set resolves, but the full_node capability snapshot is
            // null. The hub must abstain rather than lock an empty claimant set that
            // diverges from hubs whose snapshot resolved.
            wireRpc({ ledgerHash: SEED, tip: 300, verifiers: [], block: { tx: [{ vout: [{ scriptPubKey: { hex: 'deadbeef' } }] }] } });
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves(null);
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });
            await eng._runEpoch(288, 300);
            expect(eng.rounds.has(288), 'no round state created on claimant abstain').to.equal(false);
            expect(eng.broadcastFn.called, 'no verdict broadcast on claimant abstain').to.equal(false);
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'no sign request on claimant abstain').to.not.exist;
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

        it('computes the challenge and broadcasts its own answer digest (never plaintext, R2-FN2)', async function () {
            const hub = makeHub();                     // identity V1
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            expect(st.challengeId).to.equal(deriveChallengeId('regtest', 288, SEED, 188));
            expect(st.myAnswer).to.equal(ANSWER);
            const ans = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_ANSWER');
            expect(ans, 'XNODE_ANSWER broadcast').to.exist;
            expect(ans.args[1].answer_digest).to.equal(eng._answerDigest(st.challengeId, V1, ANSWER));
            expect(ans.args[1].answer, 'plaintext answer must never ride the wire').to.not.exist;
            expect(JSON.stringify(ans.args[1])).to.not.include(ANSWER);
        });

        it('leader proposes the PASS list of claimants whose answer matches', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            // P1 (a claimant) submitted the CORRECT pubkey-bound digest.
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
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
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
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
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
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

        // item 3463: the fee-bearing verdict send was the only one of the four hub
        // effectors leaving no durable trace of its INTENT. These pin the record and,
        // more importantly, the gate: an unwritable audit path must defer the verdict,
        // not spend a BTC fee that nothing on disk remembers.
        it('fsyncs an intent record BEFORE the verdict spend, then the outcome', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            let seen = [], sawIntentBeforeSpend = false;
            eng._recordSpend = (entry) => { seen.push(entry); return true; };
            eng.broadcastFn = () => {
                sawIntentBeforeSpend = seen.some(e => e.phase === 'intent');
                return Promise.resolve({ txid: 'TX' });
            };
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);
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
            eng._recordSpend = () => false;              // disk full / bad permissions
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);
            expect(eng.broadcastFn.called, 'no BTC fee without a durable record').to.equal(false);
            // Deferred, not lost: the finalize lock is released so a later tick retries.
            expect(st.finalized).to.equal(false);
        });

        it('records an ambiguous send, which is the case the audit trail exists for', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            let seen = [];
            eng._recordSpend = (entry) => { seen.push(entry); return true; };
            eng.broadcastFn = () => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);
            expect(seen.map(e => e.phase)).to.deep.equal(['intent', 'ambiguous']);
            // The round stays claimed: an ambiguous send may already have cost the fee.
            expect(st.finalized).to.equal(true);
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
            eng._recordSpend = (entry) => { seen.push(entry); return true; };
            st.leadRank = 2;                   // _tick promoted rank 2: nothing landed at 0 or 1
            const logged = sinon.stub(console, 'log');
            try {
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
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
            eng._recordSpend = (entry) => { seen.push(entry); return true; };
            const logged = sinon.stub(console, 'log');
            try {
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
            } finally { logged.restore(); }
            const sent = seen.find(e => e.phase === 'sent');
            expect(sent.leadRank, 'the elected leader broadcasts at rank 0').to.equal(0);
            const line = logged.getCalls().map(c => String(c.args[0])).find(s => /verdict broadcast/.test(s));
            expect(line).to.not.include('FAILOVER');
        });

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
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);
            const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
            expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'sent']);
            expect(lines[0].effector).to.equal('FULLNODE_VERDICT');
            expect(lines[0].challengeId).to.equal(st.challengeId);
            expect(lines[0].ts).to.be.a('number');
            fs.rmSync(dir, { recursive: true, force: true });
        });

        // item 3463 wrote the intent but nothing read it back, so the guard
        // only bound one process lifetime. The epoch is recomputed deterministically
        // from the tip, so a restart inside acceptWindow rebuilds the SAME round and
        // re-wins leadership; these pin that the recovered log, not the empty in-memory
        // rounds map, is what decides whether the fee has already been committed.
        describe('#4249 restart replay of a committed verdict', function () {
            const fs   = require('fs');
            const os   = require('os');
            const path = require('path');
            let dir;
            beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnc-replay-')); });
            afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

            function writeLog(records) {
                const p = path.join(dir, 'verdict.spend.jsonl');
                fs.writeFileSync(p, records.map(r => JSON.stringify(Object.assign({ effector: 'FULLNODE_VERDICT', ts: 1 }, r))).join('\n') + '\n');
                return p;
            }
            // A restarted engine: same config, spend log of the PREVIOUS process.
            async function restartWith(logPath) {
                const hub = makeHub();
                const eng = await startEpoch(hub);
                eng.spendLogPath = logPath;
                eng._loadSpendLog();                 // what start() now does before the first tick
                return { hub, eng };
            }

            it('a sent verdict is not re-broadcast after a restart', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'sent', epoch: 288, txid: 'TXPRIOR' },
                ]));
                const st = eng.rounds.get(288);
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng.broadcastFn.called, 'no second BTC fee for an epoch already spent').to.equal(false);
                expect(st.finalized, 'the round is claimed, not left retrying').to.equal(true);
            });

            it('a bare intent (crashed mid-flight) also blocks the re-broadcast', async function () {
                const { eng } = await restartWith(writeLog([{ phase: 'intent', epoch: 288 }]));
                const st = eng.rounds.get(288);
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng.broadcastFn.called, 'a dangling intent may already have paid').to.equal(false);
            });

            it('an ambiguous send blocks it too (the case the audit trail exists for)', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'ambiguous', epoch: 288, error: 'socket hang up' },
                ]));
                const st = eng.rounds.get(288);
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng.broadcastFn.called).to.equal(false);
            });

            // The liveness half: only a DEFINITIVE pre-send failure spent nothing, and
            // that is the one shape that must still retry after a restart.
            it('a definitively failed send still retries after a restart', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'failed', epoch: 288, error: 'rejected' },
                ]));
                const st = eng.rounds.get(288);
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
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
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng.broadcastFn.called, 'the retry may already have paid the fee').to.equal(false);
            });

            it('two definitive failures in a row still leave the verdict retryable', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'failed', epoch: 288, error: 'rejected' },
                    { phase: 'intent', epoch: 288 }, { phase: 'failed', epoch: 288, error: 'rejected again' },
                ]));
                const st = eng.rounds.get(288);
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng.broadcastFn.calledOnce, 'nothing was ever spent, so liveness wins').to.equal(true);
            });

            it('a paid epoch is never unlocked by a later record', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 288 }, { phase: 'sent', epoch: 288, txid: 'TXPRIOR' },
                    { phase: 'failed', epoch: 288, error: 'a trailing line must not clear a paid epoch' },
                ]));
                const st = eng.rounds.get(288);
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng.broadcastFn.called).to.equal(false);
            });

            it('another epoch in the log never gates this one', async function () {
                const { eng } = await restartWith(writeLog([
                    { phase: 'intent', epoch: 144 }, { phase: 'sent', epoch: 144, txid: 'TXOLD' },
                ]));
                const st = eng.rounds.get(288);
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng.broadcastFn.calledOnce).to.equal(true);
            });

            it('an absent log (first run) and a torn tail line both load quietly', async function () {
                const hub = makeHub();
                const eng = await startEpoch(hub);
                eng.spendLogPath = path.join(dir, 'does-not-exist.jsonl');
                expect(() => eng._loadSpendLog()).to.not.throw();
                expect(eng._committedEpochs.size).to.equal(0);
                const p = path.join(dir, 'torn.jsonl');
                fs.writeFileSync(p, JSON.stringify({ phase: 'sent', epoch: 288 }) + '\n{"phase":"sen');
                eng.spendLogPath = p;
                eng._loadSpendLog();
                expect([...eng._committedEpochs]).to.deep.equal([288]);
            });

            it('an in-process send marks the epoch committed, matching the reload rule', async function () {
                const hub = makeHub();
                const eng = await startEpoch(hub);
                const st  = eng.rounds.get(288);
                eng._recordSpend = () => true;
                eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
                await eng._closeCollection(288);
                expect(eng._committedEpochs.has(288)).to.equal(true);
            });
        });

        it('a non-leader does not broadcast a verdict', async function () {
            // identity V2 is eligible (we add it to genesis) but rank may not be 0;
            // force two verifiers so quorum is 2 and a single self-sign cannot finalize.
            setGenesisVerifiers([V1, V2]);
            const hub = makeHub({ identity: makeIdentity(V2) });
            const eng = await startEpoch(hub);
            const st = eng.rounds.get(288);
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: eng._answerDigest(st.challengeId, P1, ANSWER), sig_pubkey: P1, sig: 's' });
            await eng._closeCollection(288);
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

    // ── R2-FN2: the possession answer is pubkey-bound; a light mirror copying
    //    an honest claimant's gossiped value must never earn a PASS ─────────────
    describe('R2-FN2 answer copy attack', function () {
        const ANSWER = 'deadbeef';
        const block = { tx: [{ vout: [{ scriptPubKey: { hex: ANSWER } }] }] };

        async function startEpoch(hub) {
            wireRpc({ ledgerHash: SEED, tip: 300, verifiers: [], block });
            // Two claimants: P1 (honest full node) and P2 (light mirror).
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: P1 }, { pubkey: P2 }] });
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });
            await eng._runEpoch(288, 300);
            return eng;
        }

        it('a copied digest (another claimant\'s wire value) never earns a PASS', async function () {
            const hub = makeHub();                        // identity V1 = sole verifier/leader
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            const honest = eng._answerDigest(st.challengeId, P1, ANSWER);
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P1, sig: 's' });
            // P2 copies P1's public gossip verbatim and re-signs it as its own.
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P2, sig: 's' });
            await eng._closeCollection(288);
            const req = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN_REQ');
            expect(req, 'XNODE_SIGN_REQ broadcast').to.exist;
            expect(req.args[1].passList).to.include(P1);
            expect(req.args[1].passList, 'copier must not pass').to.not.include(P2);
        });

        it('a verifier refuses to sign a PASS list that includes a copier', async function () {
            const hub = makeHub();                        // identity V1 (verifier)
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            const honest = eng._answerDigest(st.challengeId, P1, ANSWER);
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P1, sig: 's' });
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: honest, sig_pubkey: P2, sig: 's' });
            const leader = eng._electedLeader(st);
            await eng._onSignReq({ epoch: 288, challengeId: st.challengeId, sig_pubkey: leader, passList: [P1, P2], sig: 'x' });
            const signed = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN');
            expect(signed, 'must not co-sign a pass list containing a copier').to.not.exist;
        });

        it('_onAnswer rejects a non-64-hex digest', async function () {
            const hub = makeHub();
            const eng = await startEpoch(hub);
            const st  = eng.rounds.get(288);
            eng._onAnswer({ epoch: 288, challengeId: st.challengeId, answer_digest: ANSWER, sig_pubkey: P1, sig: 's' });
            expect(st.answers.has(P1)).to.equal(false);
        });

        it('_answerDigest binds challenge, pubkey, and answer', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const d1 = eng._answerDigest('cid', P1, 'ans');
            expect(d1).to.match(/^[0-9a-f]{64}$/);
            expect(eng._answerDigest('cid', P2, 'ans')).to.not.equal(d1);   // pubkey-bound
            expect(eng._answerDigest('cid2', P1, 'ans')).to.not.equal(d1);  // challenge-bound
            expect(eng._answerDigest('cid', P1, 'ans2')).to.not.equal(d1);  // answer-bound
            expect(eng._answerDigest('cid', P1.toUpperCase(), 'ans')).to.equal(d1); // case-normalized pubkey
        });
    });

    // ── R2-FN3: a verifier must refuse to sign a PASS list that OMITS a claimant
    //    it independently confirmed correct (a censoring leader dropping honest
    //    full nodes) ────────────────────────────────────────────────────────────
    describe('R2-FN3 pass-list completeness', function () {
        function seedRound(eng) {
            const st = {
                epoch: 7, challengeId: 'cidFN3', finalized: false,
                eligible: new Set([V1, V2]),
                claimants: new Set([P1, P2]),
                // Both confirmed correct: pubkey-bound digests of the same answer (R2-FN2).
                answers: new Map([
                    [P1, eng._answerDigest('cidFN3', P1, 'ANS')],
                    [P2, eng._answerDigest('cidFN3', P2, 'ANS')],
                ]),
                myAnswer: 'ANS', target: 188, seed: SEED,
                sigs: new Map(), passList: null, leadRank: 0,
            };
            eng.rounds.set(7, st);
            return st;
        }

        it('refuses to sign a PASS list that omits a claimant it confirmed correct', async function () {
            setGenesisVerifiers([V1, V2]);
            const hub = makeHub({ identity: makeIdentity(V2) });
            const eng = new FullNodeChallengeRound(hub);
            const st  = seedRound(eng);
            const leader = eng._electedLeader(st);
            // Leader's list drops P2 (which this node independently confirmed).
            await eng._onSignReq({ epoch: 7, challengeId: 'cidFN3', sig_pubkey: leader, passList: [P1], sig: 'x' });
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
            await eng._onSignReq({ epoch: 7, challengeId: 'cidFN3', sig_pubkey: leader, passList: [P1, P2], sig: 'x' });
            const signed = hub._pm.broadcast.getCalls().find(c => c.args[0] === 'XNODE_SIGN');
            expect(signed, 'signs when the pass list is complete').to.exist;
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

        // The poll is a plain setInterval, so a tick that outruns pollMs (three
        // sequential indexer calls at a 15s timeout each, against a 30s poll) would
        // otherwise overlap: both runs pass the rounds.has(epoch) test before either
        // reaches rounds.set inside _runEpoch, starting one epoch twice.
        it('a second overlapping tick returns instead of starting the epoch twice', async function () {
            const hub = makeHub();
            hub.capabilitySnapshot.getSnapshot.resolves({ validators: [{ pubkey: V1 }] });
            const eng = new FullNodeChallengeRound(hub);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'TX' });
            wireRpc({ ledgerHash: SEED, tip: 288, verifiers: [], block });

            // A slow indexer: the first tick is still awaiting when the second fires.
            let release;
            const gate = new Promise((res) => { release = res; });
            const realCall = eng._indexerCall.bind(eng);
            let first = true;
            eng._indexerCall = async (m, p) => {
                if (first) { first = false; await gate; }
                return realCall(m, p);
            };
            const runEpoch = sinon.spy(eng, '_runEpoch');

            const a = eng._tick();
            const b = eng._tick();      // fires while a is parked on the gate
            await b;                    // returns immediately, guarded
            expect(runEpoch.callCount, 'the guarded tick did no work').to.equal(0);
            release();
            await a;
            expect(runEpoch.callCount, 'only the first tick ran the epoch').to.equal(1);
            expect(eng._ticking, 'flag released in finally').to.equal(false);
        });

        it('releases the in-flight flag when a tick throws', async function () {
            const hub = makeHub();
            const eng = new FullNodeChallengeRound(hub);
            eng._indexerCall = async () => { throw new Error('indexer down'); };
            try { await eng._tick(); } catch (e) { /* start()'s wrapper swallows this */ }
            expect(eng._ticking, 'a rejected indexer call must not wedge the poll').to.equal(false);
        });
    });

    // ── encoder fallback broadcast ────────────────────────────────────────────
    // The no-hook branch (operator signer exports walletSign but not the optional
    // broadcast) used to call createTx({ source, data }). The encoder has no `source`
    // param and rejects a missing pubkey with RangeError('pubkey is required') before
    // building anything, so that branch could never land a verdict. Pin the shape
    // against the encoder's real contract, the same way PublisherDefaultBroadcast.test.js
    // pins it for the four sibling publishers.
    describe('_broadcastVerdict (encoder fallback)', function () {
        function makeMockEncoder() {
            return {
                createTxArgs: null,
                getUtxos:    sinon.stub().resolves([{ txid: 'a'.repeat(64), vout: 0, value: 1 }]),
                createTx:    function (args) { this.createTxArgs = args; return Promise.resolve({ psbt: 'deadbeef' }); },
                broadcastTx: sinon.stub().resolves({ txid: 'verdict-txid' })
            };
        }

        function wireEncoder(eng, encoder) {
            eng.broadcastFn  = null;
            eng.encoder      = encoder;
            eng.walletSignFn = sinon.stub().resolves('00'.repeat(32));
            eng.btcAddress   = '1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq';
        }

        it('fetches UTXOs and calls createTx with the encoder contract, not { source }', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            wireEncoder(eng, encoder);

            const res = await eng._broadcastVerdict('NODEPROOF|0|cid|288|0|0');

            expect(encoder.getUtxos.calledOnceWith(eng.btcAddress), 'UTXOs fetched first').to.equal(true);
            expect(encoder.createTxArgs).to.be.an('object');
            expect(encoder.createTxArgs.source, 'source is not an encoder param').to.equal(undefined);
            // The encoder's P2SH path runs fromBase58Check on this field, so it carries
            // the address, not a hex pubkey.
            expect(encoder.createTxArgs.pubkey).to.equal(eng.btcAddress);
            expect(encoder.createTxArgs.change).to.equal(eng.btcAddress);
            expect(encoder.createTxArgs.encoding).to.equal('P2SH');
            expect(encoder.createTxArgs.utxos).to.have.lengthOf(1);
            expect(eng.walletSignFn.calledOnceWith('deadbeef'), 'signs the returned .psbt').to.equal(true);
            expect(res.txid).to.equal('verdict-txid');
        });

        it('throws before signing when the encoder returns no psbt', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            // create_tx only ever answers with `psbt`; psbtHex/hex were guesses that
            // could only ever hand the signer undefined.
            encoder.createTx = () => Promise.resolve({ psbtHex: 'deadbeef' });
            wireEncoder(eng, encoder);

            let threw = false;
            try { await eng._broadcastVerdict('NODEPROOF|0|cid|288|0|0'); }
            catch (e) { threw = true; expect(e.message).to.include('no PSBT'); }
            expect(threw).to.equal(true);
            expect(eng.walletSignFn.called, 'never signs an absent PSBT').to.equal(false);
            expect(encoder.broadcastTx.called).to.equal(false);
        });

        it('throws before createTx when the address has no UTXOs', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            encoder.getUtxos = sinon.stub().resolves([]);
            wireEncoder(eng, encoder);

            let threw = false;
            try { await eng._broadcastVerdict('NODEPROOF|0|cid|288|0|0'); }
            catch (e) { threw = true; expect(e.message).to.include('no UTXOs'); }
            expect(threw).to.equal(true);
            expect(encoder.createTxArgs, 'no build attempted').to.equal(null);
        });

        it('the operator broadcast hook still short-circuits the encoder path', async function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const encoder = makeMockEncoder();
            wireEncoder(eng, encoder);
            eng.broadcastFn = sinon.stub().resolves({ txid: 'hook-txid' });

            const res = await eng._broadcastVerdict('NODEPROOF|0|cid|288|0|0');
            expect(res.txid).to.equal('hook-txid');
            expect(encoder.getUtxos.called).to.equal(false);
        });
    });
});
