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
    FullNodeChallengeRound = proxyquire('../../../src/consensus/full_node_challenge_round', {
        axios: axiosStub,
        '../validators/identity.js': ValidatorIdentityStub,
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

function installSuiteHooks1() {
    beforeEach(() => { loadModule(); setGenesisVerifiers(V1); });
    afterEach(() => { sinon.restore(); setGenesisVerifiers(null); });
}

const CONSENSUS_ENV = {
            FULLNODE_CHALLENGE_INTERVAL_BLOCKS:    '7',
            FULLNODE_CONFIRM_DEPTH:                '8',
            FULLNODE_VERDICT_ACCEPT_WINDOW_BLOCKS: '9',
            FULLNODE_COLLECT_DEPTH_BLOCKS:         '11',
        };

let saved;

function installSuiteHooks2() {
    beforeEach(() => {
                saved = {};
                for (const k of Object.keys(CONSENSUS_ENV)) { saved[k] = process.env[k]; process.env[k] = CONSENSUS_ENV[k]; }
            });
    afterEach(() => {
                for (const k of Object.keys(CONSENSUS_ENV)) {
                    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
                }
            });
}

function state(eligible, startedAt) {
            return { challengeId: 'cid', eligible: new Set(eligible), startedAt };
        }

const block = { tx: [
            { vout: [{ scriptPubKey: { hex: 's00' } }, { scriptPubKey: { hex: 's01' } }] },
            { vout: [{ scriptPubKey: { hex: 's10' } }] },
            { vout: [{ scriptPubKey: { hex: 's20' } }, { scriptPubKey: { hex: 's21' } }, { scriptPubKey: { hex: 's22' } }] },
        ] };

// ── construction / config ─────────────────────────────────────────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('constructor', function () {
it('reads FULLNODE config + genesis verifiers', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng.interval).to.equal(144);
            expect(eng.confirmDepth).to.equal(100);
            expect(eng.acceptWindow).to.equal(24);
            expect(eng.genesis.has(V1)).to.equal(true);
            expect(eng.coinRpcUrl).to.equal('http://coin');
        });
// An absent p2pConfig.FULLNODE block cannot affect the consensus params:
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
});

// ── Consensus params come from the PINNED registry ─────────────
// These once resolved `process.env.FULLNODE_* || p2pConfig || '<literal>'`,
// env FIRST, on every network. On mainnet that let an operator env var silently
// override a pinned consensus parameter while CONSENSUS_CONFIG_PIN still verified
// clean, because the pin covers the registry and not what this class used. Two
// hubs with different FULLNODE_CONFIRM_DEPTH compute different possession answers
// and different PASS lists, both reporting a matching pin.
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('#3215 pinned-registry resolution', function () {
    installSuiteHooks2();
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
            const coins = require('../../../src/coins/index.js');
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
            const coins = require('../../../src/coins/index.js');
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
});

// ── canonical bytes (CONSENSUS-CRITICAL: must match indexer nodeproof.js) ──
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('canonical / wire', function () {
it('verdictCanonical = challenge|epoch|sorted-pass, EQUIV-wrapped on regtest', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const cid = 'f'.repeat(64);
            const out = eng.verdictCanonical(cid, 288, [P1, P2]);
            // regtest activates EQUIV at genesis → header-wrapped
            expect(out.startsWith('EQUIV|XNODEPROOF|' + cid + '|0||')).to.equal(true);
            expect(out.endsWith(cid + '|288|' + [P1, P2].join(','))).to.equal(true);
        });
// #3859: the PASS order lands in the signed preimage, so it is consensus. A bare
// .sort() orders by UTF-16 code unit, which diverges from UTF-8 byte order above
// the BMP; the indexer VERIFIER (nodeproof.js) is pinned to Buffer.compare, so
// every producing site here must be too or the two sides sign different bytes.
it('buildVerdictWire sorts PASS by BYTE, not UTF-16 code unit', function () {
            const eng    = new FullNodeChallengeRound(makeHub());
            const wide   = '！';      // UTF-8 EF BC 81
            const astral = '\u{1F600}';   // UTF-8 F0 9F 98 80, UTF-16 lead unit D83D
            // The default sort compares D83D < FF01 and would emit the astral one first.
            expect([wide, astral].slice().sort()).to.deep.equal([astral, wide]);
            const wire = eng.buildVerdictWire({
                challengeId: 'cid', epoch: 288, passList: [astral, wide], sigs: new Map(),
            }).split('|');
            expect(wire.slice(5, 7)).to.deep.equal([wide, astral]);
        });
it('answerCanonical binds challenge + answer', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng.answerCanonical('cid', 'deadbeef')).to.equal('XNODEANS|cid|deadbeef');
        });
it('buildVerdictWire emits NODEPROOF|0|cid|epoch|n|pass…|m|pk|sig…', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const state = {
                challengeId: 'cid', epoch: 288,
                passList: [P2, P1],                       // unsorted on input
                sigs: new Map([[V1, 'sigV1'], [V2, 'sigV2']]),
            };
            const wire = eng.buildVerdictWire(state).split('|');
            expect(wire.slice(0, 5)).to.deep.equal(['NODEPROOF', '0', 'cid', '288', '2']);
            expect(wire.slice(5, 7)).to.deep.equal([P1, P2]);          // pass sorted
            expect(wire[7]).to.equal('2');                              // sig count
            expect(wire.slice(8)).to.deep.equal([V1, 'sigV1', V2, 'sigV2']);
        });
});
});

