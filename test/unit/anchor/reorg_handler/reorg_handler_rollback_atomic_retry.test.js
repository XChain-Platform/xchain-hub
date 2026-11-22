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

// ReorgHandler: a decided rollback lands all three writes or none, and a failed
// attempt is retried with the same bound instead of logged and dropped.

const sinon        = require('sinon');
const { expect }   = require('chai');
const ReorgHandler = require('../../../../src/anchor/reorg_handler');
const { createMockHub }  = require('../../../helpers/mockHub');
const { VALIDATORS_4 }   = require('../../../helpers/fixtures');
const { waitUntil }      = require('../../../helpers/waitUntil');

const WRITE_SQL = /^\s*(DELETE FROM attestations|UPDATE price_snapshots|INSERT INTO reorg_attestations)/;

let hub, rh, ledger;

// A transaction double that models commit and rollback: statements on the handed
// connection are staged and reach `committed` only when the body resolves, while a
// statement sent through doQuery autocommits at once.
function installLedger(failOn) {
    ledger = { committed: [], attempts: 0, bounds: [], failOn };
    rh.db.doQuery = sinon.spy(async sql => {
        if (WRITE_SQL.test(sql)) ledger.committed.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        return [];
    });
    rh.db.withTransaction = async work => {
        ledger.attempts++;
        const staged = [];
        const conn = {
            query: async (sql, args) => {
                if (/^\s*DELETE FROM attestations/.test(sql)) ledger.bounds.push(args[1]);
                if (ledger.failOn(sql, ledger.attempts)) throw new Error('lock wait timeout');
                staged.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
                return [];
            }
        };
        const result = await work(conn);
        ledger.committed.push(...staged);
        return result;
    };
}

const failsPriceUpdate = upTo => (sql, attempt) => /UPDATE price_snapshots/.test(sql) && attempt <= upTo;

function events(name) {
    const seen = [];
    rh.on(name, payload => seen.push(payload));
    return seen;
}

function finalizedRound(reorgId) {
    rh.pendingReorgs.set(reorgId, {
        reorgId, chain: 'BTC', reorgHeight: 500, timestamp: Date.now(), observedBlockTimeMs: null,
        selfVerified: true, quorum: 1, snapshotActive: false,
        prepares: new Set(['p']), commits: new Set(['c']), finalized: false, timer: null
    });
    rh.checkCommitQuorum(reorgId);
}

const retryPending = () => waitUntil(() => rh._rollbackRetryWaits.size === 1, { label: 'a scheduled retry' });
const flush = () => new Promise(resolve => setImmediate(resolve));

function registerAtomicCases() {
    it('runs the three rollback writes on one transaction connection and confirms after commit', async function () {
        installLedger(() => false);
        const confirmed = events('reorg:confirmed');
        await rh.executeRollback('BTC', 500, Date.now(), 'BTC:500:1', 3, '[]', null);
        expect(ledger.attempts).to.equal(1);
        expect(ledger.committed).to.deep.equal(['DELETE FROM attestations', 'UPDATE price_snapshots SET',
            'INSERT INTO reorg_attestations']);
        expect(rh.db.doQuery.getCalls().some(call => WRITE_SQL.test(call.args[0]))).to.equal(false);
        expect(rh.processed.has('BTC:500:1')).to.equal(true);
        expect(confirmed).to.have.length(1);
    });

    it('does not retry committed writes when a post-commit listener throws', async function () {
        installLedger(() => false);
        sinon.stub(rh.db, 'findDisputedPriceSnapshotsAfterBlockTimestamp').resolves([{ id: 1 }]);
        rh.on('row:inserted', () => { throw new Error('listener failed'); });
        let caught = null;
        await rh.executeRollback('BTC', 500, Date.now(), 'BTC:500:post', 3, '[]', null)
            .catch(e => { caught = e; });
        expect(caught && caught.message).to.equal('listener failed');
        expect(ledger.attempts).to.equal(1);
        expect(ledger.committed).to.have.length(3);
        expect(rh.processed.has('BTC:500:post')).to.equal(true);
    });

    it('commits nothing and confirms nothing when a later write fails', async function () {
        installLedger(failsPriceUpdate(Infinity));
        rh.rollbackRetryAttempts = 1;
        const confirmed = events('reorg:confirmed');
        const failed = events('reorg:rollback-failed');
        let caught = null;
        await rh.executeRollback('BTC', 500, Date.now(), 'BTC:500:2', 3, '[]', null).catch(e => { caught = e; });
        expect(caught && caught.message).to.equal('lock wait timeout');
        expect(ledger.committed).to.deep.equal([]);
        expect(rh.processed.has('BTC:500:2')).to.equal(false);
        expect(confirmed).to.have.length(0);
        expect(failed).to.have.length(1);
        expect(failed[0].bound).to.equal(ledger.bounds[0]);
    });
}

