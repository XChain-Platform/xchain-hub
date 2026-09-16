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
 * XChain Hub - boot-time refusals.
 *
 * The env checks src/api.js runs at module load, before anything listens: the
 * database secret, the write-method auth posture and the validator-mode
 * network settings. Each one logs and exits the process, so a misconfigured
 * hub never comes up half-armed.
 *
 ********************************************************************/

const { resolveSecretEnv, deprecatedSecretEnvNames } = require('../secret_env');
const { evaluateAuthPosture } = require('./auth_posture.js');   // boot refuses on an undeclared unauthenticated write surface

// Returns the database secret, exiting the process when it cannot be resolved or
// is unset under both of its names.
function requireDbSecret(logger) {
    // The DB password is checked apart from the list above because it accepts two
    // names: HUB_DB_SECRET (preferred) and the deprecated HUB_DB_PASS. See
    // src/secret_env.js for why the name matters.
    let HUB_DB_SECRET;
    try {
        HUB_DB_SECRET = resolveSecretEnv('HUB_DB_PASS');
    } catch (err) {
        logger.error(err.message);
        process.exit(1);
    }
    if(!HUB_DB_SECRET){
        logger.error('Missing required environment variable: HUB_DB_SECRET (deprecated name: HUB_DB_PASS)');
        process.exit(1);
    }
    for(const { legacy, preferred } of deprecatedSecretEnvNames()){
        logger.warn('Deprecated env var name ' + legacy + ': rename it to ' + preferred +
            '. Automatic secret redaction keys on the variable name, and ' + legacy +
            ' is not a name it matches, so anything that reads this env file prints the value in full.');
    }
    return HUB_DB_SECRET;
}

// Write-method auth posture. Keyless, every write method is callable by
// anyone who can reach the port, on a validator AND on a config-oracle hub. The
// decision itself lives in api/auth_posture.js so it is unit-testable; here we
// only log it and refuse the boot. Keyless operation is still available, but it
// must be DECLARED (HUB_ALLOW_UNAUTHENTICATED=true) rather than being what you
// get by forgetting a variable.
function refuseUnsafeAuthPosture({ logger, HUB_API_KEY, HUB_ALLOW_UNAUTHENTICATED, P2P_VALIDATOR_ADDR, SENSITIVE_READ_AUTH }) {
    const bootPosture = evaluateAuthPosture({
        apiKey:               HUB_API_KEY,
        allowUnauthenticated: HUB_ALLOW_UNAUTHENTICATED,
        validatorMode:        !!P2P_VALIDATOR_ADDR,
        sensitiveReadAuth:    SENSITIVE_READ_AUTH
    });
    for(const line of bootPosture.warnings) logger.warn(line);
    if(bootPosture.refuse){
        logger.error(bootPosture.fatal);
        process.exit(1);
    }
}

// Validator mode needs ORACLE_EPOCH_START and HUB_NETWORK; a standalone hub may leave
// HUB_NETWORK unset, but a value it does set must name a real network.
function refuseInvalidNetwork({ logger, hubConfig, P2P_VALIDATOR_ADDR, HUB_NETWORK }) {
    if (P2P_VALIDATOR_ADDR && !hubConfig.ORACLE_EPOCH_START) {
        logger.error('Missing required environment variable: ORACLE_EPOCH_START (Unix ms timestamp anchoring oracle round numbering; all hubs must share the same value)');
        process.exit(1);
    }
    // HUB_NETWORK names the deployment network (mainnet|testnet|regtest) for the hub's
    // consensus gates, notably STAKE_WEIGHTED_QUORUM, whose activation height is per
    // network. Consensus-critical, so it is REQUIRED in validator mode and validated
    // (no silent default: a wrong/blank value would mis-gate the quorum rule). Must
    // match the INDEXER_NETWORK of the chains this hub federates.
    const HUB_NETWORKS = ['mainnet', 'testnet', 'regtest'];
    if (P2P_VALIDATOR_ADDR && !HUB_NETWORKS.includes(HUB_NETWORK)) {
        logger.error('Missing/invalid required environment variable: HUB_NETWORK (must be one of mainnet|testnet|regtest; names the deployment network for consensus activation gating; must match the indexers this hub federates)');
        process.exit(1);
    }
    // A STANDALONE hub (no P2P_VALIDATOR_ADDR) runs no consensus of its own, but its
    // INGEST path is gated by the same network-keyed flag days a validator's is:
    // PriceAggregator.receiveValidatedBatch resolves the EQUIV wrap, the quorum mode,
    // the sig-tally order and the pair-name bound off hub.network. Left '', every one of
    // those failed closed, so a chain-only node pushing on-chain PRICE batches to its own
    // hub had every testnet batch refused (its signatures verify against an unwrapped
    // canonical, and 4-of-7 misses the count quorum the widened rule does not apply).
    // OPTIONAL here, unlike validator mode: unset stays '' so every existing single-host
    // deployment behaves exactly as before. SET must still name a real network, because a
    // typo would mis-gate the same rules that being blank mis-gated.
    if (!P2P_VALIDATOR_ADDR && HUB_NETWORK && !HUB_NETWORKS.includes(HUB_NETWORK)) {
        logger.error('Invalid optional environment variable: HUB_NETWORK (must be one of mainnet|testnet|regtest; names the deployment network for ingest activation gating on a standalone hub; leave it unset for a hub that judges no network-keyed content)');
        process.exit(1);
    }
}

module.exports = { requireDbSecret, refuseUnsafeAuthPosture, refuseInvalidNetwork };
