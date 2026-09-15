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
 * Reorg handler - local report and rollback
 *
 * A reorg reported to this hub (checked against our own node before anything is
 * broadcast), the rollback a confirmed round ends in, and the history the RPC reads.
 *
 ********************************************************************/

'use strict';

const coins = require('../../coins');
const { REORG_ALERT } = require('./message_types.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Check a reported reorg's fields, throwing on the first one that fails, and hand back
    // the parsed height and timestamp, the clock reading the timestamp was judged against,
    // and the lowercased hash pair. Runs before anything in reportReorg awaits.
    parseReorgReport(chain, reorgHeight, timestamp, oldHash, newHash) {
        // Validate chain
        let allowedChains = coins.ALLOWED_COINS;
        if (!allowedChains.includes(chain))
            throw new Error('Invalid chain: ' + chain + ' (allowed: ' + allowedChains.join(', ') + ')');

        // Validate reorgHeight
        let h = parseInt(reorgHeight);
        if (!Number.isInteger(h) || h < 0)
            throw new Error('reorgHeight must be a non-negative integer');

        // Validate timestamp
        let t = parseInt(timestamp);
        if (!Number.isFinite(t) || t < 0)
            throw new Error('timestamp must be a non-negative number');
        let now = Date.now();
        if (t > now + 300000)
            throw new Error('timestamp is too far in the future');
        if (t < now - this.maxLookbackMs)
            throw new Error('timestamp is too far in the past (reorg blast-radius bound: ' +
                this.maxLookbackMs + 'ms); a reorg can only invalidate recent state');

        // Validate the observed hash pair
        oldHash = String(oldHash || '').toLowerCase();
        newHash = String(newHash || '').toLowerCase();
        if (!this.hashesWellFormed(oldHash, newHash))
            throw new Error('oldHash and newHash must be distinct 64-hex block hashes ' +
                '(the hash observed at reorgHeight before the reorg, and the one served now)');
        return { h, t, now, oldHash, newHash };
    },

    // Report a reorg (called via JSON-RPC or internally). The reporter supplies the
    // block hash it observed BEFORE the reorg at reorgHeight (oldHash) and the hash
    // its node serves NOW (newHash); this hub re-verifies both against its own
    // indexer before broadcasting, so a compromised reporter credential alone can
    // not start a rollback round for a reorg that never happened.
    async reportReorg(chain, reorgHeight, timestamp, oldHash, newHash) {
        let parsed = this.parseReorgReport(chain, reorgHeight, timestamp, oldHash, newHash);
        let h = parsed.h, t = parsed.t, now = parsed.now;
        oldHash = parsed.oldHash; newHash = parsed.newHash;

        let reorgId = this.canonicalReorgId(chain, reorgHeight, timestamp);

        // Already handled: this call is a no-op, so answer it BEFORE the rate limiter.
        // Re-reporting a reorg we have already rolled back is idempotent by design and
        // costs nothing here (no DB, no broadcast, no verification), but sitting behind
        // the limiter it threw 'Rate limit ...' instead - so the ordinary retry a
        // monitor or a peer makes after a confirmed reorg surfaced as an error rather
        // than the intended silent ignore.
        if (this.processed.has(reorgId)) return;

        // Rate limit: 1 report per chain per 60 seconds. CHECK the budget here, but do
        // NOT consume it until the report actually passes self-verification and will be
        // acted on (below). Consuming it up-front let a report that fails verification
        // (typically a momentarily-lagging local node during a real reorg, or a duplicate
        // early-return) burn the 60s window, so the operator's retry after the node
        // re-syncs was rejected exactly when the genuine ALERT needed to go out
        // (REORG-RATELIMIT-BEFORE-VERIFY-1).
        let lastReport = this.reorgRateTracker.get(chain) || 0;
        if (now - lastReport < 60000)
            throw new Error('Rate limit: only one reorg report per chain per 60 seconds');

        // Never report (or locally execute) a rollback our own node does not confirm.
        let verified = await this.verifyReorgAgainstOwnNode(chain, h, oldHash, newHash);
        if (!verified)
            throw new Error('own indexer does not confirm this reorg ' +
                '(node must serve newHash at reorgHeight, within depth bounds, on the federation network)');
        let observedBlockTimeMs = (verified && Number.isFinite(verified.blockTimeMs)) ? verified.blockTimeMs : null;
        if (!this.timestampConsistentWithBlockTime(t, observedBlockTimeMs))
            throw new Error('timestamp predates the reorged block\'s own block_time at reorgHeight ' +
                '(a reorg cannot be observed before the block existed)');

        // Verified and about to act: now consume the per-chain rate budget (covers both
        // the single-node local-execute path and the broadcast+consensus path below).
        this.reorgRateTracker.set(chain, now);

        // Single-node fallback
        let quorum = this.getQuorum();
        if (quorum === 0) {
            await this.executeRollback(chain, reorgHeight, timestamp, reorgId, 1, '[]', observedBlockTimeMs);
            return;
        }

        // Broadcast REORG_ALERT
        this.peerManager.broadcast(REORG_ALERT, {
            chain, reorgHeight, timestamp, reorgId, oldHash, newHash
        });

        // Determine affected chains (any chain that had cross-chain interactions with the source)
        let affectedChains = this.getAffectedChains(chain);

        // Start consensus
        this.initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash, observedBlockTimeMs);
    },

    async getReorgHistory(limit) {
        // The 500-row server-side page cap travels with the statement, in
        // db/reorg_attestations.js, so the caller's limit is passed through raw.
        return await this.db.findReorgAttestations(limit);
    },

    async executeRollback(chain, reorgHeight, timestamp, reorgId, validatorCount, proof, observedBlockTimeMs) {
        logger.info('Reorg: Rolling back cross-chain state for ' + chain + ' at height ' + reorgHeight);

        // Rollback bound: anchor to OUR OWN node's block_time for reorgHeight
        // (captured during self-verification) rather than the reporter-supplied
        // timestamp. A reorg invalidates state derived from blocks AT AND ABOVE
        // reorgHeight, so the reorged block's own time is the correct scope; the
        // reporter's timestamp is gameable within the 24h window (far-past =
        // over-rollback griefing, near-now = under-rollback leaving invalidated
        // attestations live). Every hub reads its own copy of the SAME
        // quorum-verified block, so the bound stays consensus-uniform. Clamped to
        // the lookback window so a fabricated deep "reorg" (garbage oldHash at a
        // depth-bound height) cannot reach further back than the documented
        // blast-radius bound. Falls back to the reported timestamp when the
        // indexer served no block_time (legacy behavior). Residual: miner
        // timestamps may skew ahead of wall-clock, leaving a small under-rollback
        // edge closable only by per-row block provenance.
        let bound = Number.isFinite(observedBlockTimeMs) ? observedBlockTimeMs : parseInt(timestamp);
        let floor = Date.now() - this.maxLookbackMs;
        if (bound < floor) bound = floor;

        await this.db.deleteAttestation(chain, bound);

        // price_snapshots.block_timestamp is Unix SECONDS (OracleConsensus / PriceAggregator
        // write Math.floor(Date.now()/1000)), but the reorg bound is MILLISECONDS
        // (block_time * 1000, or the ms timestamp validated against Date.now()). Divide to
        // compare in the same unit, matching the attestations DELETE above; without this
        // the seconds column never exceeds the ms literal and the dispute silently matches
        // zero rows.
        await this.db.updatePriceSnapshotByBlockTimestamp(bound);

        let affectedChains = this.getAffectedChains(chain);
        await this.db.setReorgAttestation(reorgId, chain, reorgHeight, timestamp, JSON.stringify(affectedChains), validatorCount, proof);

        this.processed.add(reorgId);

        logger.info('Reorg: Rollback complete for ' + reorgId +
            ': attestations and snapshots after ' + bound +
            (Number.isFinite(observedBlockTimeMs) ? ' (block_time-anchored)' : ' (reported timestamp)') +
            ' invalidated');

        this.emit('reorg:confirmed', {
            reorgId, sourceChain: chain, reorgHeight, timestamp, affectedChains
        });
    }

};
