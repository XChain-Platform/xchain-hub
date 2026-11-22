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
 * Reorg handler - retrying a decided rollback
 *
 * Once a rollback is decided (commit quorum, or the single-node path) its writes
 * must land on this hub: peers that applied it hold the reorgId as processed and
 * never propose it again, so a transient database error that is only logged leaves
 * this hub serving orphaned-block prices for good. The writes are one transaction,
 * so a failed attempt leaves nothing half-applied and an attempt can simply rerun.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const DEFAULT_ROLLBACK_ATTEMPTS = 5;
const DEFAULT_ROLLBACK_RETRY_BASE_MS = 1000;

module.exports = {

    // Attempt budget and backoff base, as instance fields so a test can shrink them.
    initRollbackRetry() {
        this.rollbackRetryAttempts = DEFAULT_ROLLBACK_ATTEMPTS;
        this.rollbackRetryBaseMs = DEFAULT_ROLLBACK_RETRY_BASE_MS;
        this._rollbackRetryWaits = new Set();
        this._rollbackRetryEpoch = 0;
    },

    // Apply one decided rollback, rerunning a failed attempt with exponential backoff.
    // The caller fixes `rollback.bound` once so every attempt covers the same scope.
    // Rejects with the last error once the budget is spent (after emitting
    // 'reorg:rollback-failed'), or with a rollbackCancelled error when stop() ends it.
    async driveRollback(rollback) {
        const epoch = this._rollbackRetryEpoch;
        for (let attempt = 1; ; attempt++) {
            // Another path (a re-report, a later round) may have applied it meanwhile.
            if (attempt > 1 && this.processed.has(rollback.reorgId)) return;
            try {
                await this.applyRollback(rollback);
                return;
            } catch (err) {
                if (attempt >= this.rollbackRetryAttempts) {
                    this.reportRollbackExhausted(rollback, attempt, err);
                    throw err;
                }
                logger.warn(nodeUtil.format('Reorg: rollback attempt %d of %d for %s failed, retrying:',
                    attempt, this.rollbackRetryAttempts, rollback.reorgId, err && err.message));
                if (!(await this.waitRollbackRetry(attempt, epoch))) {
                    const cancelled = new Error('rollback retry for ' + rollback.reorgId + ' cancelled by stop');
                    cancelled.rollbackCancelled = true;
                    throw cancelled;
                }
            }
        }
    },

    reportRollbackExhausted(rollback, attempts, err) {
        logger.error(nodeUtil.format('Reorg: rollback for %s (%s, bound %d) failed after %d attempts:',
            rollback.reorgId, rollback.chain, rollback.bound, attempts, err && err.message));
        this.emit('reorg:rollback-failed', {
            reorgId: rollback.reorgId, sourceChain: rollback.chain, reorgHeight: rollback.reorgHeight,
            timestamp: rollback.timestamp, bound: rollback.bound, attempts,
            error: err && err.message ? err.message : String(err)
        });
    },

    // Resolves true after the backoff, false when stop() cancelled it or ran since
    // this rollback's first attempt.
    waitRollbackRetry(attempt, epoch) {
        if (epoch !== this._rollbackRetryEpoch) return Promise.resolve(false);
        const delay = this.rollbackRetryBaseMs * 2 ** (attempt - 1);
        return new Promise(resolve => {
            const wait = { resolve };
            wait.timer = setTimeout(() => {
                this._rollbackRetryWaits.delete(wait);
                resolve(true);
            }, delay);
            this._rollbackRetryWaits.add(wait);
        });
    },

    cancelRollbackRetries() {
        this._rollbackRetryEpoch++;
        for (const wait of this._rollbackRetryWaits) {
            clearTimeout(wait.timer);
            wait.resolve(false);
        }
        this._rollbackRetryWaits.clear();
    }
};
