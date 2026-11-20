'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { withoutWireId, notMirrored } = require('./catchup_rows.js');
const { groupKey } = require('./price_round_groups.js');

// A producer round's pair rows are not always served together: a pair that was a skipped placeholder keeps its
// earlier id when the round finalizes, so one round can start on one page and finish many pages later. A
// round that fails its check from the rows seen so far is therefore held back until the walk ends. It is
// checked once more after all pages arrive, rather than after every fragment. Only a round still failing
// at the end is counted, logged and remembered. The caps bound round keys, rows and retained wire bytes.
const MAX_POOLED_ROUNDS = 256;
const MAX_POOLED_ROWS_PER_ROUND = 256;
const MAX_POOLED_BYTES_PER_ROUND = 2 * 1024 * 1024;
const MAX_POOLED_BYTES_PER_WALK = 32 * 1024 * 1024;
const MAX_SPLIT_RETRY_ROUNDS = 64;
const MAX_CAPACITY_KEYS_PER_WALK = 65536;
const MAX_SETTLED_SPLIT_ROUNDS = MAX_CAPACITY_KEYS_PER_WALK + MAX_POOLED_ROUNDS + MAX_SPLIT_RETRY_ROUNDS;
// Per-walk cap on individual refusal lines; the walk summary carries the full count, so a restart with an empty memo stays bounded.
const MAX_REFUSAL_LINES_PER_WALK = 10;
const KNOWN_REFUSAL = Object.freeze({ ok: false, reason: 'refused on an earlier walk' });

function verifierAccepted(verdict) {
    return !(verdict === false || verdict === null || (verdict && typeof verdict === 'object' && verdict.ok === false));
}

function refusalReason(verdict) {
    return verdict && typeof verdict === 'object' && verdict.reason ? String(verdict.reason) : 'verifier refused row';
}

// Raw 32-byte digests held as one-byte strings: full sha256 strength at about half the heap of hex.
function retryKey(key) {
    return crypto.createHash('sha256').update(key).digest('latin1');
}

function retryRounds(catchup, table) {
    if (!catchup.splitRetryRounds) catchup.splitRetryRounds = new Map();
    return catchup.splitRetryRounds.get(table) || new Set();
}

function settledRetries(catchup, table) {
    if (!catchup.splitRetrySettled) catchup.splitRetrySettled = new Map();
    if (!catchup.splitRetrySettled.has(table)) catchup.splitRetrySettled.set(table, new Map());
    return catchup.splitRetrySettled.get(table);
}

// Order-independent digest of a round's served rows, folded one row at a time. A turned-away round keeps
// only this fixed-size digest, never its rows, so the tracking stays outside the pool's byte budget.
const FINGERPRINT_MODULUS = 1n << 256n;
const EMPTY_DIGEST = Object.freeze({ count: 0, sum: 0n });
// Columns the serving hub assigns itself. No producer-round check reads them, so the digest leaves them out
// and the same round served by another peer under its own ids folds to the same digest.
const PEER_LOCAL_COLUMNS = new Set(['id', 'created_at']);

function rowContent(row) {
    const columns = Object.keys(row || {}).filter(column => !PEER_LOCAL_COLUMNS.has(column)).sort();
    return JSON.stringify(columns.map(column => [column, row[column]]));
}

function foldRows(digest, rows) {
    let { count, sum } = digest;
    for (const row of rows) {
        const hash = crypto.createHash('sha256').update(rowContent(row)).digest('hex');
        sum = (sum + BigInt('0x' + hash)) % FINGERPRINT_MODULUS;
        count += 1;
    }
    return { count, sum };
}

function rowFingerprint(digest) {
    return crypto.createHash('sha256').update(digest.count + ':' + digest.sum.toString(16)).digest('latin1');
}

// Moves a settled round to the young end, so eviction takes the rounds a walk has stopped turning away.
function touchSettled(settled, digest, fingerprint) {
    const value = fingerprint === undefined ? settled.get(digest) : fingerprint;
    if (value === undefined) return;
    settled.delete(digest);
    settled.set(digest, value);
    while (settled.size > MAX_SETTLED_SPLIT_ROUNDS) settled.delete(settled.keys().next().value);
}

