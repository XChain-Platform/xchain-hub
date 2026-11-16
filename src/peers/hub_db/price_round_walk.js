'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { withoutWireId, verifiedRowOr } = require('./catchup_rows.js');

// A producer round's pair rows are not always served together: a pair that was a skipped placeholder keeps its
// earlier id when the round finalizes, so one round can start on one page and finish many pages later. A
// round that fails its check from the rows seen so far is therefore held back until the walk ends. It is
// checked once more after all pages arrive, rather than after every fragment. Only a round still failing
// at the end is counted, logged and remembered. The caps bound round keys, rows and retained wire bytes.
const MAX_POOLED_ROUNDS = 256;
const MAX_POOLED_ROWS_PER_ROUND = 256;
const MAX_POOLED_BYTES_PER_ROUND = 2 * 1024 * 1024;
const MAX_POOLED_BYTES_PER_WALK = 32 * 1024 * 1024;
// Per-walk cap on individual refusal lines; the walk summary carries the full count, so a restart with an empty memo stays bounded.
const MAX_REFUSAL_LINES_PER_WALK = 10;
const KNOWN_REFUSAL = Object.freeze({ ok: false, reason: 'refused on an earlier walk' });

function verifierAccepted(verdict) {
    return !(verdict === false || verdict === null || (verdict && typeof verdict === 'object' && verdict.ok === false));
}

function refusalReason(verdict) {
    return verdict && typeof verdict === 'object' && verdict.reason ? String(verdict.reason) : 'verifier refused row';
}

function countRefusal(walk, verdict) {
    walk.refused += 1;
    if (verdict === KNOWN_REFUSAL) walk.knownRefused += 1;
}

function logRefusal(catchup, walk, row, verdict) {
    if (walk.refusalLines >= MAX_REFUSAL_LINES_PER_WALK) return;
    walk.refusalLines += 1;
    catchup.logger.warn('Hub DB peer catch-up verifier refused ' + walk.table +
        ' row ' + Number(row.id) + ' from ' + walk.peer + ': ' + refusalReason(verdict));
}

function rowBytes(row) {
    try { return Buffer.byteLength(JSON.stringify(row)); }
    catch (e) { return Number.POSITIVE_INFINITY; }
}

function newEntry() {
    return { rows: new Map(), unheld: new Map(), bytes: 0, verdict: null, dirty: false };
}

async function addNewRows(catchup, walk, entry, group) {
    let added = false;
    for (const row of group) {
        if (entry.rows.has(row.id)) continue;
        entry.rows.set(row.id, row);
        entry.bytes += rowBytes(row);
        if (!(await catchup.hasRow(walk.table, withoutWireId(row)))) entry.unheld.set(row.id, row);
        added = true;
    }
    return added;
}

function entryRows(entry) {
    return Array.from(entry.rows.values());
}

function entryLimitReason(catchup, entry) {
    if (entry.rows.size > catchup.maxPooledRowsPerRound) return 'producer round exceeded catch-up row limit';
    if (entry.bytes > catchup.maxPooledBytesPerRound) return 'producer round exceeded catch-up byte limit';
    return null;
}

function settleRound(catchup, walk, entry) {
    const unheld = Array.from(entry.unheld.values());
    if (unheld.length === 0) return;
    logRefusal(catchup, walk, unheld[0], entry.verdict);
    if (entry.verdict !== KNOWN_REFUSAL) {
        const identity = walk.peerIdentity || walk.peer;
        catchup.refusals.remember(catchup.refusals.keyForGroup(identity, walk.table, entryRows(entry)));
    }
    for (let index = 0; index < unheld.length; index++) countRefusal(walk, entry.verdict);
}

async function storeRound(catchup, walk, unheld, verdict) {
    for (const row of unheld) await catchup.storeRow(walk.table, verifiedRowOr(verdict, withoutWireId(row)));
}

