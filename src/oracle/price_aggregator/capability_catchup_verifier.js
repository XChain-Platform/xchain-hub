'use strict';

const swq = require('../../consensus/stake_weighted_quorum.js');
const ValidatorIdentity = require('../../validators/identity.js');
const { registerCatchupVerifier } = require('../../peers/hub_db/catchup_verifiers.js');
const { catchupHub } = require('../../peers/hub_db/catchup_context.js');
const { DERIVED_CAPABILITIES } = require('./derived_capabilities.js');

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

function capabilitySnapshotCanonical(identity) {
    return 'XCHAIN_CAPABILITY_SNAPSHOT_V1|' + JSON.stringify([
        identity.block,
        identity.capability,
        identity.pubkey,
        identity.source,
        identity.amount
    ]);
}

async function verifyCapabilitySnapshotRow(row, context) {
    const identity = rowIdentity(row);
    if (!identity) return refusal('malformed capability snapshot row');
    const signature = String(row.signature == null ? '' : row.signature).toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(signature)) return refusal('malformed capability snapshot signature');
    if (!ValidatorIdentity.verify(capabilitySnapshotCanonical(identity), signature, identity.pubkey)) {
        return refusal('capability snapshot signature did not verify');
    }

    const hub = catchupHub(context);
    const snapshots = hub && hub.capabilitySnapshot;
    if (!hub || !snapshots) return refusal('local capability snapshot resolver is unavailable');

    const weighted = swq.isStakeWeightedQuorumActive(identity.block, hub.network);
    const method = weighted ? 'getWeightSnapshot' : 'getSnapshot';
    if (typeof snapshots[method] !== 'function') return refusal('local capability snapshot resolver is unavailable');

    const snapshot = await snapshots[method](identity.capability, identity.block);
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
    rowIdentity,
    matchingSnapshotRow,
    capabilitySnapshotCanonical
};
