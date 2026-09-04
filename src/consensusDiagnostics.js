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
 *
 * XChain Hub - consensus diagnostics
 *
 * The hub's PBFT paths drop messages with a bare `return`. A dropped PREPARE
 * whose digest does not match, a vote from a sender the registry does not
 * attribute, an early-message buffer evicting under load: each of these is a
 * consensus fault that leaves no line, no counter and no row anywhere, so the
 * hub looks healthy while quietly not participating. Three oracle rounds
 * vanished on four of five validators with no record of it having happened,
 * and a stale image dropped every oracle frame the same silent way.
 *
 * This module is the one place those drops become visible. It is hub-local on
 * purpose: it is not part of the shared observability shim and must not be
 * vendored, because the vocabulary here is PBFT's, not every service's.
 *
 * Emission is through the shim's getLogger() rather than console, because a
 * patched console line cannot carry structured fields, and the fields are the
 * whole point: a reader needs the reason and the phase, not prose.
 *
 ********************************************************************/

'use strict';

const { getLogger, getRegistry } = require('./observability');

// Every reason a consensus message can disappear. Kept closed so a typo becomes
// an unknown-reason line rather than a new metric series nobody is watching.
const DROP_REASONS = new Set([
    'digest_mismatch',    // PREPARE/COMMIT digest disagrees with the pending round
    'round_torn_down',    // message for a round already finalized or abandoned
    'early_ttl',          // buffered pre-round message aged out unread
    'early_capacity',     // buffer full; oldest round or newest message evicted
    'oversized',          // pre-round envelope past the size ceiling
    'unknown_sender'      // admissible signature, but not an attributed validator
]);

// An unknown-sender flood is the one drop an outsider can drive, so it is the
// one that needs a ceiling. The key is the TRANSPORT-verified remote IP, never
// envelope.sender: a sender key is attacker-mintable, so keying on it would let
// one connection rotate the field and mint a fresh entry per message, which
// both defeats the throttle and grows the map without bound. PeerManager stamps
// the IP on the envelope for exactly this.
const DEDUPE_MAX_KEYS = 1000;
const DEDUPE_WINDOW_MS = 60000;

// A Symbol rather than a string key: nothing can address it from parsed JSON,
// so a remote cannot supply it in a gossip message and claim another peer's
// throttle bucket.
const REMOTE_IP = Symbol.for('xchain.transport.remoteIp');

let _counters = null;
let _dedupe = new Map();   // key -> { suppressed, lastLoggedAt }

function counters() {
    if (!_counters) {
        const registry = getRegistry();
        _counters = {
            drops: registry.counter({
                name: 'xchain_pbft_drops_total',
                help: 'Consensus messages dropped, by reason and protocol phase',
                labelNames: ['reason', 'phase']
            }),
            dedupeEvictions: registry.counter({
                name: 'xchain_pbft_drop_dedupe_evictions_total',
                help: 'Unknown-sender dedupe keys evicted because the table was full'
            }),
            crashes: registry.counter({
                name: 'xchain_crashes_total',
                help: 'Uncaught exceptions and unhandled rejections',
                labelNames: ['kind']
            })
        };
    }
    return _counters;
}

// True when this drop should produce a line. The counter always advances, so a
// throttled flood is still measurable even where it is not readable.
function shouldLog(key, now) {
    const seen = _dedupe.get(key);
    if (seen && now - seen.lastLoggedAt < DEDUPE_WINDOW_MS) {
        seen.suppressed += 1;
        // Refresh recency without resetting the window, so a chatty key stays
        // at the young end of the eviction order.
        _dedupe.delete(key);
        _dedupe.set(key, seen);
        return 0;
    }
    const suppressed = seen ? seen.suppressed : 0;
    if (seen) _dedupe.delete(key);
    while (_dedupe.size >= DEDUPE_MAX_KEYS) {
        // Map iteration is insertion-ordered, so the oldest key goes first.
        const oldest = _dedupe.keys().next().value;
        _dedupe.delete(oldest);
        counters().dedupeEvictions.inc({}, 1);
    }
    _dedupe.set(key, { suppressed: 0, lastLoggedAt: now });
    return suppressed + 1;
}

/**
 * Record a dropped consensus message.
 *
 * @param {object} d
 * @param {string} d.reason    one of DROP_REASONS
 * @param {string} d.phase     propose|prepare|commit|submit|buffer|<engine phase>
 * @param {number} [d.round]   round or request id the message addressed
 * @param {string} [d.sender]  claimed sender, for a reader; never a dedupe key
 * @param {object} [d.envelope] source envelope, read for its transport IP only
 */
