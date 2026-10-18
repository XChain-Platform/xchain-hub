'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    snapshotCheckpointFromBlockHashes,
} = require('./payload.js');

function blockHeight(value) {
    if(value == null || value === '') return null;
    const height = Number(value);
    return Number.isSafeInteger(height) && height >= 0 ? height : null;
}

function validContext(ctx) {
    return ctx !== null && typeof ctx === 'object' &&
        typeof ctx.network === 'string' && ctx.network.length > 0 &&
        ctx.stateCheckpoints !== null && typeof ctx.stateCheckpoints === 'object' &&
        typeof ctx.stateCheckpoints.indexerCall === 'function' &&
        ctx.db !== null && typeof ctx.db === 'object' &&
        typeof ctx.db.getSnapshotCheckpoint === 'function';
}

async function buildSnapshotCosignView(req, ctx) {
    try {
        if(!validContext(ctx)) return null;

        const view = {
            network: ctx.network,
            gateActive: ctx.gateActive === true,
            expectedBlock: ctx.expectedBlock,
            btcTip: null,
            confirmations: Number(ctx.confirmations),
            local: null,
            stored: null,
        };
        const cp = req && req.cp;
        const blockIndex = cp && cp.block_index;
        if(!Number.isSafeInteger(blockIndex) || blockIndex < 0 ||
            !view.gateActive || blockIndex !== view.expectedBlock) {
            return view;
        }

        try {
            const hub = ctx.stateCheckpoints.hub;
            const tip = hub && typeof hub.resolveBtcLatestBlock === 'function'
                ? await hub.resolveBtcLatestBlock()
                : null;
            view.btcTip = blockHeight(tip);
        } catch(error) {
            return view;
        }
        if(!(view.btcTip >= blockIndex + view.confirmations)) return view;

        try {
            const blockHashes = await ctx.stateCheckpoints.indexerCall(
                'BTC', 'getblockhashes', { block_index: blockIndex }
            );
            view.local = snapshotCheckpointFromBlockHashes(
                view.network, blockHashes, blockIndex
            );
        } catch(error) {
            view.local = null;
        }

        try {
            view.stored = await ctx.db.getSnapshotCheckpoint(
                'BTC', view.network, blockIndex
            );
        } catch(error) {
            return null;
        }
        return view;
    } catch(error) {
        return null;
    }
}

module.exports = { buildSnapshotCosignView };