// A round is split when more than one of its fragments, or a pooled join, was turned away in one walk. Whether
// it is queued is decided at walk end, from the digest of every row it was served in that walk.
function noteCapacity(catchup, walk, key, entry, reason, joined) {
    if (!walk.capacityDigests) walk.capacityDigests = new Map();
    const digest = retryKey(key);
    const prior = walk.capacityDigests.get(digest);
    if (prior || walk.capacityDigests.size < MAX_CAPACITY_KEYS_PER_WALK) {
        const folded = foldRows(prior || EMPTY_DIGEST, entry.rows.values());
        folded.split = Boolean(joined || prior);
        walk.capacityDigests.set(digest, folded);
        if (!prior) touchSettled(settledRetries(catchup, walk.table), digest);
    }
    walk.capacityTurnedAway = (walk.capacityTurnedAway || 0) + 1;
    entry.capacityReason = reason;
    if (joined) entry.skipMemo = true;
}

// A joined check that ended in a refusal the same rows would meet again is remembered by content, so the round
// does not take the reserve again. A retryable verdict on a queued round keeps it queued for the next walk.
// The settled set holds every round a walk can track, so refused rounds cannot evict each other and starve
// a later round of the reserve.
function settleSplitRetry(catchup, walk, key, entry, lasting) {
    if (!entry.checkedJoined) return;
    if (!lasting && !notMirrored(entry.verdict)) {
        if (!entry.splitRetry) return;
        if (!walk.retryCarry) walk.retryCarry = new Set();
        walk.retryCarry.add(retryKey(key));
        return;
    }
    const fingerprint = rowFingerprint(foldRows(EMPTY_DIGEST, entry.rows.values()));
    touchSettled(settledRetries(catchup, walk.table), retryKey(key), fingerprint);
}

function queuedSplitRetries(catchup, walk) {
    const queued = new Set(walk.retryCarry || []);
    const settled = settledRetries(catchup, walk.table);
    for (const [digest, folded] of walk.capacityDigests || []) {
        if (queued.size >= MAX_SPLIT_RETRY_ROUNDS) break;
        if (folded.split && settled.get(digest) !== rowFingerprint(folded)) queued.add(digest);
    }
    return queued;
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
    return { rows: new Map(), unheld: new Map(), bytes: 0, verdict: null, dirty: false, verificationRows: null };
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

async function rowsForVerification(catchup, walk, key, entry) {
    const served = entryRows(entry);
    const first = entry.unheld.values().next().value || served[0];
    const local = await catchup.localRoundRows(walk.table, withoutWireId(first));
    const pairs = new Set(served.map(row => row.coin_pair));
    const completed = served.slice();
    for (const row of Array.isArray(local) ? local : []) {
        if (groupKey(row) !== key || pairs.has(row.coin_pair)) continue;
        pairs.add(row.coin_pair);
        completed.push(withoutWireId(row));
    }
    entry.verificationRows = completed;
    return completed;
}

function entryLimitReason(catchup, entry) {
    if (entry.rows.size > catchup.maxPooledRowsPerRound) return 'producer round exceeded catch-up row limit';
    if (entry.bytes > catchup.maxPooledBytesPerRound) return 'producer round exceeded catch-up byte limit';
    return null;
}

function settleRound(catchup, walk, entry) {
    const unheld = Array.from(entry.unheld.values());
    if (unheld.length === 0) return;
    const logged = entry.capacityReason ? { reason: refusalReason(entry.verdict) +
        ' (not joined: ' + entry.capacityReason + ')' } : entry.verdict;
    logRefusal(catchup, walk, unheld[0], logged);
    if (entry.verdict !== KNOWN_REFUSAL && !entry.skipMemo) {
        const identity = walk.peerIdentity || walk.peer;
        const rows = entry.verificationRows || entryRows(entry);
        catchup.refusals.remember(catchup.refusals.keyForGroup(identity, walk.table, rows));
    }
    for (let index = 0; index < unheld.length; index++) countRefusal(walk, entry.verdict);
}

async function storeRound(catchup, walk, unheld, verdict) {
    if (verdict && typeof verdict === 'object' && verdict.ok === true && verdict.row) {
        throw new Error('A producer round verifier cannot replace a multi-pair group with one row');
    }
    await catchup.storeRound(walk.table, unheld.map(withoutWireId));
}

function forgetEntry(walk, key, entry) {
    walk.pool.delete(key);
    walk.poolBytes = Math.max(0, (walk.poolBytes || 0) - entry.bytes);
    if (entry.reserved) walk.reservedPooled = Math.max(0, (walk.reservedPooled || 0) - 1);
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
        if (entry.dirty) entry.verificationRows = null;
        walk.poolBytes += entry.bytes - before;
        const limitReason = entryLimitReason(catchup, entry);
        if (!limitReason && walk.poolBytes <= catchup.maxPooledBytesPerWalk) return;
        if (limitReason) entry.verdict = { ok: false, reason: limitReason };
        else noteCapacity(catchup, walk, key, entry, 'producer round exceeded catch-up walk byte limit', true);
        forgetEntry(walk, key, entry);
        settleRound(catchup, walk, entry);
        return;
    }
    entry = newEntry();
    await addNewRows(catchup, walk, entry, group);
    if (entry.unheld.size === 0) return;
    const rows = await rowsForVerification(catchup, walk, key, entry);
    const verdict = await catchup.verifyWalkRow(walk, entry.unheld.values().next().value, rows, true);
    if (verifierAccepted(verdict)) {
        await storeRound(catchup, walk, Array.from(entry.unheld.values()), verdict);
        return;
    }
    const lasting = verdict === KNOWN_REFUSAL || Boolean(verdict && verdict.deferred === true);
    entry.verdict = verdict;
    const limitReason = entryLimitReason(catchup, entry);
    const walkHasRoom = (walk.poolBytes || 0) + entry.bytes <= catchup.maxPooledBytesPerWalk;
    const reserved = retryRounds(catchup, walk.table).has(retryKey(key));
    const poolHasRoom = walk.pool.size - (walk.reservedPooled || 0) < catchup.maxPooledRounds;
    if (lasting && !limitReason && walkHasRoom && (poolHasRoom || reserved)) {
        entry.splitRetry = reserved;
        entry.reserved = reserved && !poolHasRoom;
        walk.pool.set(key, entry);
        walk.poolBytes = (walk.poolBytes || 0) + entry.bytes;
        if (entry.reserved) walk.reservedPooled = (walk.reservedPooled || 0) + 1;
        return;
    }
    if (limitReason) entry.verdict = { ok: false, reason: limitReason };
    else if (lasting && (!walkHasRoom || !poolHasRoom)) noteCapacity(catchup, walk, key, entry,
        !walkHasRoom ? 'producer round exceeded catch-up walk byte limit' : 'producer round pool is full', false);
    if (lasting) settleRound(catchup, walk, entry);
    else countUnpooled(walk, entry);
}

