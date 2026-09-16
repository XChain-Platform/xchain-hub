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
 * XChain Hub - Attestation Consensus Constants
 *
 * The three PBFT message types of an attestation round, and the sizing of the
 * non-ok publication ring. Shared by the engine and its parts; every other
 * limit lives beside the code that enforces it.
 *
 ********************************************************************/

'use strict';

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';
const ATTEST_PREPARE = 'ATTEST_PREPARE';
const ATTEST_COMMIT  = 'ATTEST_COMMIT';

// Default cap for the nonOkPublished throttle ring. Floor derives
// from the LONGEST provider deadline window (deadline_window_blocks, currently
// 100 BTC blocks for http_get), not the ok/BTC-confirmation horizon that sizes
// `finalizedMax`: non-ok entries must survive until deadline expiry. 40000
// clears 100 blocks even at ~400 non-ok finalizations per block.
const DEFAULT_NONOK_PUBLISHED_MAX = 40000;
// Non-ok finalizations per block the default is sized to absorb, read straight back
// out of the derivation above (40000 entries / 100 blocks). It is the one number the
// sizing floor needs that governance does NOT supply, so naming it lets the floor be
// re-derived against a CHANGED deadline_window_blocks instead of against the 100-block
// figure the comments were written around (item 3421).
const NONOK_THROUGHPUT_PER_BLOCK = DEFAULT_NONOK_PUBLISHED_MAX / 100;

module.exports = {
    ATTEST_PROPOSE:               ATTEST_PROPOSE,
    ATTEST_PREPARE:               ATTEST_PREPARE,
    ATTEST_COMMIT:                ATTEST_COMMIT,
    DEFAULT_NONOK_PUBLISHED_MAX:  DEFAULT_NONOK_PUBLISHED_MAX,
    NONOK_THROUGHPUT_PER_BLOCK:   NONOK_THROUGHPUT_PER_BLOCK
};
