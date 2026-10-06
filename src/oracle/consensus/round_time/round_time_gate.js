'use strict';

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
 ********************************************************************/

const gateRegistry = require('../../../consensus/gate_registry');

const ROUND_TIME_GATE =
    'oracle_round_time_activation.ORACLE_ROUND_TIME_ACTIVATION';

// One reader keeps producer and follower gate inputs identical, and lets this
// module alone join the carrier pin instead of finalization.js and
// handle_propose.js each becoming members.
function roundTimeGateActive({ network, btcHeight }) {
    if (!Number.isSafeInteger(btcHeight) || btcHeight < 0) return false;
    return gateRegistry.activeAt(ROUND_TIME_GATE, network, 'BTC', btcHeight, null);
}

module.exports = { ROUND_TIME_GATE, roundTimeGateActive };
