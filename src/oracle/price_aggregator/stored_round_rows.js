'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

function forceSubscriberResync(aggregator) {
    const broadcaster = aggregator.hub && aggregator.hub.hubDbBroadcaster;
    if (!broadcaster || (broadcaster.subscribers && broadcaster.subscribers.size === 0)) return;
    try {
        if (typeof broadcaster.dropAllForResync === 'function') {
            broadcaster.dropAllForResync('price ingest re-read gap');
        }
    } catch (err) {
        logger.warn(nodeUtil.format('PriceAggregator: could not force subscriber resync:', err));
    }
}

async function storedRoundRows(round, pairs) {
    let heldRows;
    try {
        heldRows = await this.db.findPriceSnapshotsForRound(round);
    } catch (err) {
        logger.error(nodeUtil.format('PriceAggregator: could not re-read stored round ' + round + ':', err));
    }
    if (!Array.isArray(heldRows) || heldRows.length === 0) {
        forceSubscriberResync(this);
        return [];
    }
    const signedPairs = new Set(pairs.map(pair => pair.pair));
    return heldRows.filter(row => row && row.status !== 'skipped' && signedPairs.has(row.coin_pair));
}

module.exports = { storedRoundRows };
