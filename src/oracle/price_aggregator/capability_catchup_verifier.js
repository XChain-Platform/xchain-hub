'use strict';

const swq = require('../../consensus/stake_weighted_quorum.js');
const { registerCatchupVerifier } = require('../../peers/hub_db/catchup_verifiers.js');
const { catchupHub } = require('../../peers/hub_db/catchup_context.js');
const { DERIVED_CAPABILITIES } = require('./derived_capabilities.js');

const MAX_CONSECUTIVE_READ_FAILURES = 3;
const READS_FAILING_REASON = 'catch-up indexer reads failing; table left behind';

const capabilitySet = new Set(DERIVED_CAPABILITIES);

function refusal(reason) {
    return { ok: false, reason };
}

function validBlock(value) {
    const block = Number(value);
    return Number.isSafeInteger(block) && block >= 0 ? block : null;
}

function rowIdentity(row) {
    if (!row || typeof row !== 'object') return null;
    const block = validBlock(row.snapshot_block);
    const capability = String(row.capability == null ? '' : row.capability);
    const pubkey = String(row.signing_pubkey == null ? '' : row.signing_pubkey).toLowerCase();
    if (block === null || !capabilitySet.has(capability) || !/^[0-9a-f]{64}$/.test(pubkey)) return null;
    return {
        block,
        capability,
        pubkey,
        source: String(row.source == null ? '' : row.source),
        amount: String(row.amount == null ? '' : row.amount)
    };
}

function matchingSnapshotRow(validators, identity, weighted) {
    return validators.some((validator) => {
        const pubkey = String(validator && validator.pubkey || '').toLowerCase();
        const source = weighted ? String(validator && validator.source != null ? validator.source : '') : '';
        const amountValue = weighted ? validator && validator.weight : validator && validator.amount;
        const amount = String(amountValue == null ? '' : amountValue);
        return pubkey === identity.pubkey && source === identity.source && amount === identity.amount;
    });
}

// One memo per walk: each snapshot block is read from the indexer at most once, failed
// results included, new reads are spaced apart, and a run of failures ends reads for the walk.
function createIndexerReadMemo(db, intervalMs) {
    const results = new Map();
    let lastReadAt = null;
    let consecutiveFailures = 0;
    const memo = { failedServes: 0 };
    async function fetchFresh(method, capability, block) {
        if (consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
            memo.failedServes += 1;
            throw new Error(READS_FAILING_REASON);
        }
        if (intervalMs > 0 && lastReadAt !== null) {
            const wait = lastReadAt + intervalMs - Date.now();
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        lastReadAt = Date.now();
        let snapshot = null;
        try { snapshot = await catchupHub({ db }).capabilitySnapshot[method](capability, block); }
        catch (e) { snapshot = null; }
        if (!snapshot || !Array.isArray(snapshot.validators)) snapshot = null;
        consecutiveFailures = snapshot ? 0 : consecutiveFailures + 1;
        return snapshot;
    }
    memo.read = async (method, capability, block) => {
        const key = method + ':' + capability + ':' + block;
        if (!results.has(key)) results.set(key, await fetchFresh(method, capability, block));
        const snapshot = results.get(key);
        if (snapshot === null) memo.failedServes += 1;
        return snapshot;
    };
    return memo;
}

async function verifyCapabilitySnapshotRow(row, context) {
    const identity = rowIdentity(row);
    if (!identity) return refusal('malformed capability snapshot row');

    const hub = catchupHub(context);
    const snapshots = hub && hub.capabilitySnapshot;
    if (!hub || !snapshots) return refusal('local capability snapshot resolver is unavailable');

    const weighted = swq.isStakeWeightedQuorumActive(identity.block, hub.network);
    const method = weighted ? 'getWeightSnapshot' : 'getSnapshot';
    if (typeof snapshots[method] !== 'function') return refusal('local capability snapshot resolver is unavailable');

    const snapshot = context && typeof context.readCapabilitySnapshot === 'function'
        ? await context.readCapabilitySnapshot(method, identity.capability, identity.block)
        : await snapshots[method](identity.capability, identity.block);
    if (!snapshot || !Array.isArray(snapshot.validators)) return refusal('local capability snapshot is unresolved');
    if (snapshot.truncated === true) return refusal('local capability snapshot is truncated');
    if (!matchingSnapshotRow(snapshot.validators, identity, weighted)) {
        return refusal('row is absent from the local capability snapshot');
    }
    return { ok: true };
}

registerCatchupVerifier('capability_snapshots', verifyCapabilitySnapshotRow);

module.exports = {
    verifyCapabilitySnapshotRow,
    createIndexerReadMemo,
    READS_FAILING_REASON,
    rowIdentity,
    matchingSnapshotRow
};
