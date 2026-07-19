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
const { expect }   = require('chai');
const Consensus    = require('../../../src/Consensus');
const { createMockHub }   = require('../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, makeValidator } = require('../../helpers/fixtures');

describe('Boundary: Consensus (PBFT)', function () {

    let hub, pm, consensus;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        consensus = new Consensus(hub);
    });

    afterEach(function () {
        for (let [, prop] of consensus.pendingProposals) {
            if (prop.timer) clearTimeout(prop.timer);
        }
        for (let [, senders] of consensus.pendingViewChanges) {
            // Sets don't need cleanup
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Leader rotation boundaries
    // -----------------------------------------------------------------

    describe('leader rotation wrap-around', function () {

        it('seq=0 → index 0 (first validator)', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.view = 0;
            expect(consensus._getLeader(0)).to.equal(VALIDATORS_3[0]);
        });

        it('seq=N → wraps to index 0', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.view = 0;
            expect(consensus._getLeader(3)).to.equal(VALIDATORS_3[0]);
        });

        it('seq=N-1 → last validator', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.view = 0;
            expect(consensus._getLeader(2)).to.equal(VALIDATORS_3[2]);
        });

        it('view offset shifts leader: (seq+view) % N', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.view = 2;
            // (0+2) % 3 = 2
            expect(consensus._getLeader(0)).to.equal(VALIDATORS_3[2]);
            // (1+2) % 3 = 0
            expect(consensus._getLeader(1)).to.equal(VALIDATORS_3[0]);
        });

        it('large seq value still produces valid leader', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            consensus.view = 0;
            let leader = consensus._getLeader(Number.MAX_SAFE_INTEGER);
            expect(VALIDATORS_4).to.include(leader);
        });

        it('large view value still produces valid leader', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            consensus.view = 999999;
            let leader = consensus._getLeader(1);
            expect(VALIDATORS_4).to.include(leader);
        });

        it('empty validator set → null leader', function () {
            consensus.setValidatorSet([]);
            expect(consensus._getLeader(0)).to.be.null;
        });

        it('single validator is always the leader', function () {
            let single = [makeValidator(1)];
            consensus.setValidatorSet(single);
            consensus.view = 0;
            expect(consensus._getLeader(0)).to.equal(single[0]);
            expect(consensus._getLeader(1)).to.equal(single[0]);
            expect(consensus._getLeader(100)).to.equal(single[0]);
        });
    });

    // -----------------------------------------------------------------
    // Sequence number boundaries
    // -----------------------------------------------------------------

    describe('sequence number handling', function () {

        it('_loadSeq parses integer from DB string', async function () {
            hub.db.doQuery.resolves([{ value: '42' }]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(42);
        });

        it('_loadSeq defaults to 0 on empty result', async function () {
            hub.db.doQuery.resolves([]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(0);
        });

        it('_loadSeq defaults to 0 on non-numeric value', async function () {
            hub.db.doQuery.resolves([{ value: 'not-a-number' }]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(0);
        });

        it('_loadSeq handles very large sequence number', async function () {
            hub.db.doQuery.resolves([{ value: '9007199254740991' }]); // MAX_SAFE_INTEGER
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(Number.MAX_SAFE_INTEGER);
        });

        it('_loadSeq rethrows a DB read fault (fail closed, #2244)', async function () {
            // A swallowed read fault used to reset seq to 0, silently reopening
            // the stale-seq replay guard; _loadSeq now fails closed like its
            // sibling _saveSeq.
            hub.db.doQuery.rejects(new Error('DB down'));
            let threw = null;
            try { await consensus._loadSeq(); } catch (e) { threw = e; }
            expect(threw, 'a DB read fault must propagate out of _loadSeq').to.not.equal(null);
            expect(threw.message).to.equal('DB down');
        });

        it('_saveSeq converts number to string', async function () {
            await consensus._saveSeq(100);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1]).to.include('100');
        });
    });

    // -----------------------------------------------------------------
    // PRE_PREPARE validation boundaries
    // -----------------------------------------------------------------

    describe('PRE_PREPARE validation', function () {

        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('rejects seq=0', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 0, configDigest: 'abc', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('rejects negative seq', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: -1, configDigest: 'abc', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('rejects non-number seq', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 'abc', configDigest: 'abc', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('rejects null config', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 1, configDigest: 'abc', config: null }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('rejects mismatched digest', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 1, view 0)
                data: { seq: 1, view: 0, configDigest: 'wrong', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('accepts valid PRE_PREPARE with correct digest', async function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                data: { seq: 5, view: 0, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.true;
            let p = consensus.pendingProposals.get(5);
            if (p.timer) clearTimeout(p.timer);
        });
    });

    // -----------------------------------------------------------------
    // Duplicate vote handling
    // -----------------------------------------------------------------

    describe('duplicate votes', function () {

        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('duplicate PREPARE from same sender counted once (Set dedup)', function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);

            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set(), commits: new Set(),
                resolved: false, applied: false, timer: null,
                resolve: null, reject: null
            });

            consensus._handlePrepare({ sender: VALIDATORS_4[1].addr, data: { seq: 5, configDigest: digest } });
            consensus._handlePrepare({ sender: VALIDATORS_4[1].addr, data: { seq: 5, configDigest: digest } });
            consensus._handlePrepare({ sender: VALIDATORS_4[1].addr, data: { seq: 5, configDigest: digest } });

            expect(consensus.pendingProposals.get(5).prepares.size).to.equal(1);
        });

        it('duplicate COMMIT from same sender counted once', function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);

            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set(VALIDATORS_4.map(v => v.addr)),
                commits: new Set(),
                resolved: false, applied: false, timer: null, _commitSent: true,
                resolve: null, reject: null
            });

            consensus._handleCommit({ sender: VALIDATORS_4[1].addr, data: { seq: 5, configDigest: digest } });
            consensus._handleCommit({ sender: VALIDATORS_4[1].addr, data: { seq: 5, configDigest: digest } });

            expect(consensus.pendingProposals.get(5).commits.size).to.equal(1);
        });
    });

    // -----------------------------------------------------------------
    // View change boundaries
    // -----------------------------------------------------------------

    describe('view change boundaries', function () {

        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('rapid view increments produce valid leaders', function () {
            for (let i = 0; i < 20; i++) {
                consensus._initiateViewChange(1);
            }
            expect(consensus.view).to.equal(20);
            let leader = consensus._getLeader(1);
            // (1 + 20) % 4 = 1
            expect(leader).to.equal(VALIDATORS_4[1]);
        });

        it('VIEW_CHANGE below quorum does not advance view', function () {
            // N=4, quorum=3. Send only 2 VIEW_CHANGE votes
            consensus._handleViewChange({ sender: VALIDATORS_4[1].addr, data: { view: 1, seq: 5 } });
            consensus._handleViewChange({ sender: VALIDATORS_4[2].addr, data: { view: 1, seq: 5 } });
            // Need 3 votes, only have 2 → view unchanged
            expect(consensus.view).to.equal(0);
        });

        it('VIEW_CHANGE at quorum advances view', function () {
            consensus._handleViewChange({ sender: VALIDATORS_4[1].addr, data: { view: 1, seq: 5 } });
            consensus._handleViewChange({ sender: VALIDATORS_4[2].addr, data: { view: 1, seq: 5 } });
            consensus._handleViewChange({ sender: VALIDATORS_4[3].addr, data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(1);
        });

        it('NEW_VIEW with non-number view is ignored', function () {
            consensus.view = 0;
            consensus._handleNewView({ sender: VALIDATORS_4[1].addr, data: { view: 'abc' } });
            expect(consensus.view).to.equal(0);
        });

        it('VIEW_CHANGE with non-number fields is ignored', function () {
            consensus._handleViewChange({ sender: VALIDATORS_4[1].addr, data: { view: 'abc', seq: 'def' } });
            expect(consensus.pendingViewChanges.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Applied dedup is by per-proposal state, never by config digest
    // -----------------------------------------------------------------

    describe('applied dedup', function () {

        it('dedup is keyed on proposal.applied, not the config digest (a repeated digest at a new round still applies)', async function () {
            // A prior digest-keyed dedup set was removed (stress-sweep #4/#5): it
            // was never read, and a legitimate A -> B -> A config revert reproduces
            // an earlier round's digest at a new seq, so a digest-keyed skip would
            // have wrongly dropped the honest revert. This proves the surviving
            // guard is per-proposal (proposal.applied), so re-seeing a digest does
            // not suppress a genuine new round.
            let config = { x: 1 };
            let digest = consensus._digest(config);

            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set(VALIDATORS_4.map(v => v.addr)),
                commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, _commitSent: true,
                resolve: () => {}, reject: () => {}
            });

            // Third commit reaches quorum
            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, data: { seq: 5, configDigest: digest } });
            await new Promise(r => setTimeout(r, 20));

            // Applied once and the round cleared (no digest set involved).
            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Single-node fallback
    // -----------------------------------------------------------------

    describe('single-node fallback', function () {

        it('propose with N=1 applies directly', async function () {
            consensus.setValidatorSet([makeValidator(1)]);
            pm.getPeerStatus.returns([]);

            let result = await consensus.propose({ test: true });
            expect(result).to.be.true;
            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(pm.broadcast.called).to.be.false;
        });

        it('propose with 0 validators and 0 peers applies directly', async function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await consensus.propose({ test: true });
            expect(result).to.be.true;
            expect(hub.applyConfig.calledOnce).to.be.true;
        });
    });
});
