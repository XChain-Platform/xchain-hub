/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * followerAdmissionBound: the CALL SITES of the per-chain follower bound (BF6, C38).
 *
 * admissionHeight.test.js drives checkAdmitBlocks as a function. This file drives the two
 * places a live hub actually reaches it, because a bound with no call site refuses nothing:
 *
 *   1. CrossChainCallEngine.validateProposedMatch, the XCALL engine's own follower gate;
 *   2. CrossChainDexConsensus._handlePropose, the ONE proposal handler every engine on that
 *      consensus shares, for any engine that declares an admissionScope.
 *
 * Both must refuse in the same directions, and both must resolve the FOLLOWER'S OWN tips
 * rather than trusting the map the leader sent. The refusals driven here are the ones BF6
 * names: a map that omits a reading chain, a height past the chain's own forward window, a
 * height at or behind our tip, and no usable own tip at all (a dead indexer, a frozen
 * decoder, or a hub with no resolver) which is a REFUSAL and never a pass.
 *
 * THE SUITE ARMS ITSELF, in the shape priceV0CanonicalAdmission.test.js established: the
 * activation resolves at module load, so the engine half purges the twin, the admission seam
 * and both classes from the require cache, sets the regtest height, re-requires, and restores
 * every entry and the variable afterwards. A default run that only drove the inert tree would
 * report the whole file as vacuous green, since below the activation there is no map to bound.
 ********************************************************************/

'use strict';

const { expect }        = require('chai');
const sinon             = require('sinon');
const crypto            = require('crypto');
const ValidatorIdentity = require('../../src/ValidatorIdentity.js');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// The regtest producer activation this suite arms. Rows below it are legacy rows in the
// same armed process, which is how the "no map, no tip read" case below is driven.
const ADMIT_AT   = 1000;
const ERA_BLOCK  = 2000;
const LEGACY_BLK = 150;

const OWN_BTC  = 900000;
const OWN_DOGE = 5000000;

const CALL_ID = 'c'.repeat(64);

const ARMED_MODULES = [
    '../../src/mirror_admission_activation.js',
    '../../src/lib/admission_height.js',
    '../../src/CrossChainDexConsensus.js',
    '../../src/CrossChainCallEngine.js'
];

// Purge, arm, re-require, and hand back a restore() that puts the process back byte-exact.
// The objects built from the armed modules keep them by closure, so the rest of the run
// still sees the inert tree it was written against.
function armAdmission() {
    const paths    = ARMED_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ADMIT_AT);

    const ah                   = require('../../src/lib/admission_height.js');
    const CrossChainCallEngine = require('../../src/CrossChainCallEngine.js');

    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    return { ah, CrossChainCallEngine, restore };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CrossChainCallEngine.validateProposedMatch
// ─────────────────────────────────────────────────────────────────────────────

