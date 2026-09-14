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
 * XChain Hub - Attestation Spot-Check Evidence
 *
 * Everything a judged verdict leaves behind: the durable per-signer outcome
 * rows and their retention sweep, the rolling in-memory failure window that
 * converts repeat failures into a slash proposal, and the reorg rollback that
 * drops evidence anchored to blocks that no longer exist.
 *
 ********************************************************************/

'use strict';
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const MAX_HISTORY_PER_VALIDATOR   = 64;

// The prune has nothing new to do for hours after it runs, and the DELETE scans on
// checked_at, so throttle it rather than running it on every judged outcome.
const STATS_SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;

module.exports = {

    // Persist one judged spot-check outcome to attestation_validator_stats.
    // Idempotent per (validator, request). No-op when the hub has no DB
    // (single-node / unit tests run purely on the in-memory window).
    async persistStats(pubkey, providerId, requestId, blockIndex, passed){
        if (!pubkey) return;
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function') return;
        try {
            await db.setAttestationValidatorStat(String(pubkey).toLowerCase(), String(providerId), String(requestId),
                Number(blockIndex) || 0, passed ? 1 : 0);
            // A row just landed, which is the only way this table ever grows, so this
            // is where the retention sweep belongs (same reasoning as the sibling
            // publishers' post-write sweeps). Throttled and fire-and-forget inside.
            this.sweepStatsRetention();
        } catch (e) {
            logger.warn('AttestationSpotChecker: stats persist failed for ' +
                         String(pubkey).substring(0, 16) + '...: ' + (e && e.message ? e.message : e));
        }
    },

    // Bound the durable outcome table. Age-based, and computed in DB-clock arithmetic
    // on BOTH sides: checked_at is written by CURRENT_TIMESTAMP, so comparing it
    // against a Node-side timestamp would fold host/DB clock skew straight into the
    // cutoff. The window is floored at the rolling failure window, so a misconfigured
    // short retention can never delete a row inside the span the slash trigger reasons
    // over; at the 90-day default nothing reorg-reachable is anywhere near the cutoff,
    // which is why no block-height clamp is needed on top. Returns rows deleted.
    // Throws on a DB error, and the caller decides what that costs.
    async pruneStats(){
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function') return 0;
        if (!this.statsRetentionMs || this.statsRetentionMs <= 0) return 0;

        let windowSec = Math.ceil(Math.max(this.statsRetentionMs, this.failureWindowMs) / 1000);
        let res = await db.deleteAttestationValidatorStatsOlderThan(windowSec);
        let deleted = (res && res.affectedRows) ? Number(res.affectedRows) : 0;
        if (deleted > 0) {
            this.statsPruned += deleted;
            logger.info('AttestationSpotChecker: spot-check stats retention pruned ' + deleted +
                        ' outcome row(s) older than ' + windowSec + 's');
        }
        return deleted;
    },

    // Housekeeping hook for the retention sweep. Throttled, because the prune has
    // nothing new to delete for hours after it runs and the judge path calls it on
    // every persisted outcome. Fire-and-forget with the rejection swallowed:
    // retention is housekeeping and must never fail or stall a judging pass.
    sweepStatsRetention(){
        if (!this.statsRetentionMs) return;
        let now = Date.now();
        if (now - this._statsSweptAt < STATS_SWEEP_MIN_INTERVAL_MS) return;
        this._statsSweptAt = now;
        this._statsSweep = this.pruneStats().catch((e) => {
            logger.warn('AttestationSpotChecker: spot-check stats retention sweep failed ' +
                         '(the outcome table keeps growing until it succeeds): ' +
                         (e && e.message ? e.message : e));
            return 0;
        });
    },

    // Reorg rollback: a confirmed reorg to `height` orphans every block above
    // it, so spot-check outcomes anchored to those blocks are no longer valid
    // evidence. Delete them and clear the in-memory failure window so no slash
    // proposal fires on evidence from a block that no longer exists (fail-safe:
    // we drop the whole window rather than risk keeping an orphaned failure).
    // Returns the number of DB rows removed. Best-effort and non-throwing.
    async rollback(height){
        this._failures.clear();
        let h = Number(height);
        // A spot-check held for re-judging is anchored to the same
        // orphaned block, so purge it before the sweep can score a rolled-back
        // round into the stats the DELETE below is clearing.
        if (Number.isFinite(h)) {
            for (let [rid, rec] of Array.from(this._pendingReJudge.entries())) {
                if (Number(rec.blockIndex) > h) this._pendingReJudge.delete(rid);
            }
        }
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function' || !Number.isFinite(h)) return 0;
        try {
            let res = await db.deleteAttestationValidatorStatsAboveBlock(h);
            let removed = res && (res.affectedRows != null ? res.affectedRows : (Array.isArray(res) ? 0 : 0));
            if (removed) {
                logger.info('AttestationSpotChecker: reorg rollback removed ' + removed +
                            ' spot-check row(s) above block ' + h);
            }
            return removed || 0;
        } catch (e) {
            logger.warn('AttestationSpotChecker: reorg rollback failed: ' + (e && e.message ? e.message : e));
            return 0;
        }
    },

    // Aggregate durable stats for one validator (introspection / future RPC):
    // { total, failed, passed }. Reads from the persistent table; {0,0,0} when
    // no DB or no rows.
    async statsFor(pubkey){
        let empty = { total: 0, failed: 0, passed: 0 };
        if (!pubkey) return empty;
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function') return empty;
        try {
            let rows = await db.getAttestationValidatorStatTotals(String(pubkey).toLowerCase());
            let r = (rows && rows[0]) || {};
            let total  = Number(r.total) || 0;
            let failed = Number(r.failed) || 0;
            return { total, failed, passed: total - failed };
        } catch (e) {
            logger.warn('AttestationSpotChecker: statsFor query failed: ' + (e && e.message ? e.message : e));
            return empty;
        }
    },

    // Track a failure against a validator. If the count in the rolling
    // window crosses threshold, record a slash proposal via SlashDetector.
    recordFailure(pubkey, requestId){
        if (!pubkey) return;
        let pk = String(pubkey).toLowerCase();
        let now = Date.now();
        let arr = this._failures.get(pk) || [];
        arr.push({ requestId: requestId, timestamp: now });
        let cutoff = now - this.failureWindowMs;
        arr = arr.filter(f => f.timestamp > cutoff);
        if (arr.length > MAX_HISTORY_PER_VALIDATOR) {
            arr = arr.slice(arr.length - MAX_HISTORY_PER_VALIDATOR);
        }
        this._failures.set(pk, arr);

        if (arr.length >= this.failureThreshold && this.hub.slashDetector
            && typeof this.hub.slashDetector.recordSlashProposal === 'function') {
            let evidence = JSON.stringify({
                failures:   arr.length,
                windowMs:   this.failureWindowMs,
                lastRequestId: requestId
            });
            let pseudoRound = parseInt(String(requestId).substring(0, 8), 16) || 0;
            this.hub.slashDetector.recordSlashProposal(pk, 'attestation_spot_check_failure', pseudoRound, evidence)
                .catch(e => logger.warn(nodeUtil.format('AttestationSpotChecker: slash record failed:', e)));
        }
    }

};
