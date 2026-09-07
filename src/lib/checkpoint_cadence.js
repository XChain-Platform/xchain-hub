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

const { positiveIntConfig } = require('./config_int.js');

const DEFAULT_CHECKPOINT_INTERVAL_BLOCKS = 6;

/**
 * BTC blocks between checkpoint cycles, honoured only when strictly positive.
 *
 * @param {object} [cfg] the hub's p2pConfig (env wins over it, as everywhere else)
 * @returns {number}
 */
function resolveCheckpointIntervalBlocks(cfg) {
    cfg = cfg || {};
    let raw = process.env.CHECKPOINT_INTERVAL_BLOCKS;
    if (raw === undefined || raw === null || raw === '') raw = cfg.CHECKPOINT_INTERVAL_BLOCKS;
    return positiveIntConfig(raw, DEFAULT_CHECKPOINT_INTERVAL_BLOCKS, 'CHECKPOINT_INTERVAL_BLOCKS');
}

module.exports = { resolveCheckpointIntervalBlocks, DEFAULT_CHECKPOINT_INTERVAL_BLOCKS };
