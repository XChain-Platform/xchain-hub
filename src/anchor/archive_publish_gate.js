/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Archive publisher electorate gate.
 *
 ********************************************************************/

'use strict';

const consensusRules = require('../consensus_rules_digest.js');
const swq            = require('../consensus/stake_weighted_quorum.js');

const ARCHIVE_ROLLCALL_PRESENCE_KEY =
    'archive_rollcall_presence_activation.ARCHIVE_ROLLCALL_PRESENCE_ACTIVATION';

function isArchivePublishActive(snapshotBlock, network){
    return swq.isStakeWeightedQuorumActive(snapshotBlock, network) &&
        consensusRules.activeGatesAt(snapshotBlock, network, 'BTC').includes(ARCHIVE_ROLLCALL_PRESENCE_KEY);
}

module.exports = {
    ARCHIVE_ROLLCALL_PRESENCE_KEY,
    isArchivePublishActive,
};