function forgetEntry(walk, key, entry) {
    walk.pool.delete(key);
    walk.poolBytes = Math.max(0, (walk.poolBytes || 0) - entry.bytes);
}

function countUnpooled(walk, entry) {
    for (let index = 0; index < entry.unheld.size; index++) countRefusal(walk, entry.verdict);
}

// One producer round as the walk has seen it so far. Local-held checks run once per id, and a pooled
// failure is not reverified until the end of the walk, so fragments cannot make either cost quadratic.
async function processRoundGroup(catchup, walk, key, group) {
    if (!walk.pool) walk.pool = new Map();
    let entry = walk.pool.get(key);
    if (entry) {
        const before = entry.bytes;
        entry.dirty = (await addNewRows(catchup, walk, entry, group)) || entry.dirty;
        walk.poolBytes += entry.bytes - before;
        const limitReason = entryLimitReason(catchup, entry);
        if (!limitReason && walk.poolBytes <= catchup.maxPooledBytesPerWalk) return;
        entry.verdict = { ok: false, reason: limitReason || 'producer round exceeded catch-up walk byte limit' };
        forgetEntry(walk, key, entry);
        settleRound(catchup, walk, entry);
        return;
    }
    entry = newEntry();
    await addNewRows(catchup, walk, entry, group);
    if (entry.unheld.size === 0) return;
    const rows = entryRows(entry);
    const verdict = await catchup.verifyWalkRow(walk, entry.unheld.values().next().value, rows, true);
    if (verifierAccepted(verdict)) {
        await storeRound(catchup, walk, Array.from(entry.unheld.values()), verdict);
        return;
    }
    const lasting = verdict === KNOWN_REFUSAL || Boolean(verdict && verdict.deferred === true);
    entry.verdict = verdict;
    const limitReason = entryLimitReason(catchup, entry);
    const walkHasRoom = (walk.poolBytes || 0) + entry.bytes <= catchup.maxPooledBytesPerWalk;
    const poolHasRoom = walk.pool.size < catchup.maxPooledRounds;
    if (lasting && !limitReason && walkHasRoom && poolHasRoom) {
        walk.pool.set(key, entry);
        walk.poolBytes = (walk.poolBytes || 0) + entry.bytes;
        return;
    }
    if (limitReason || !walkHasRoom || !poolHasRoom) entry.verdict = { ok: false, reason: limitReason ||
        (!walkHasRoom ? 'producer round exceeded catch-up walk byte limit' : 'producer round pool is full') };
    if (lasting) settleRound(catchup, walk, entry);
    else countUnpooled(walk, entry);
}

async function finishEntry(catchup, walk, key, entry) {
    if (entry.dirty) {
        const rows = entryRows(entry);
        entry.verdict = await catchup.verifyWalkRow(
            walk, entry.unheld.values().next().value, rows, true);
        if (verifierAccepted(entry.verdict)) {
            await storeRound(catchup, walk, Array.from(entry.unheld.values()), entry.verdict);
            forgetEntry(walk, key, entry);
            return;
        }
    }
    forgetEntry(walk, key, entry);
    const lasting = entry.verdict === KNOWN_REFUSAL || Boolean(entry.verdict && entry.verdict.deferred === true);
    if (lasting) settleRound(catchup, walk, entry);
    else countUnpooled(walk, entry);
}

async function settlePooledRounds(catchup, walk) {
    for (const [key, entry] of walk.pool ? Array.from(walk.pool.entries()) : []) {
        await finishEntry(catchup, walk, key, entry);
    }
}

module.exports = {
    processRoundGroup, settlePooledRounds, verifierAccepted, refusalReason, countRefusal, logRefusal,
    KNOWN_REFUSAL, MAX_POOLED_ROUNDS, MAX_POOLED_ROWS_PER_ROUND,
    MAX_POOLED_BYTES_PER_ROUND, MAX_POOLED_BYTES_PER_WALK
};