function noteDrop({ reason, phase, round, sender, envelope, ...extra } = {}) {
    const safeReason = DROP_REASONS.has(reason) ? reason : 'unknown_reason';
    const safePhase = phase || 'unknown';
    try {
        counters().drops.inc({ reason: safeReason, phase: safePhase }, 1);
    } catch { /* a diagnostic must never be the thing that breaks consensus */ }

    // Extras ride as fields but never as metric labels: a label taken from a
    // message would let a peer mint one series per value and blow the registry's
    // cardinality cap.
    const fields = { reason: safeReason, phase: safePhase, ...extra };
    if (round !== undefined && round !== null) fields.round = round;
    if (sender) fields.sender = sender;

    // Only the outsider-drivable reason is throttled. The rest are bugs or
    // genuine faults and are rare enough that every one deserves its line.
    if (safeReason === 'unknown_sender') {
        const ip = remoteIpOf(envelope);
        const runLength = shouldLog(`${safePhase}|${ip}`, Date.now());
        if (runLength === 0) return null;
        fields.peer_ip = ip;
        if (runLength > 1) fields.suppressed = runLength - 1;
    }

    try { return getLogger().warn('PBFT_DROP', fields); }
    catch { return null; }
}

/** Record a peer message rejected at the transport layer. */
function notePeerReject({ peer, reason } = {}) {
    try { return getLogger().warn('PEER_REJECT', { peer: peer || 'unknown', reason: reason || 'unknown' }); }
    catch { return null; }
}

// PeerManager stamps this non-enumerably, so it cannot reach a persisted row, a
// re-broadcast payload or a signature preimage through JSON.stringify.
function remoteIpOf(envelope) {
    if (!envelope) return 'unknown';
    return envelope[REMOTE_IP] || 'unknown';
}

/** Attach the transport-verified remote IP to an envelope leaving the transport. */
function stampRemoteIp(envelope, ip) {
    if (!envelope || typeof envelope !== 'object' || !ip) return envelope;
    Object.defineProperty(envelope, REMOTE_IP, { value: ip, enumerable: false, configurable: true, writable: false });
    return envelope;
}

/**
 * Install process-level crash handlers.
 *
 * No service in the platform has an uncaughtException handler, so a throw
 * outside a promise chain kills the process with node's default stderr dump and
 * nothing structured: no level, no service tag, nothing a collector can key on.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.exitOnUncaught=true]  exit non-zero after logging
 */
function installCrashHandlers({ exitOnUncaught = true, service = 'xchain-hub' } = {}) {
    const emit = (kind, err) => {
        try { counters().crashes.inc({ kind }, 1); } catch { /* never mask the crash */ }
        try {
            getLogger().error('CRASH', {
                kind,
                service,
                err: err && err.message ? err.message : String(err),
                stack: err && err.stack ? err.stack : undefined
            });
        } catch { /* never mask the crash */ }
    };

    process.on('uncaughtException', (err) => {
        emit('uncaughtException', err);
        // Process state after an uncaught throw is undefined, so this exits
        // rather than limping on with half-applied consensus state. The
        // supervisor restarts it; a wrong vote cannot be taken back.
        if (exitOnUncaught) process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        emit('unhandledRejection', reason);
    });
}

/**
 * Record a checkpoint cadence round this hub could not lead.
 *
 * Lives here rather than in the consumers, which was where an earlier reading of
 * the spec put it: the indexer only MIRRORS state_checkpoints from the hub and
 * derives no cadence of its own, the encoder and tracker have no checkpoint
 * concept, and sync's checkpoint module is a client-side verifier that returns a
 * verdict rather than stalling. The hub is the only place a cadence can stall.
 *
 * `chains` is the round's chain list (a round spans all of them) and `block` is the
 * BTC snapshot block it would have used, never a checkpoint seq.
 */
function noteCheckpointStalled({ chains, block, reason, stalls } = {}) {
    try {
        // Render the list as one slash-joined token so the text line stays scannable.
        const list = Array.isArray(chains) ? chains.filter(Boolean).join('/') : (chains ? String(chains) : '');
        const fields = { chains: list || 'unknown', reason: reason || 'unknown' };
        if (block !== undefined && block !== null) fields.block = block;
        if (stalls !== undefined) fields.stalls = stalls;
        return getLogger().warn('CHECKPOINT_STALLED', fields);
    } catch { return null; }
}

/** Record a clean shutdown, so a restart can be told from a crash. */
function noteShutdown(signal) {
    try { return getLogger().warn('SHUTDOWN', { signal: signal || 'unknown' }); }
    catch { return null; }
}

// Tests only: the dedupe table and counter handles are process-wide.
function _resetDiagnostics() {
    _dedupe = new Map();
    _counters = null;
}

module.exports = {
    noteDrop, notePeerReject, noteShutdown, noteCheckpointStalled, installCrashHandlers,
    stampRemoteIp, remoteIpOf, REMOTE_IP,
    DROP_REASONS, DEDUPE_MAX_KEYS, DEDUPE_WINDOW_MS,
    _resetDiagnostics
};
