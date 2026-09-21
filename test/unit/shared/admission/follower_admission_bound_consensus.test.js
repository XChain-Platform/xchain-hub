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
 * followerAdmissionBound: the shared consensus call site of the per-chain follower
 * bound (BF6, C38).
 *
 * admissionHeight.test.js drives checkAdmitBlocks as a function. This file drives
 * CrossChainDexConsensus.handlePropose, the one proposal handler every engine on that
 * consensus shares, for any engine that declares an admissionScope.
 *
 * Both must refuse in the same directions, and both must resolve the FOLLOWER'S OWN tips
 * rather than trusting the map the leader sent. The refusals driven here are the ones BF6
 * names: a map that omits a reading chain, a height past the chain's own forward window, a
 * height at or behind our tip, and no usable own tip at all (a dead indexer, a frozen
 * decoder, or a hub with no resolver) which is a REFUSAL and never a pass.
 ********************************************************************/

'use strict';

const { expect }        = require('chai');
const crypto            = require('crypto');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const ChainTips         = require('../../../../src/hub/chain_tips.js');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

const ERA_BLOCK  = 2000;

const OWN_BTC  = 900000;
const OWN_DOGE = 5000000;

// No arming here on purpose: the consensus never asks the era gate. It asks the ENGINE
// for a scope, which is the only thing that can know the row's table and read set, and
// then bounds whatever map the row carries. Driving it with a stub engine is what proves
// the gate is generic rather than XCALL-shaped.
const CrossChainDexConsensus = require('../../../../src/cross_chain/dex_consensus.js');
const ah                     = require('../../../../src/lib/admission_height.js');

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

    // A round id whose leader is the OTHER identity, so handlePropose runs for real
    // instead of the follower being its own leader.
    function ridLedBy(pub, excluded) {
        const sorted = VALIDATORS.map(v => v.pubkey).sort();
        for (let n = 0; n < 512; n++) {
            const rid = sha256('round-' + n).slice(0, 64);
            const mInt = parseInt(rid.slice(0, 8), 16) || 0;
            if (rid !== excluded && sorted[mInt % sorted.length] === pub) return rid;
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
            canonicalMatch: canonicalMatch,
            persistCapabilitySnapshot: async () => {},
            validateProposedMatch: async () => {
                if(opts.validationReadSet)
                    await engine.hub.resolveAdmissionTips(opts.validationReadSet);
                return true;
            }
        };
        if (opts.scope !== false) {
            engine.admissionScope = opts.scope || ((row) => ({
                table: 'cross_chain_matches',
                readSet: ah.admissionReadSet('cross_chain_matches', row)
            }));
        }
        if (opts.tips !== undefined) {
            engine.hub.resolveAdmissionTip = async (chain) => {
                if(opts.tipReads) opts.tipReads.push(chain);
                return Object.prototype.hasOwnProperty.call(opts.tips, chain) ? opts.tips[chain] : null;
            };
            engine.hub.resolveAdmissionTips = ChainTips.prototype.resolveAdmissionTips;
            engine.hub.withAdmissionTipMemo = ChainTips.prototype.withAdmissionTipMemo;
        }
        return new CrossChainDexConsensus(engine);
    }

    // Seed the round, hand the follower a validly signed leader PROPOSE, and report whether
    // it took the leader's signature (which is what "signed and moved to PREPARE" means).
    async function offerPropose(consensus, row, rid, stop) {
        await consensus.propose(rid, { row, snapshot: { validators: VALIDATORS, count: 2 } });
        const canonical = canonicalMatch(row);
        await consensus.handlePropose({
            type: consensus.types.PROPOSE, sender: LEADER_PUB,
            data: { matchId: rid, view: 0, row, sig_pubkey: LEADER_PUB, sig: leaderIdent.sign(canonical) }
        });
        const pending = consensus.pending.get(rid);
        const took = !!(pending && pending.signatures.has(LEADER_PUB));
        if (pending && pending.timer) clearTimeout(pending.timer);
        if(stop !== false) await consensus.stop();
        return took;
    }

function registerConsensusAdmissionBoundTests() {
    it('reads each chain once inside one proposal and reads both afresh for the next proposal', async function () {
        const reads = [];
        const firstRid = ridLedBy(LEADER_PUB);
        const secondRid = ridLedBy(LEADER_PUB, firstRid);
        const c = makeFollower({
            tips: { BTC: OWN_BTC, DOGE: OWN_DOGE },
            validationReadSet: ['BTC', 'DOGE'],
            tipReads: reads
        });

        expect(await offerPropose(c, matchRow(firstRid, honestColumns()), firstRid, false)).to.equal(true);
        expect(reads).to.deep.equal(['BTC', 'DOGE']);
        expect(await offerPropose(c, matchRow(secondRid, honestColumns()), secondRid)).to.equal(true);
        expect(reads).to.deep.equal(['BTC', 'DOGE', 'BTC', 'DOGE']);
    });

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
}

function registerConsensusAdmissionScopeTests() {
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
}

describe('follower admission bound: the shared CrossChainDexConsensus PROPOSE gate', function () {
    registerConsensusAdmissionBoundTests();
    registerConsensusAdmissionScopeTests();
});
