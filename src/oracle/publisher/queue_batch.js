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
 * XChain Hub - atomic durable enqueue for one PRICE batch window
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Publish all wires for a window to the queue in one atomic rename. A prior
    // completed write is success, while a legacy partial write is replaced only
    // when no publish pass can be holding one of its entries.
    enqueueWindowBatch(windowIndex, entries) {
        const state = this.readQueueState();
        if (state === null) throw new Error('durable queue is unreadable');
        const existing = state.entries.filter(entry => entry && entry.batch &&
            Number(entry.batch.windowIndex) === Number(windowIndex));
        const needed = new Set(entries.flatMap(entry => this.entryRounds(entry)));
        const covered = new Set(existing.flatMap(entry => this.entryRounds(entry)));
        if (Array.from(needed).every(round => covered.has(round))) return { written: false };
        // eslint-disable-next-line no-underscore-dangle
        if (existing.length > 0 && this._sweeping) {
            throw new Error('cannot replace a partial window while a publish pass is active');
        }

        const stamped = entries.map(entry => Object.assign({}, entry, {
            attempts: 0,
            enqueuedAt: Date.now()
        }));
        const kept = state.entries.filter(entry => !(entry && entry.batch &&
            Number(entry.batch.windowIndex) === Number(windowIndex)));
        const lines = kept.concat(stamped).map(entry => JSON.stringify(entry)).concat(state.rejected);
        const text = lines.join('\n') + (lines.length > 0 ? '\n' : '');
        try {
            this.rewriteDurableFile(this.queuePath, text);
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: failed to enqueue window %s:', windowIndex, e));
            throw e;
        }
        return { written: true };
    },

};
