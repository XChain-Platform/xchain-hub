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

const gateRegistry = require('../consensus/gate_registry');
const { pickAdvisoryAgeSeconds } = require('./price_age_bound.js');

const HOURLY_AGE_GATE =
    'oracle_price_age_hourly_activation.ORACLE_PRICE_AGE_HOURLY_ACTIVATION';

function advisoryAgeSecondsAt({ network, coin, tip, legacySeconds, hourlySeconds }) {
    const hourlyActive = Number.isSafeInteger(tip) && tip >= 0 &&
        gateRegistry.activeAt(HOURLY_AGE_GATE, network, coin, tip, null);

    return pickAdvisoryAgeSeconds({ hourlyActive, legacySeconds, hourlySeconds });
}

module.exports = { advisoryAgeSecondsAt };
