'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const gateRegistry = require('../../consensus/gate_registry.js');

function initialize(engine) {
    engine._roundTimeouts = 0;
    engine._roundExpiries = {};
    engine._roundAborts = {};
    engine._roundAbortsTotal = 0;
    engine._cosignDeclines = {};
    engine._cosignDeclinesTotal = 0;
    engine._leaderSkips = {};
    engine._tickFailures = 0;
    engine._startedAt = null;
    engine._lastTickOkAt = null;
    engine._dueSnapshotBlock = null;
    engine._dueOverdueBlocks = null;
}

function increment(map, reason) {
    map[reason] = Number(map[reason] || 0) + 1;
}

function recordRoundTerminal(engine, state, reason) {
    if (state === 'expired') {
        engine._roundTimeouts += 1;
        increment(engine._roundExpiries, reason);
    } else if (state === 'abort') {
        engine._roundAbortsTotal += 1;
        increment(engine._roundAborts, reason);
    }
}

function recordSkip(engine, reason) {
    if (reason.startsWith('sign_request_')) {
        engine._cosignDeclinesTotal += 1;
        increment(engine._cosignDeclines, reason.slice('sign_request_'.length));
    } else {
        increment(engine._leaderSkips, reason);
    }
}

function recordDue(engine, due, overdue) {
    engine._dueSnapshotBlock = due ? due.snapshot_block : null;
    engine._dueOverdueBlocks = due && Number.isSafeInteger(overdue) ? overdue : null;
}

function age(now, at) {
    return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

function getStats(engine, now = Date.now()) {
    return {
        active: !!(engine.identity && engine.db && engine.pollTimer),
        gate_armed: engine.gateHeight() !== gateRegistry.UNARMED,
        poll_ms: engine.pollMs,
        round_timeouts: engine._roundTimeouts,
        round_expiries: Object.assign({}, engine._roundExpiries),
        round_aborts: Object.assign({}, engine._roundAborts),
        round_aborts_total: engine._roundAbortsTotal,
        cosign_declines: Object.assign({}, engine._cosignDeclines),
        cosign_declines_total: engine._cosignDeclinesTotal,
        leader_skips: Object.assign({}, engine._leaderSkips),
        tick_failures: engine._tickFailures,
        tick_in_progress: engine.ticking,
        last_successful_tick_age_ms: age(now, engine._lastTickOkAt || engine._startedAt),
        due_snapshot_block: engine._dueSnapshotBlock,
        due_overdue_blocks: engine._dueOverdueBlocks,
    };
}

module.exports = { getStats, initialize, recordDue, recordRoundTerminal, recordSkip };
