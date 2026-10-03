'use strict';

const MIRRORED_TABLES = Object.freeze([
    'price_snapshots',
    'oracle_prices',
    'cross_chain_matches',
    'capability_snapshots',
    'cross_chain_calls',
    'state_checkpoints',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots',
    'anchor_reward_attestations',
    'attestation_responses'
]);

const mirroredTableSet = new Set(MIRRORED_TABLES);
const verifiers = new Map();

function registerCatchupVerifier(table, fn) {
    if (!mirroredTableSet.has(table)) {
        throw new Error('Unknown hub DB catch-up table: ' + table);
    }
    if (typeof fn !== 'function') {
        throw new TypeError('Catch-up verifier for ' + table + ' must be a function');
    }
    if (verifiers.has(table)) {
        throw new Error('Catch-up verifier already registered for ' + table);
    }
    verifiers.set(table, fn);
    return fn;
}

function getCatchupVerifier(table) {
    if (!mirroredTableSet.has(table)) {
        throw new Error('Unknown hub DB catch-up table: ' + table);
    }
    return verifiers.get(table);
}

module.exports = { registerCatchupVerifier, getCatchupVerifier, MIRRORED_TABLES };
