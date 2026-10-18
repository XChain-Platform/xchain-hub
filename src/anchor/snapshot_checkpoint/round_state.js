/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const { createSnapshotSignTally } = require('./sign_tally.js');
const { FINALIZE_REFUSAL, snapshotFinalizedRefusal } = require('./finalize_policy.js');

const ROUND_STATE = Object.freeze({
    PENDING: 'pending',
    FINALIZE: 'finalize',
    EXPIRED: 'expired',
    ABORT: 'abort',
});

function createSnapshotRound({
    snapshotBlock,
    cp,
    trustSet,
    verify,
    network,
    expectedBlock,
    startedAt,
    timeoutMs,
}) {
    const tally = createSnapshotSignTally(snapshotBlock, cp, trustSet, verify);
    if (!Number.isFinite(startedAt)) throw new TypeError('startedAt must be a finite number');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
        throw new TypeError('timeoutMs must be a nonnegative finite number');

    let terminal = null;

    function add(reply) {
        if (terminal) return 'closed';
        return tally.add(reply);
    }

    function decide(view) {
        if (terminal) return terminal;
        try {
            const msg = {
                snapshot_block: snapshotBlock,
                cp,
                signatures: tally.signatures(),
            };
            const reason = snapshotFinalizedRefusal(msg, {
                network,
                gateActive: view.gateActive,
                expectedBlock,
                trustSet,
                verify,
                stored: view.stored,
            });
            if (reason === null) {
                terminal = { state: ROUND_STATE.FINALIZE, msg };
            } else if (reason !== FINALIZE_REFUSAL.BELOW_QUORUM) {
                terminal = { state: ROUND_STATE.ABORT, reason };
            } else if (view.nowMs >= startedAt + timeoutMs) {
                terminal = { state: ROUND_STATE.EXPIRED, reason };
            } else {
                return { state: ROUND_STATE.PENDING, reason };
            }
        } catch (e) {
            terminal = { state: ROUND_STATE.ABORT, reason: FINALIZE_REFUSAL.MALFORMED };
        }
        return terminal;
    }

    return { add, decide };
}

module.exports = { ROUND_STATE, createSnapshotRound };
