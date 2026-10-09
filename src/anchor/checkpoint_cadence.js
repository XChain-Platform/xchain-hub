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
 * different set of checkpoints than its peers. Log-only; the skip env var
 * silences it for deliberate test fleets.
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

/**
 * Number of checkpoint cycles between anchors, honoured only when strictly positive.
 *
 * @param {object} [cfg] the hub's p2pConfig (env wins over it, as everywhere else)
 * @returns {number}
 */
function resolveAnchorCheckpointEveryN(cfg) {
    cfg = cfg || {};
    let raw = hubConfig.ANCHOR_CHECKPOINT_EVERY_N;
    if (raw === undefined || raw === null || raw === '') raw = cfg.ANCHOR_CHECKPOINT_EVERY_N;
    return positiveIntConfig(raw, CANONICAL_ANCHOR_CHECKPOINT_EVERY_N, 'ANCHOR_CHECKPOINT_EVERY_N');
}

/**
 * Resolve both fleet-uniform cadence knobs and report any canonical drift.
 *
 * @param {object} [cfg] the hub's p2pConfig (env wins over it, as everywhere else)
 * @returns {{checkpointIntervalBlocks: number, anchorEveryNCheckpoints: number}}
 */
function resolveCheckpointCadence(cfg) {
    cfg = cfg || {};
    let raw = hubConfig.CHECKPOINT_INTERVAL_BLOCKS;
    if (raw === undefined || raw === null || raw === '') raw = cfg.CHECKPOINT_INTERVAL_BLOCKS;
    const interval = positiveIntConfig(raw, DEFAULT_CHECKPOINT_INTERVAL_BLOCKS, 'CHECKPOINT_INTERVAL_BLOCKS');
    const everyN = resolveAnchorCheckpointEveryN(cfg);
    assertCanonicalCadence(interval, everyN);
    return { checkpointIntervalBlocks: interval, anchorEveryNCheckpoints: everyN };
}

function resolveCheckpointIntervalBlocks(cfg) {
    return resolveCheckpointCadence(cfg).checkpointIntervalBlocks;
}

module.exports = {
    resolveCheckpointCadence, resolveCheckpointIntervalBlocks, resolveAnchorCheckpointEveryN, assertCanonicalCadence,
    DEFAULT_CHECKPOINT_INTERVAL_BLOCKS, CANONICAL_ANCHOR_CHECKPOINT_EVERY_N
};
