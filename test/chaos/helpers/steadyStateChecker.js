'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai');

/**
 * Steady State Checker
 *
 * Captures baseline metrics from hub components and verifies
 * that the system has returned to a healthy state after fault recovery.
 */

/**
 * Capture baseline metrics from a mock hub and its subsystems.
 *
 * @param {object} opts
 * @param {object} opts.db        - Database instance (real or mock)
 * @param {object} opts.consensus - Consensus instance (optional)
 * @param {object} opts.oracle    - OracleRound instance (optional)
 * @param {object} opts.oracleCon - OracleConsensus instance (optional)
 * @param {object} opts.peerMgr   - PeerManager stub (optional)
 * @returns {object} baseline snapshot
 */
function captureBaseline(opts) {
    let snapshot = { timestamp: Date.now() };

    if (opts.db) {
        snapshot.db = {
            circuitState:    opts.db.circuitState    || 'closed',
            circuitFailures: opts.db.circuitFailures || 0
        };
    }

    if (opts.consensus) {
        snapshot.consensus = {
            seq:               opts.consensus.seq,
            view:              opts.consensus.view,
            pendingCount:      opts.consensus.pendingProposals.size,
            lastAppliedSeq:    opts.consensus.lastAppliedSeq
        };
    }

    if (opts.oracle) {
        snapshot.oracle = {
            currentRound:    opts.oracle.currentRound,
            submissionCount: opts.oracle.submissions.size
        };
    }

    if (opts.oracleCon) {
        snapshot.oracleConsensus = {
            pendingRounds:   opts.oracleCon.pendingRounds.size,
            finalizedCount:  opts.oracleCon.finalized.size
        };
    }

    return snapshot;
}

/**
 * Verify that subsystems have returned to a healthy steady state.
 *
 * @param {object} opts         - Same shape as captureBaseline
 * @param {object} [baseline]   - Optional baseline to compare against
 */
function verifySteadyState(opts, baseline) {
    if (opts.db) {
        expect(opts.db.circuitState).to.equal('closed',
            'Circuit breaker should be closed after recovery');
        expect(opts.db.circuitFailures).to.equal(0,
            'Circuit breaker failure count should be reset');
    }

    if (opts.consensus) {
        expect(opts.consensus.pendingProposals.size).to.equal(0,
            'No pending proposals should remain after recovery');
    }

    if (opts.oracleCon) {
        expect(opts.oracleCon.pendingRounds.size).to.equal(0,
            'No pending oracle rounds should remain after recovery');
    }
}

/**
 * Verify that a DB-like object's circuit breaker is in the expected state.
 */
function expectCircuitState(db, state) {
    expect(db.circuitState).to.equal(state,
        'Expected circuit breaker state: ' + state + ', got: ' + db.circuitState);
}

module.exports = { captureBaseline, verifySteadyState, expectCircuitState };
