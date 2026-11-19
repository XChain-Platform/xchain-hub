'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

function ensure(owner) {
    if (!owner._pendingProposals) owner._pendingProposals = new Set();
}

function begin(owner) {
    owner.ensureRetractionFence();
    ensure(owner);
    const token = { seq: owner._retractionSeq };
    owner._pendingProposals.add(token);
    return token;
}

function end(owner, token) {
    ensure(owner);
    owner._pendingProposals.delete(token);
    owner.pruneRetractionFence();
}

function floor(owner, current) {
    ensure(owner);
    let value = current;
    for (const token of owner._pendingWrites) if (token.seq < value) value = token.seq;
    for (const token of owner._pendingProposals) if (token.seq < value) value = token.seq;
    return value;
}

function covered(owner, token, row) {
    return owner.retractedSince(token.seq, row);
}

function cancelCoveredPending(owner, consensus, entry, release) {
    if (!consensus || typeof consensus.cancelPendingWhere !== 'function') return [];
    const cancelled = consensus.cancelPendingWhere(row => owner.retractionCovers(entry, row));
    for (const item of cancelled) release(item.roundId, item.row);
    return cancelled;
}

module.exports = { ensure, begin, end, floor, covered, cancelCoveredPending };
