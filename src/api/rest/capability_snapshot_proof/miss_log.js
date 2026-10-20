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

// One diagnostic line when a capability snapshot proof is asked for a snapshot the hub
// never checkpointed. A mirror retries a held row every 15 s, so the line is limited to
// one per snapshot block per minute. It names the block, says no snapshot_checkpoints
// row exists at its checkpoint block, and counts the capability_snapshots rows at that
// block still stamped with a NULL btc_chain_id, which the checkpoint search skips.
// Diagnostic only: it never changes the response and never throws.

const { getLogger } = require('../../../observability');

const MISS_LOG_INTERVAL_MS = 60000;
const MISS_LOG_MAX_BLOCKS = 64;

function createMissLog(options = {}) {
    const intervalMs = options.intervalMs || MISS_LOG_INTERVAL_MS;
    const now = options.now || (() => Date.now());
    const logger = options.logger || getLogger();
    const lastLogged = new Map();

    function due(snapshotBlock) {
        const at = now();
        const last = lastLogged.get(snapshotBlock);
        if (last !== undefined && at - last < intervalMs) return false;
        lastLogged.delete(snapshotBlock);
        lastLogged.set(snapshotBlock, at);
        while (lastLogged.size > MISS_LOG_MAX_BLOCKS) lastLogged.delete(lastLogged.keys().next().value);
        return true;
    }

    async function report(db, snapshotBlock, checkpointBlock) {
        try {
            if (!due(snapshotBlock)) return false;
            let stamped = 'unknown';
            if (db && typeof db.countCapabilitySnapshotChainIdStamps === 'function') {
                const rows = await db.countCapabilitySnapshotChainIdStamps(snapshotBlock);
                const row = Array.isArray(rows) && rows.length ? rows[0] : null;
                if (row) stamped = Number(row.rows_null || 0) + ' of ' + Number(row.rows_total || 0) +
                    ' row(s) with NULL btc_chain_id';
            }
            logger.warn('CapabilitySnapshotProof: no snapshot_checkpoints row at BTC block ' +
                checkpointBlock + ' for snapshot_block ' + snapshotBlock +
                ' (answering SNAPSHOT_NOT_YET_CHECKPOINTED); capability_snapshots at that block: ' + stamped);
            return true;
        } catch (error) {
            return false;
        }
    }

    return { report };
}

module.exports = { createMissLog, MISS_LOG_INTERVAL_MS };
