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
 * ANCHOR publisher fold - archive sub-deadline
 *
 ********************************************************************/

'use strict';

function raceArchiveCosign(cosign, deadlineMs){
    return new Promise(resolve => {
        let settled = false;
        let timer = null;
        let settle = result => {
            if(settled) return;
            settled = true;
            if(timer !== null){ clearTimeout(timer); timer = null; }
            resolve(result);
        };

        Promise.resolve(cosign).then(
            value => settle({ archiveCount: 1, value }),
            error => settle({ archiveCount: 0, reason: 'error', error })
        );

        if(!Number.isFinite(deadlineMs) || deadlineMs <= 0){
            settle({ archiveCount: 0, reason: 'deadline' });
            return;
        }

        timer = setTimeout(() => settle({ archiveCount: 0, reason: 'deadline' }), deadlineMs);
    });
}

module.exports = { raceArchiveCosign };