// ── leader election + failover ladder ──────────────────────────────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('isLeader', function () {
it('a non-eligible node is never leader', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            expect(eng.isLeader(state([V1, V2], 0), X)).to.equal(false);
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
            expect(eng.isLeader(st, ranked[0])).to.equal(true);
            expect(eng.isLeader(st, ranked[1])).to.equal(false);
        });
it('promotes the next rank as a chain-based failover (state.leadRank)', function () {
            const eng = new FullNodeChallengeRound(makeHub());
            const ranked = [V1, V2].map(pk => ({ pk, h: crypto.createHash('sha256').update('cid').update(pk).digest('hex') }))
                .sort((a, b) => a.h < b.h ? -1 : 1).map(r => r.pk);
            const st = state([V1, V2], 0);
            st.leadRank = 1;                                      // tick promoted rank 1 (no verdict landed)
            expect(eng.isLeader(st, ranked[1])).to.equal(true);
            expect(eng.isLeader(st, ranked[0])).to.equal(false); // rank-0 stood down
        });
});
// ── deterministic possession answer ───────────────────────────────────────
describe('computeAnswer', function () {
it('selects the seed-derived output scriptPubKey hex', async function () {
            wireRpc({ block });
            const eng = new FullNodeChallengeRound(makeHub());
            const txIdx  = Number(BigInt('0x' + SEED.slice(0, 16)) % BigInt(block.tx.length));
            const vIdx   = Number(BigInt('0x' + SEED.slice(16, 32)) % BigInt(block.tx[txIdx].vout.length));
            const expected = block.tx[txIdx].vout[vIdx].scriptPubKey.hex;
            expect(await eng.computeAnswer(188, SEED)).to.equal(expected);
        });
it('throws without a coin RPC', async function () {
            const hub = makeHub();
            hub.p2pConfig.cross_chain = {}; hub.p2pConfig.FULLNODE.BTC_RPC = '';
            const eng = new FullNodeChallengeRound(hub);
            let threw = false;
            try { await eng.computeAnswer(188, SEED); } catch (e) { threw = true; }
            expect(threw).to.equal(true);
        });
it('throws on an empty target block', async function () {
            wireRpc({ block: { tx: [] } });
            const eng = new FullNodeChallengeRound(makeHub());
            let threw = false;
            try { await eng.computeAnswer(188, SEED); } catch (e) { threw = true; }
            expect(threw).to.equal(true);
        });
});
});

// ── eligible verifiers + claimant set ──────────────────────────────────────
describe('FullNodeChallengeRound', function () {
    installSuiteHooks1();
describe('eligibility', function () {
it('eligibleVerifiers = genesis ∪ indexer-verified', async function () {
            wireRpc({ verifiers: [{ pubkey: V2 }] });
            const eng = new FullNodeChallengeRound(makeHub());      // genesis = [V1]
            const set = await eng.eligibleVerifiers(288);
            expect([...set].sort()).to.deep.equal([V1, V2].sort());
        });
it('ABSTAINS (returns null) rather than degrading to genesis-only when the verifiers RPC is unavailable', async function () {
            // Consensus-critical: a per-hub, reachability-dependent fallback to the
            // genesis-only subset would split leader election and the quorum
            // denominator across honest hubs. Fail CLOSED instead (see eligibleVerifiers).
            axiosStub.post.rejects(new Error('no rpc'));
            const eng = new FullNodeChallengeRound(makeHub());
            const set = await eng.eligibleVerifiers(288);
            expect(set).to.equal(null);
        });
it('ABSTAINS (returns null) on an in-band indexer result.error (200 with error body)', async function () {
            // The indexer reports failures as result.error, not the top-level JSON-RPC
            // error envelope; indexerCall surfaces it so a degraded indexer causes an
            // abstain, not a silently narrowed (genesis-only) verifier set.
            axiosStub.post.callsFake(async () => ({ data: { result: { error: 'indexer unavailable' } } }));
            const eng = new FullNodeChallengeRound(makeHub());
            const set = await eng.eligibleVerifiers(288);
            expect(set).to.equal(null);
        });
it('a genuinely genesis-only federation still resolves (empty indexer list is NOT an error)', async function () {
            // Preserve the legitimate genesis-only path: a successful indexer call that
            // returns no verified full nodes yields the configured genesis set, not an abstain.
            wireRpc({ verifiers: [] });
            const eng = new FullNodeChallengeRound(makeHub());       // genesis = [V1]
            const set = await eng.eligibleVerifiers(288);
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
            const set = await eng.eligibleVerifiers(288);
            expect([...set].sort(), 'the capped set is still consumed').to.deep.equal([V1, V2].sort());
            expect(logged.calledWithMatch('TRUNCATED'), 'no truncation alarm was raised').to.equal(true);
        });
});
});