function registerPostCommitConsensusCase() {
    it('counts a post-commit listener error without retrying the committed writes', async function () {
        installLedger(() => false);
        sinon.stub(rh.db, 'findDisputedPriceSnapshotsAfterBlockTimestamp').resolves([{ id: 1 }]);
        rh.on('row:inserted', () => { throw new Error('listener failed'); });
        const confirmed = events('reorg:confirmed');
        finalizedRound('BTC:500:listener');
        await waitUntil(() => !rh.pendingReorgs.has('BTC:500:listener'), { label: 'the round to settle' });
        expect(ledger.attempts).to.equal(1);
        expect(rh._rollbackFailures).to.equal(1);
        expect(confirmed).to.have.length(0);
    });
}

function registerConsensusRetryCases() {
    it('keeps a finalized round through a failed attempt and confirms on the retry', async function () {
        installLedger(failsPriceUpdate(1));
        const confirmed = events('reorg:confirmed');
        finalizedRound('BTC:500:3');
        await retryPending();
        expect(rh.pendingReorgs.has('BTC:500:3')).to.equal(true);
        await waitUntil(() => !rh.pendingReorgs.has('BTC:500:3'), { label: 'the round to settle' });
        expect(ledger.attempts).to.equal(2);
        expect(confirmed).to.have.length(1);
        expect(rh.pendingReorgs.has('BTC:500:3')).to.equal(false);
        expect(rh._rollbackFailures).to.equal(0);
    });

    it('counts one failure and emits rollback-failed once the budget is spent', async function () {
        installLedger(failsPriceUpdate(Infinity));
        rh.rollbackRetryAttempts = 3;
        const failed = events('reorg:rollback-failed');
        finalizedRound('BTC:500:4');
        await waitUntil(() => !rh.pendingReorgs.has('BTC:500:4'), { label: 'the round to settle' });
        expect(ledger.attempts).to.equal(3);
        expect(rh._rollbackFailures).to.equal(1);
        expect(failed).to.have.length(1);
        expect(failed[0]).to.include({ reorgId: 'BTC:500:4', attempts: 3 });
        expect(rh.pendingReorgs.has('BTC:500:4')).to.equal(false);
    });

    it('retries with the bound the first attempt computed, after the lookback floor moved', async function () {
        installLedger(failsPriceUpdate(2));
        const ancient = Date.now() - rh.maxLookbackMs - 3600000;
        await rh.executeRollback('BTC', 500, ancient, 'BTC:500:5', 3, '[]', ancient);
        expect(ledger.bounds).to.have.length(3);
        expect(new Set(ledger.bounds).size).to.equal(1);
        expect(ledger.bounds[0]).to.be.below(Date.now() - rh.maxLookbackMs);
    });

    it('stop cancels a pending retry without counting a failure', async function () {
        installLedger(failsPriceUpdate(Infinity));
        rh.rollbackRetryBaseMs = 60000;
        const run = sinon.spy(rh, 'executeRollback');
        finalizedRound('BTC:500:6');
        await retryPending();
        await rh.stop();
        const err = await run.firstCall.returnValue.catch(e => e);
        await flush();
        expect(err.rollbackCancelled).to.equal(true);
        expect(ledger.attempts).to.equal(1);
        expect(rh._rollbackRetryWaits.size).to.equal(0);
        expect(rh._rollbackFailures).to.equal(0);
    });
}

function registerSingleNodeCase() {
    it('releases the chain report budget when a single-node rollback cannot land', async function () {
        installLedger(failsPriceUpdate(Infinity));
        rh.rollbackRetryAttempts = 2;
        sinon.stub(rh, 'verifyReorgAgainstOwnNode').resolves(true);
        sinon.stub(rh, 'localReorgSnapshotContext').resolves({ active: false });
        sinon.stub(rh, 'getQuorum').returns(0);
        let caught = null;
        await rh.reportReorg('BTC', 500000, Date.now(), 'a'.repeat(64), 'b'.repeat(64)).catch(e => { caught = e; });
        expect(caught && caught.message).to.equal('lock wait timeout');
        expect(ledger.attempts).to.equal(2);
        expect(rh.reorgRateTracker.has('BTC')).to.equal(false);
    });
}

describe('ReorgHandler atomic rollback with retry', function () {

    beforeEach(function () {
        hub = createMockHub();
        rh  = new ReorgHandler(hub);
        rh.setValidatorSet(VALIDATORS_4);
        hub._peerManager.validatorAddr = VALIDATORS_4[0].addr;
        rh.rollbackRetryBaseMs = 5;
    });

    afterEach(async function () {
        await rh.stop();
        sinon.restore();
    });

    registerAtomicCases();
    registerPostCommitConsensusCase();
    registerConsensusRetryCases();
    registerSingleNodeCase();
});
