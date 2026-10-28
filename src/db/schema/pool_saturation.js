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
 * XChain Hub - tells pool saturation apart from an unreachable database.
 *
 * The driver's queued-acquire timeout means every pooled connection is busy
 * while MariaDB is up: saturation, not the outage the circuit breaker is for.
 * Its other ER_GET_CONNECTION_TIMEOUT ("pool failed to retrieve": no live
 * connection and none creatable) is a real connect failure, so the message
 * tells the two apart.
 *
 ********************************************************************/

'use strict';

function isPoolSaturation(e){
    return !!e && (e.code === 'ER_GET_CONNECTION_TIMEOUT' || e.errno === 45028)
        && String(e.sqlMessage || e.message || '').includes('pool timeout: failed to retrieve');
}

module.exports = { isPoolSaturation };
