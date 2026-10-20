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
 * XChain Hub - checkpoint cadence step, resolved once
 *
 * CHECKPOINT_INTERVAL_BLOCKS has two readers: StateCheckpointEngine advances the
 * cadence latch by it, and StateAnchorPublisher divides `checkpoint_seq` by it to
 * derive the anchor-eligibility ordinal. The two must agree exactly, because the
 * ordinal is only "advances by 1 per round" while the divisor IS the engine's step;
 * a divisor the engine is not using selects every checkpoint or none. They used to
 * read the knob separately and disagreed on a malformed or negative value, so both
 * now call this one function.
 *
 * Both knobs are fleet-uniform, so an override is honoured on regtest only; on
 * mainnet, testnet and standalone it is set-but-IGNORED with a warning and the
 * canonical 6 / 1 is used, the same rule as the oracle round cadence.
 *
 ********************************************************************/

'use strict';

const { positiveIntConfig } = require('../lib/config_int.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');

const logger = getLogger();

const DEFAULT_CHECKPOINT_INTERVAL_BLOCKS = 6;
const CANONICAL_ANCHOR_CHECKPOINT_EVERY_N = 1;
const SKIP_ENV = 'XCHAIN_HUB_SKIP_ANCHOR_CADENCE_ASSERT';

const warned = new Set();

/**
 * Report a cadence knob that differs from the fleet-canonical value. Both knobs
 * feed a deterministic fleet-wide predicate, so a hub that diverges anchors a
 * different set of checkpoints than its peers. Only regtest can resolve a
 * drifting value (resolveKnob pins every other network), so this is the regtest
 * drift warning. Log-only; the skip env var silences it for deliberate test fleets.
 *
 * @param {number} intervalBlocks resolved CHECKPOINT_INTERVAL_BLOCKS
 * @param {number} everyN resolved ANCHOR_CHECKPOINT_EVERY_N
 * @returns {string[]} the drifting knob names (empty when canonical or skipped)
 */
function assertCanonicalCadence(intervalBlocks, everyN) {
    const drift = [];
    if (hubConfig.env()[SKIP_ENV] === '1') return drift;
    if (intervalBlocks !== DEFAULT_CHECKPOINT_INTERVAL_BLOCKS) drift.push('CHECKPOINT_INTERVAL_BLOCKS');
    if (everyN !== CANONICAL_ANCHOR_CHECKPOINT_EVERY_N) drift.push('ANCHOR_CHECKPOINT_EVERY_N');
    const key = drift.join(',') + ':' + intervalBlocks + ':' + everyN;
    if (drift.length && !warned.has(key)) {
        warned.add(key);
        logger.warn('config: ' + drift.join(' and ') + ' differ from the fleet-canonical cadence (' +
            DEFAULT_CHECKPOINT_INTERVAL_BLOCKS + ' blocks, every ' + CANONICAL_ANCHOR_CHECKPOINT_EVERY_N +
            '): resolved ' + intervalBlocks + ' / ' + everyN + '. Hubs on different values anchor different ' +
            'checkpoints. Set ' + SKIP_ENV + '=1 to silence this on a deliberate non-default fleet.');
    }
    return drift;
}

// The network that decides whether an override is honoured: the caller's own
// (hub.network), else HUB_NETWORK, lower-cased; '' (standalone) is not regtest.
function cadenceNetwork(network) {
    if (typeof network === 'string' && network !== '') return network.toLowerCase();
    return String(hubConfig.HUB_NETWORK || '').toLowerCase();
}

// Name a set value that would have moved the cadence off regtest (silent when it equals the canonical one).
function warnIgnored(name, raw, honoured, canonical, network) {
    if (raw === undefined || raw === null || raw === '' || honoured === canonical) return;
    const key = 'ignored:' + name + ':' + raw + ':' + network;
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn('WARNING: ' + name + '=' + raw + ' is set but IGNORED on ' + (network || '<unset>') +
        '; using ' + canonical + '. The checkpoint/anchor cadence is fleet-uniform and moves only by a ' +
        'coordinated code change, never by a local override.');
}

/**
 * Resolve one fleet-uniform cadence knob: env first, then the hub's p2pConfig,
 * honoured (when strictly positive) on regtest only. Every other network,
 * standalone included, uses the canonical value and warns once about a set
 * override, the house rule for consensus-adjacent knobs (round_cadence.js).
 *
 * @param {string} name the knob
 * @param {object} cfg the hub's p2pConfig
 * @param {number} canonical the fleet-canonical value
 * @param {string} network the effective network (cadenceNetwork)
 * @returns {number}
 */
function resolveKnob(name, cfg, canonical, network) {
    let raw = hubConfig[name];
    if (raw === undefined || raw === null || raw === '') raw = cfg[name];
    const honoured = positiveIntConfig(raw, canonical, name);
    if (network === 'regtest') return honoured;
    warnIgnored(name, raw, honoured, canonical, network);
    return canonical;
}

/**
 * Number of checkpoint cycles between anchors: an override is honoured only on
 * regtest and only when strictly positive.
 *
 * @param {object} [cfg] the hub's p2pConfig (env wins over it, as everywhere else)
 * @param {string} [network] the caller's network; HUB_NETWORK when omitted
 * @returns {number}
 */
function resolveAnchorCheckpointEveryN(cfg, network) {
    return resolveKnob('ANCHOR_CHECKPOINT_EVERY_N', cfg || {}, CANONICAL_ANCHOR_CHECKPOINT_EVERY_N,
        cadenceNetwork(network));
}

/**
 * Resolve both fleet-uniform cadence knobs and report any canonical drift
 * (reachable on regtest only, the one network that honours an override).
 *
 * @param {object} [cfg] the hub's p2pConfig (env wins over it, as everywhere else)
 * @param {string} [network] the caller's network; HUB_NETWORK when omitted
 * @returns {{checkpointIntervalBlocks: number, anchorEveryNCheckpoints: number}}
 */
function resolveCheckpointCadence(cfg, network) {
    cfg = cfg || {};
    const net = cadenceNetwork(network);
    const interval = resolveKnob('CHECKPOINT_INTERVAL_BLOCKS', cfg, DEFAULT_CHECKPOINT_INTERVAL_BLOCKS, net);
    const everyN = resolveKnob('ANCHOR_CHECKPOINT_EVERY_N', cfg, CANONICAL_ANCHOR_CHECKPOINT_EVERY_N, net);
    assertCanonicalCadence(interval, everyN);
    return { checkpointIntervalBlocks: interval, anchorEveryNCheckpoints: everyN };
}

function resolveCheckpointIntervalBlocks(cfg, network) {
    return resolveCheckpointCadence(cfg, network).checkpointIntervalBlocks;
}

module.exports = {
    resolveCheckpointCadence, resolveCheckpointIntervalBlocks, resolveAnchorCheckpointEveryN, assertCanonicalCadence,
    DEFAULT_CHECKPOINT_INTERVAL_BLOCKS, CANONICAL_ANCHOR_CHECKPOINT_EVERY_N
};
