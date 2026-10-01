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

function pickAdvisoryAgeSeconds({ hourlyActive, legacySeconds, hourlySeconds }) {
    if (!Number.isSafeInteger(legacySeconds) || legacySeconds <= 0) {
        throw new TypeError('legacySeconds must be a positive safe integer');
    }

    if (hourlyActive === true && Number.isSafeInteger(hourlySeconds) && hourlySeconds > 0) {
        return hourlySeconds;
    }
    return legacySeconds;
}

module.exports = { pickAdvisoryAgeSeconds };
