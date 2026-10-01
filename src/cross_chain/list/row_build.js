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

const { deriveListSnapshotId } = require('./chain.js');

function listOriginBlockFrom(latest, confirmations) {
    const tip = Number(latest && (latest.block_index != null ?
        latest.block_index : latest.latest_block_index));
    if (!Number.isFinite(tip)) return null;

    const originBlock = tip - Number(confirmations || 1);
    return originBlock > 0 ? originBlock : null;
}

function buildListSnapshotRow({ version, network, homeChain, homeListIndex, snapshotBlock }) {
    if (!version || !Array.isArray(version.added) || !Array.isArray(version.removed)) {
        throw new TypeError('version added and removed must be arrays');
    }

    return {
        snapshot_id: deriveListSnapshotId(
            network,
            homeChain,
            homeListIndex,
            version.seq,
            snapshotBlock
        ),
        snapshot_block: Number(snapshotBlock),
        network,
        home_chain: homeChain,
        home_list_index: Number(homeListIndex),
        list_type: Number(version.list_type),
        seq: Number(version.seq),
        kind: version.kind,
        added: JSON.stringify(version.added),
        removed: JSON.stringify(version.removed),
        members_hash: version.members_hash,
        origin_block: Number(version.origin_block)
    };
}

module.exports = { listOriginBlockFrom, buildListSnapshotRow };
