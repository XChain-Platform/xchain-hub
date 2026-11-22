'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { getLogger } = require('../../../observability');
const logger = getLogger();

async function prepareFoldArchive(ctx, group, network, snapshotBlock, active) {
    if (!active) return null;
    const section = await ctx.collectFoldArchive(group, network).catch((error) => {
        logger.warn(
            'StateAnchorPublisher: folded archive preparation failed for ' +
                network +
                '; publishing checkpoints without it: ' +
                (error && error.message),
        );
        return null;
    });
    if (section) ctx.armFoldArchiveRound(section, { network, snapshot_block: snapshotBlock });
    return section;
}

async function prepareBundleFoldArchive(ctx, group, network, snapshotBlock, active) {
    if (!active) return prepareFoldArchive(ctx, group, network, snapshotBlock, false);
    let adoption = null;
    try {
        adoption = await ctx.findExistingBundle(group);
    } catch (_error) {
        adoption = null;
    }
    if (adoption && adoption.exists && Number(adoption.version) !== 3) return null;
    return prepareFoldArchive(ctx, group, network, snapshotBlock, true);
}

async function reconcileFoldArchiveAdoption(ctx, archiveSection, result, network) {
    if (!archiveSection || !(result && result.exists) || Number(result.version) === 3) return archiveSection;
    logger.warn('StateAnchorPublisher: adopted a non-v3 bundle; withdrawing the unused folded archive intent');
    await ctx.withdrawArchiveIntent(network, archiveSection.batchSeq);
    return null;
}

module.exports = { prepareBundleFoldArchive, reconcileFoldArchiveAdoption };