async function finishEntry(catchup, walk, key, entry) {
    if (entry.dirty) {
        const rows = await rowsForVerification(catchup, walk, key, entry);
        entry.checkedJoined = true;
        entry.verdict = await catchup.verifyWalkRow(
            walk, entry.unheld.values().next().value, rows, true);
        if (verifierAccepted(entry.verdict)) {
            await storeRound(catchup, walk, Array.from(entry.unheld.values()), entry.verdict);
            settledRetries(catchup, walk.table).delete(retryKey(key));
            forgetEntry(walk, key, entry);
            return;
        }
    }
    const lasting = entry.verdict === KNOWN_REFUSAL || Boolean(entry.verdict && entry.verdict.deferred === true);
    settleSplitRetry(catchup, walk, key, entry, lasting);
    forgetEntry(walk, key, entry);
    if (lasting) settleRound(catchup, walk, entry);
    else countUnpooled(walk, entry);
}

async function settlePooledRounds(catchup, walk) {
    for (const [key, entry] of walk.pool ? Array.from(walk.pool.entries()) : []) {
        await finishEntry(catchup, walk, key, entry);
    }
    if (!catchup.splitRetryRounds) catchup.splitRetryRounds = new Map();
    const queued = queuedSplitRetries(catchup, walk);
    catchup.splitRetryRounds.set(walk.table, queued);
    walk.splitRetryQueued = queued.size;
}

module.exports = {
    processRoundGroup, settlePooledRounds, verifierAccepted, refusalReason, countRefusal, logRefusal,
    KNOWN_REFUSAL, MAX_POOLED_ROUNDS, MAX_POOLED_ROWS_PER_ROUND,
    MAX_POOLED_BYTES_PER_ROUND, MAX_POOLED_BYTES_PER_WALK, MAX_SPLIT_RETRY_ROUNDS
};
