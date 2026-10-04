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
 **********************************************************************/

'use strict';

function buildHubsRpc({ hub }) {
    return {
        gethubs() {
            const peerManager = hub && typeof hub.getPeerManager === 'function'
                ? hub.getPeerManager() : hub && hub.peerManager;
            const hubs = peerManager && typeof peerManager.getHubAdvertisements === 'function'
                ? peerManager.getHubAdvertisements() : [];
            return { hubs: hubs };
        }
    };
}

module.exports = { buildHubsRpc };
