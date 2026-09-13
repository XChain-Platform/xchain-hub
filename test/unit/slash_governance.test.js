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

// governance-mediated penalty execution over slash_proposals.

const sinon      = require('sinon');
const { expect } = require('chai');
const SlashGovernance = require('../../src/SlashGovernance');
const { parseSlashPenaltyParam, computeEvidenceHash, SLASH_PENALTY_PREFIX } = SlashGovernance;
const { createMockHub } = require('../helpers/mockHub');

const PK   = 'ab'.repeat(32);
const HASH = 'cd'.repeat(32);

function evidenceRow(over = {}) {
    return Object.assign({
        id: 1, validator_pubkey: PK, offense_type: 'price_deviation',
        round_number: 42, evidence: '{"pairs":[]}', created_at: '2026-07-16'
    }, over);
}

describe('SlashGovernance', function () {

    let hub, sg;

    beforeEach(function () {
        hub = createMockHub();
        hub.governance = { propose: sinon.stub().resolves({ proposalId: 'gov:x:1', status: 'voting' }) };
        hub._loadValidatorPubkeys  = sinon.stub().resolves();
        hub._propagateValidatorSet = sinon.stub().resolves([]);
        sg = new SlashGovernance(hub);
    });

    afterEach(function () { sinon.restore(); });

    // -----------------------------------------------------------------
    // parseSlashPenaltyParam()
    // -----------------------------------------------------------------

    describe('parseSlashPenaltyParam()', function () {
        it('parses a well-formed parameter (lowercasing hex)', function () {
            let p = parseSlashPenaltyParam(SLASH_PENALTY_PREFIX + PK.toUpperCase() + ':' + HASH);
            expect(p).to.deep.equal({ validatorPubkey: PK, evidenceHash: HASH });
        });

        it('rejects non-matching prefixes, bad hex, and wrong arity', function () {
            expect(parseSlashPenaltyParam('CAPABILITY_PRICE_MIN_STAKE')).to.equal(null);
            expect(parseSlashPenaltyParam(SLASH_PENALTY_PREFIX + PK)).to.equal(null);
            expect(parseSlashPenaltyParam(SLASH_PENALTY_PREFIX + PK + ':' + HASH + ':extra')).to.equal(null);
            expect(parseSlashPenaltyParam(SLASH_PENALTY_PREFIX + 'zz'.repeat(32) + ':' + HASH)).to.equal(null);
            expect(parseSlashPenaltyParam(SLASH_PENALTY_PREFIX + PK + ':' + 'cd'.repeat(31))).to.equal(null);
            expect(parseSlashPenaltyParam(null)).to.equal(null);
        });
    });

    // -----------------------------------------------------------------
    // computeEvidenceHash()
    // -----------------------------------------------------------------

    describe('computeEvidenceHash()', function () {
        it('is independent of row order and per-hub ids/timestamps', function () {
            let a = evidenceRow({ id: 1, round_number: 1 });
            let b = evidenceRow({ id: 2, round_number: 2, offense_type: 'non_participation', evidence: '{"missedRounds":30}' });
            let h1 = computeEvidenceHash([a, b]);
            let h2 = computeEvidenceHash([
                Object.assign({}, b, { id: 999, created_at: 'whenever' }),
                Object.assign({}, a, { id: 500 })
            ]);
            expect(h1).to.equal(h2);
            expect(h1).to.match(/^[0-9a-f]{64}$/);
        });

        it('changes when evidence content changes', function () {
            let a = evidenceRow();
            let h1 = computeEvidenceHash([a]);
            let h2 = computeEvidenceHash([Object.assign({}, a, { evidence: '{"pairs":["BTC/USD"]}' })]);
            expect(h1).to.not.equal(h2);
        });
    });

    // -----------------------------------------------------------------
    // proposeSlashPenalty()
    // -----------------------------------------------------------------

    describe('proposeSlashPenalty()', function () {
        it('creates a governance proposal keyed by the evidence content hash', async function () {
            let rows = [evidenceRow(), evidenceRow({ id: 2, offense_type: 'non_participation', round_number: 50, evidence: '{"missedRounds":30}' })];
            hub.db.doQuery.resolves(rows);

            let res = await sg.proposeSlashPenalty(PK.toUpperCase(), 'suspend', 'repeated deviation');

            let expectedHash = computeEvidenceHash(rows);
            expect(hub.governance.propose.calledOnce).to.equal(true);
            let [parameter, currentValue, proposedValue, rationale] = hub.governance.propose.firstCall.args;
            expect(parameter).to.equal(SLASH_PENALTY_PREFIX + PK + ':' + expectedHash);
            expect(currentValue).to.equal('pending');
            expect(proposedValue).to.equal('suspend');
            expect(rationale).to.include('2 pending offense row(s)');
            expect(rationale).to.include(expectedHash);
            expect(rationale).to.include('repeated deviation');

            expect(res.evidence_hash).to.equal(expectedHash);
            expect(res.evidence_rows).to.equal(2);
            expect(res.penalty).to.equal('suspend');
        });

        it('rejects an invalid pubkey', async function () {
            try { await sg.proposeSlashPenalty('nothex', 'suspend'); throw new Error('should have thrown'); }
            catch (e) { expect(e.message).to.match(/Invalid validator pubkey/); }
        });

        it('rejects an unknown penalty action', async function () {
            try { await sg.proposeSlashPenalty(PK, 'execute'); throw new Error('should have thrown'); }
            catch (e) { expect(e.message).to.match(/penalty must be one of/); }
        });

        it('rejects when there is no pending evidence', async function () {
            hub.db.doQuery.resolves([]);
            try { await sg.proposeSlashPenalty(PK, 'suspend'); throw new Error('should have thrown'); }
            catch (e) { expect(e.message).to.match(/No pending slash_proposals evidence/); }
        });

        it('rejects when governance is not active', async function () {
            hub.governance = null;
            try { await sg.proposeSlashPenalty(PK, 'suspend'); throw new Error('should have thrown'); }
            catch (e) { expect(e.message).to.match(/Governance not active/); }
        });
    });

    // -----------------------------------------------------------------
    // applyFinalized()
    // -----------------------------------------------------------------

    describe('applyFinalized()', function () {
        function finalizedEvent(penalty, rows) {
            let hash = computeEvidenceHash(rows);
            return {
                proposalId: 'gov:x:1',
                parameter: SLASH_PENALTY_PREFIX + PK + ':' + hash,
                oldValue: 'pending',
                newValue: penalty
            };
        }

        it('ignores non-SLASH_PENALTY parameters', async function () {
            let res = await sg.applyFinalized({ parameter: 'ORACLE_ROUND_INTERVAL', newValue: '600000' });
            expect(res).to.equal(null);
            expect(hub.db.doQuery.called).to.equal(false);
        });

        it('refuses an unknown penalty action', async function () {
            let res = await sg.applyFinalized({ proposalId: 'p', parameter: SLASH_PENALTY_PREFIX + PK + ':' + HASH, newValue: 'nuke' });
            expect(res).to.equal(null);
            expect(hub.db.doQuery.called).to.equal(false);
        });

        it('suspend: approves evidence rows, suspends the validator, and propagates the set', async function () {
            let rows = [evidenceRow()];
            // 1st query: audit re-read of pending rows; 2nd: mark rows; 3rd: suspend validator
            hub.db.doQuery.onCall(0).resolves(rows);
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 1 });
            hub.db.doQuery.onCall(2).resolves({ affectedRows: 1 });

            let res = await sg.applyFinalized(finalizedEvent('suspend', rows));

            expect(res).to.deep.equal({ validatorPubkey: PK, penalty: 'suspend', evidenceRowsUpdated: 1, suspended: true });

            let markCall = hub.db.doQuery.getCall(1);
            expect(markCall.args[0]).to.include("UPDATE slash_proposals SET status = ?");
            expect(markCall.args[0]).to.include("AND id IN (");
            expect(markCall.args[1]).to.deep.equal(['approved', PK, 1]);

            let suspendCall = hub.db.doQuery.getCall(2);
            expect(suspendCall.args[0]).to.include("SET status = 'suspended'");
            expect(suspendCall.args[1]).to.deep.equal([PK]);

            expect(hub._loadValidatorPubkeys.calledOnce).to.equal(true);
            expect(hub._propagateValidatorSet.calledOnce).to.equal(true);
        });

        it('dismiss: rejects evidence rows and leaves the validator active', async function () {
            let rows = [evidenceRow()];
            hub.db.doQuery.onCall(0).resolves(rows);
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 1 });

            let res = await sg.applyFinalized(finalizedEvent('dismiss', rows));

            expect(res).to.deep.equal({ validatorPubkey: PK, penalty: 'dismiss', evidenceRowsUpdated: 1, suspended: false });
            expect(hub.db.doQuery.getCall(1).args[1]).to.deep.equal(['rejected', PK, 1]);
            // No validators UPDATE, no set propagation on dismiss
            expect(hub.db.doQuery.callCount).to.equal(2);
            expect(hub._propagateValidatorSet.called).to.equal(false);
        });

        it('rows added after propose are NOT swept (dismiss only rejects the voted subset)', async function () {
            let votedRows = [evidenceRow(), evidenceRow({ id: 2, round_number: 43 })];
            // A new offense detected mid-vote (higher id) sits alongside them.
            let midVoteRow = evidenceRow({ id: 7, offense_type: 'non_participation', round_number: 90, evidence: '{"missedRounds":31}' });
            hub.db.doQuery.onCall(0).resolves(votedRows.concat([midVoteRow]));
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 2 });
            let warn = sinon.stub(console, 'warn');

            let res = await sg.applyFinalized(finalizedEvent('dismiss', votedRows));

            expect(res.evidenceRowsUpdated).to.equal(2);
            let markCall = hub.db.doQuery.getCall(1);
            // Only the voted rows' ids appear in the UPDATE; id 7 stays pending.
            expect(markCall.args[1]).to.deep.equal(['rejected', PK, 1, 2]);
            expect(warn.getCalls().some(c => String(c.args[0]).includes('detected after proposal'))).to.equal(true);
        });

        it('dismiss fails closed when no local subset matches the voted evidence hash', async function () {
            let votedRows = [evidenceRow()];
            let driftedRows = [evidenceRow({ evidence: '{"different":true}' })];
            hub.db.doQuery.onCall(0).resolves(driftedRows);
            let warn = sinon.stub(console, 'warn');

            let res = await sg.applyFinalized(finalizedEvent('dismiss', votedRows));

            expect(res).to.deep.equal({ validatorPubkey: PK, penalty: 'dismiss', evidenceRowsUpdated: 0, suspended: false });
            // Only the pending-rows SELECT ran; no status UPDATE was issued.
            expect(hub.db.doQuery.callCount).to.equal(1);
            expect(warn.getCalls().some(c => String(c.args[0]).includes('no local pending-evidence subset'))).to.equal(true);
        });

        it('suspend on evidence mismatch still suspends the validator but leaves rows pending', async function () {
            let votedRows = [evidenceRow()];
            let driftedRows = [evidenceRow({ evidence: '{"different":true}' })];
            hub.db.doQuery.onCall(0).resolves(driftedRows);
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 1 }); // validators UPDATE
            let warn = sinon.stub(console, 'warn');

            let res = await sg.applyFinalized(finalizedEvent('suspend', votedRows));

            expect(res).to.deep.equal({ validatorPubkey: PK, penalty: 'suspend', evidenceRowsUpdated: 0, suspended: true });
            // Call 1 is the validators UPDATE, not an evidence sweep.
            expect(hub.db.doQuery.callCount).to.equal(2);
            expect(hub.db.doQuery.getCall(1).args[0]).to.include("SET status = 'suspended'");
            expect(hub._propagateValidatorSet.calledOnce).to.equal(true);
            expect(warn.getCalls().some(c => String(c.args[0]).includes('no local pending-evidence subset'))).to.equal(true);
        });

        it('fails closed (executes nothing) when the pending-evidence read errors', async function () {
            hub.db.doQuery.onCall(0).rejects(new Error('db down'));
            let err = sinon.stub(console, 'error');

            let res = await sg.applyFinalized(finalizedEvent('suspend', [evidenceRow()]));

            expect(res).to.equal(null);
            expect(hub.db.doQuery.callCount).to.equal(1);
            expect(err.getCalls().some(c => String(c.args[0]).includes('refusing to execute'))).to.equal(true);
        });

        it('suspend on an already-suspended validator reports suspended=false', async function () {
            let rows = [evidenceRow()];
            hub.db.doQuery.onCall(0).resolves(rows);
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 0 });
            hub.db.doQuery.onCall(2).resolves({ affectedRows: 0 });

            let res = await sg.applyFinalized(finalizedEvent('suspend', rows));
            expect(res.suspended).to.equal(false);
            expect(res.evidenceRowsUpdated).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // End-to-end through the real Governance engine (leader tally path)
    // -----------------------------------------------------------------

    describe('integration with Governance proposal:finalized', function () {
        it('a passed SLASH_PENALTY proposal executes the penalty via the event', async function () {
            const Governance = require('../../src/Governance');
            const { VALIDATORS_3 } = require('../helpers/fixtures');

            let ghub = createMockHub();
            ghub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
            ghub._loadValidatorPubkeys  = sinon.stub().resolves();
            ghub._propagateValidatorSet = sinon.stub().resolves([]);

            let gov = new Governance(ghub);
            gov.setValidatorSet(VALIDATORS_3);
            ghub.governance = gov;

            let sgov = new SlashGovernance(ghub);
            let applied;
            let appliedPromise = new Promise(resolve => {
                gov.on('proposal:finalized', ev => {
                    sgov.applyFinalized(ev).then(r => { applied = r; resolve(); });
                });
            });

            let rows = [evidenceRow()];
            let hash = computeEvidenceHash(rows);
            let parameter = SLASH_PENALTY_PREFIX + PK + ':' + hash;
            let proposal = {
                proposal_id: 'gov:' + parameter + ':1', parameter,
                current_value: 'pending', proposed_value: 'suspend',
                validator_snapshot: null, activation_block: null
            };
            // _tallyProposal: votes query, UPDATE status; then applyFinalized's
            // audit read, evidence UPDATE, validators UPDATE.
            let votes = VALIDATORS_3.map(v => ({ voter_pubkey: v.pubkey, vote: 'approve', signature: '' }));
            ghub.db.doQuery.onCall(0).resolves(votes);
            ghub.db.doQuery.onCall(1).resolves({ affectedRows: 1 });
            ghub.db.doQuery.onCall(2).resolves(rows);
            ghub.db.doQuery.onCall(3).resolves({ affectedRows: 1 });
            ghub.db.doQuery.onCall(4).resolves({ affectedRows: 1 });

            await gov._tallyProposal(proposal);
            await appliedPromise;

            expect(applied).to.deep.equal({ validatorPubkey: PK, penalty: 'suspend', evidenceRowsUpdated: 1, suspended: true });
        });
    });
});
