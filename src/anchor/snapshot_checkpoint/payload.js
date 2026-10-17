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
 * Snapshot checkpoint payload construction.
 *
 ********************************************************************/

'use strict';

const HASH_HEX = /^[0-9a-f]{64}$/i;

function snapshotCheckpointFromBlockHashes(network, bh, blockIndex) {
    try {
        if (typeof network !== 'string' || network.length === 0) return null;
        if (bh === null || typeof bh !== 'object' || Array.isArray(bh)) return null;
        if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
        if (Number(bh.block_index) !== blockIndex) return null;
        if (typeof bh.block_hash !== 'string' || !HASH_HEX.test(bh.block_hash)) return null;
        if (typeof bh.state_root !== 'string' || !HASH_HEX.test(bh.state_root)) return null;
        if (bh.state_root_version === null || bh.state_root_version === undefined) return null;

        const stateRootVersion = Number(bh.state_root_version);
        if (!Number.isSafeInteger(stateRootVersion) || stateRootVersion < 0) return null;

        return {
            chain: 'BTC',
            network,
            block_index: blockIndex,
            block_hash: bh.block_hash.toLowerCase(),
            state_root: bh.state_root.toLowerCase(),
            state_root_version: stateRootVersion,
        };
    } catch (error) {
        return null;
    }
}

module.exports = { snapshotCheckpointFromBlockHashes };