describe('follower admission bound: CrossChainCallEngine.validateProposedMatch', function () {

    let armedAh, CallEngine, restore;
    let tipCalls;

    before(function () {
        const armed = armAdmission();
        armedAh    = armed.ah;
        CallEngine = armed.CrossChainCallEngine;
        restore    = armed.restore;
    });
    after(function () { restore(); });
    afterEach(function () { sinon.restore(); });

    // tips: chain code -> the height this hub's own indexer reports, or null for a chain
    // whose tip the hub refuses (no URL, RPC error, absent decoder_block, frozen decoder).
    // Omit `tips` entirely for a hub that has no admission resolver at all.
    function makeEngine(tips) {
        tipCalls = [];
        const hub = {
            db: { async doQuery() { return []; } },
            p2pConfig: { BTC_INDEXER_URL: 'http://btc', DOGE_INDEXER_URL: 'http://doge' },
            capabilitySnapshot: {
                async getSnapshot() { return { validators: [] }; },
                async getWeightSnapshot() { return { validators: [], count: 0, sourceCount: 0 }; }
            },
            getPeerManager: () => null,
            getIdentity: () => null,
            _resolveBtcLatestBlock: async () => ERA_BLOCK
        };
        if (tips !== undefined) {
            hub._resolveAdmissionTips = async (chains) => {
                tipCalls.push(chains.slice());
                let out = {};
                for (const c of chains) out[c] = Object.prototype.hasOwnProperty.call(tips, c) ? tips[c] : null;
                return out;
            };
        }
        const engine = new CallEngine(hub);
        engine.consensus = { propose: async () => {}, start: () => {}, stop: () => {}, on: () => {},
                             forgetFinalized: () => {} };
        // The source-indexer re-derivation the row must also survive: identical fixture to
        // CrossChainCallEngine.test.js's honest dispatch, so a `false` below can only be the
        // admission gate.
        sinon.stub(engine, '_indexerCall').resolves({
            exists: true, network: 'regtest', latest_block_index: ERA_BLOCK + 50,
            call: {
                call_id: CALL_ID, action_index: 41, block_index: 100,
                source_contract_index: 5, target_chain: 'DOGE', target_contract_index: 99,
                method: 'onArrival', params_json: '["x"]', gas_limit: 50000,
                cross_hops: 1, deadline_block: ERA_BLOCK + 2000
            }
        });
        sinon.stub(engine, '_resolveSnapshotBlock').resolves(ERA_BLOCK);
        return engine;
    }

    function dispatchRow(engine, extra) {
        return Object.assign({
            round_id: sha256('XCALLROUND|dispatch|' + CALL_ID),
            call_id: CALL_ID, phase: 'dispatch', snapshot_block: ERA_BLOCK, network: 'regtest',
            source_chain: 'BTC', source_action_index: 41, source_contract_index: 5,
            target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival',
            params_json: '["x"]', gas_limit: 50000, cross_hops: 1,
            effective_time: engine._relayEffectiveTime('DOGE')
        }, extra || {});
    }

    // The map an honest leader on the same tips would stamp, in the row's column form.
    function honestColumns(overrides) {
        const map = armedAh.admitBlocks(['BTC', 'DOGE'], { BTC: OWN_BTC, DOGE: OWN_DOGE }, 'cross_chain_calls');
        return Object.assign(armedAh.admitBlocksToColumns(map), overrides || {});
    }

    it('the era this suite arms is real, so every case below drives the bound', function () {
        expect(armedAh.isAdmissionEra('regtest', ERA_BLOCK)).to.equal(true);
        expect(armedAh.isAdmissionEra('regtest', LEGACY_BLK)).to.equal(false);
    });

    it('SIGNS an honest map stamped on the same tips this follower holds', async function () {
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: OWN_DOGE });
        expect(await engine.validateProposedMatch(dispatchRow(engine, honestColumns()))).to.equal(true);
        // And the tips it bounded against are its OWN, read for the row's read set.
        expect(tipCalls).to.deep.equal([['BTC', 'DOGE']]);
    });

    it('still signs when this follower trails the leader by a block on each chain', async function () {
        // The whole reason the bound is a window rather than an equality: honest hubs poll
        // in different seconds and their decoder tips differ.
        const engine = makeEngine({ BTC: OWN_BTC - 1, DOGE: OWN_DOGE - 1 });
        expect(await engine.validateProposedMatch(dispatchRow(engine, honestColumns()))).to.equal(true);
    });

    it('REFUSES a map that omits a chain in the read set (C38)', async function () {
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: OWN_DOGE });
        const cols = honestColumns({ admit_block_doge: null });
        expect(await engine.validateProposedMatch(dispatchRow(engine, cols))).to.equal(false);
    });

    it('REFUSES a height past the chain\'s own forward window, per chain', async function () {
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: OWN_DOGE });
        // BTC's window is 6 blocks and DOGE's is 60. tip + 7 is outside BTC's; the SAME
        // offset on DOGE is well inside its own, which is what "per chain" means here.
        expect(await engine.validateProposedMatch(
            dispatchRow(engine, honestColumns({ admit_block_btc: OWN_BTC + 7 })))).to.equal(false);
        expect(await engine.validateProposedMatch(
            dispatchRow(engine, honestColumns({ admit_block_doge: OWN_DOGE + 7 })))).to.equal(true);
        expect(await engine.validateProposedMatch(
            dispatchRow(engine, honestColumns({ admit_block_doge: OWN_DOGE + 61 })))).to.equal(false);
    });

    it('REFUSES a height at or behind this follower\'s own tip', async function () {
        // A row admissible at a block that already exists lets a leader backdate it into a
        // block its peers have already committed.
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: OWN_DOGE });
        expect(await engine.validateProposedMatch(
            dispatchRow(engine, honestColumns({ admit_block_btc: OWN_BTC })))).to.equal(false);
        expect(await engine.validateProposedMatch(
            dispatchRow(engine, honestColumns({ admit_block_btc: OWN_BTC - 1 })))).to.equal(false);
        expect(await engine.validateProposedMatch(
            dispatchRow(engine, honestColumns({ admit_block_btc: OWN_BTC + 1 })))).to.equal(true);
    });

    it('REFUSES when this follower has no fresh tip of its own for a reading chain', async function () {
        // The fresh-tip precondition on the FOLLOWER side. _resolveAdmissionTips answers null
        // for a dead indexer, an absent decoder_block or a decoder its stall window dated as
        // frozen, and every one of those is a refusal rather than a zero and never a pass.
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: null });
        expect(await engine.validateProposedMatch(dispatchRow(engine, honestColumns()))).to.equal(false);
    });

    it('an absent own tip is a REFUSAL and never a height of zero', async function () {
        // The sharp form of the same rule, and the one a coercing check passes. Number(null)
        // is 0, a finite non-negative integer, so a follower that dropped the typeof guard
        // would bound a map of {BTC:4, DOGE:4} against a tip of 0, find both inside
        // [1, MAX(c)], and co-sign a row whose admission heights it never checked. The map
        // here is deliberately small enough to fit that fake window.
        const engine = makeEngine({ BTC: null, DOGE: null });
        expect(await engine.validateProposedMatch(
            dispatchRow(engine, { admit_block_btc: 4, admit_block_doge: 4, admit_block_ltc: null })))
            .to.equal(false);
    });

    it('REFUSES when the hub cannot resolve its own tips at all', async function () {
        // No resolver is not "no opinion": a follower with no bound to apply would be
        // signing the proposer's own claim back to it.
        const engine = makeEngine(undefined);
        expect(await engine.validateProposedMatch(dispatchRow(engine, honestColumns()))).to.equal(false);
    });

    it('REFUSES an admission-era row that carries NO map at all', async function () {
        // Above the activation the map is the binding rule, so a legacy-shaped row is not a
        // row bound by effective_time, it is a row bound by nothing.
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: OWN_DOGE });
        expect(await engine.validateProposedMatch(dispatchRow(engine))).to.equal(false);
    });

    it('REFUSES a row whose in-memory map and stored columns disagree', async function () {
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: OWN_DOGE });
        const cols = honestColumns();
        expect(await engine.validateProposedMatch(dispatchRow(engine, Object.assign({}, cols, {
            admit_blocks: { BTC: cols.admit_block_btc + 1, DOGE: cols.admit_block_doge }
        })))).to.equal(false);
    });

    it('a LEGACY-era row is signed on the old rule and reads NO tip', async function () {
        // In the same armed process. The gate must not turn on for rows produced below the
        // activation, or a from-genesis replay refuses every historical row.
        const engine = makeEngine({ BTC: OWN_BTC, DOGE: OWN_DOGE });
        sinon.restore();
        sinon.stub(engine, '_indexerCall').resolves({
            exists: true, network: 'regtest', latest_block_index: LEGACY_BLK + 50,
            call: {
                call_id: CALL_ID, action_index: 41, block_index: 100,
                source_contract_index: 5, target_chain: 'DOGE', target_contract_index: 99,
                method: 'onArrival', params_json: '["x"]', gas_limit: 50000,
                cross_hops: 1, deadline_block: LEGACY_BLK + 2000
            }
        });
        sinon.stub(engine, '_resolveSnapshotBlock').resolves(LEGACY_BLK);
        tipCalls = [];
        expect(await engine.validateProposedMatch(dispatchRow(engine, { snapshot_block: LEGACY_BLK }))).to.equal(true);
        expect(tipCalls).to.deep.equal([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CrossChainDexConsensus._handlePropose, the shared gate
// ─────────────────────────────────────────────────────────────────────────────

describe('follower admission bound: the shared CrossChainDexConsensus PROPOSE gate', function () {

    // No arming here on purpose: the consensus never asks the era gate. It asks the ENGINE
    // for a scope, which is the only thing that can know the row's table and read set, and
    // then bounds whatever map the row carries. Driving it with a stub engine is what proves
    // the gate is generic rather than XCALL-shaped.
    const CrossChainDexConsensus = require('../../src/CrossChainDexConsensus.js');
    const ah                     = require('../../src/lib/admission_height.js');

    const leaderIdent   = new ValidatorIdentity('11'.repeat(32));
    const followerIdent = new ValidatorIdentity('22'.repeat(32));
    const LEADER_PUB    = leaderIdent.getPubkeyHex().toLowerCase();
    const FOLLOWER_PUB  = followerIdent.getPubkeyHex().toLowerCase();

    const VALIDATORS = [
        { pubkey: LEADER_PUB,   source: 'src:leader',   weight: '1', amount: '1' },
        { pubkey: FOLLOWER_PUB, source: 'src:follower', weight: '1', amount: '1' }
    ];

    function canonicalMatch(r) {
        return ['XDEX', r.match_id, String(r.snapshot_block), r.a_chain, r.b_chain,
                String(r.effective_time), r.network || '',
                JSON.stringify(ah.rowAdmitBlocks(r) || null)].join('|');
    }

    // A round id whose leader is the OTHER identity, so _handlePropose runs for real
    // instead of the follower being its own leader.
    function ridLedBy(pub) {
        const sorted = VALIDATORS.map(v => v.pubkey).sort();
        for (let n = 0; n < 512; n++) {
            const rid = sha256('round-' + n).slice(0, 64);
            const mInt = parseInt(rid.slice(0, 8), 16) || 0;
            if (sorted[mInt % sorted.length] === pub) return rid;
        }
        throw new Error('no round id in the search space is led by the requested validator');
    }

    function matchRow(rid, cols) {
        return Object.assign({
            match_id: rid, snapshot_block: ERA_BLOCK, network: 'regtest',
            a_chain: 'BTC', b_chain: 'DOGE', effective_time: 1700000000
        }, cols || {});
    }

    function honestColumns(overrides) {
        const map = ah.admitBlocks(['BTC', 'DOGE'], { BTC: OWN_BTC, DOGE: OWN_DOGE }, 'cross_chain_matches');
        return Object.assign(ah.admitBlocksToColumns(map), overrides || {});
    }

    // opts.tips: own tips, or undefined for a hub with no resolver.
    // opts.scope: false for an engine that declares none; a function to override it.
    function makeFollower(opts) {
        opts = opts || {};
        const engine = {
            hub: { p2pConfig: {} },
            peerManager: { on: () => {}, removeListener: () => {}, broadcast: () => {} },
            identity: followerIdent,
            capSnapshot: null,
            _canonicalMatch: canonicalMatch,
            _persistCapabilitySnapshot: async () => {},
            validateProposedMatch: async () => true
        };
        if (opts.scope !== false) {
            engine.admissionScope = opts.scope || ((row) => ({
                table: 'cross_chain_matches',
                readSet: ah.admissionReadSet('cross_chain_matches', row)
            }));
        }
        if (opts.tips !== undefined) {
            engine.hub._resolveAdmissionTips = async (chains) => {
                let out = {};
                for (const c of chains) out[c] = Object.prototype.hasOwnProperty.call(opts.tips, c) ? opts.tips[c] : null;
                return out;
            };
        }
        return new CrossChainDexConsensus(engine);
    }

    // Seed the round, hand the follower a validly signed leader PROPOSE, and report whether
    // it took the leader's signature (which is what "signed and moved to PREPARE" means).
    async function offerPropose(consensus, row, rid) {
        await consensus.propose(rid, { row, snapshot: { validators: VALIDATORS, count: 2 } });
        const canonical = canonicalMatch(row);
        await consensus._handlePropose({
            type: consensus.types.PROPOSE, sender: LEADER_PUB,
            data: { matchId: rid, view: 0, row, sig_pubkey: LEADER_PUB, sig: leaderIdent.sign(canonical) }
        });
        const pending = consensus.pending.get(rid);
        const took = !!(pending && pending.signatures.has(LEADER_PUB));
        if (pending && pending.timer) clearTimeout(pending.timer);
        await consensus.stop();
        return took;
    }

    it('signs a proposal whose map holds against this follower\'s own tips', async function () {
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({ tips: { BTC: OWN_BTC, DOGE: OWN_DOGE } });
        expect(await offerPropose(c, matchRow(rid, honestColumns()), rid)).to.equal(true);
    });

    it('REFUSES to sign a proposal whose map is outside the bound, even with validation green', async function () {
        // validateProposedMatch is hard-wired true here, so a refusal can only be the
        // admission gate: this is the case that proves the gate is wired into the handler.
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({ tips: { BTC: OWN_BTC, DOGE: OWN_DOGE } });
        expect(await offerPropose(c, matchRow(rid, honestColumns({ admit_block_btc: OWN_BTC + 99 })), rid))
            .to.equal(false);
    });

    it('REFUSES to sign a proposal whose map omits a reading chain', async function () {
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({ tips: { BTC: OWN_BTC, DOGE: OWN_DOGE } });
        expect(await offerPropose(c, matchRow(rid, honestColumns({ admit_block_doge: null })), rid))
            .to.equal(false);
    });

    it('REFUSES to sign when its own tip for a reading chain is missing', async function () {
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({ tips: { BTC: OWN_BTC } });
        expect(await offerPropose(c, matchRow(rid, honestColumns()), rid)).to.equal(false);
    });

    it('REFUSES to sign when the hub has no admission resolver at all', async function () {
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({});
        expect(await offerPropose(c, matchRow(rid, honestColumns()), rid)).to.equal(false);
    });

    it('REFUSES to sign when the engine\'s admission scope throws', async function () {
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({
            tips: { BTC: OWN_BTC, DOGE: OWN_DOGE },
            scope: () => { throw new Error('unusable read set'); }
        });
        expect(await offerPropose(c, matchRow(rid, honestColumns()), rid)).to.equal(false);
    });

    it('leaves an engine that declares NO admission scope on the legacy rule', async function () {
        // The four engines not yet wired must keep signing exactly as before, or this row
        // would stop the DEX, bridge, policy and attest-relay rails on the way in.
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({ scope: false });
        expect(await offerPropose(c, matchRow(rid), rid)).to.equal(true);
    });

    it('a scope of null (a legacy-era row) signs and needs no tips', async function () {
        const rid = ridLedBy(LEADER_PUB);
        const c   = makeFollower({ scope: () => null });
        expect(await offerPropose(c, matchRow(rid), rid)).to.equal(true);
    });
});
