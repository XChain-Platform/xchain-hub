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
 * XChain Hub - Price Aggregator: ingest guards
 *
 * The checks and the throttled warnings every ingest path shares: the
 * plausible-round band, the per-source-chain pair-coverage detector, and the
 * ingest-fence rejection notice with the network the fence row is keyed on.
 *
 ********************************************************************/

const roundBandLib      = require('../oracle_round_band.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Minimum gap between ingest-fence rejection warnings for the SAME source
// chain. Sized so a stalled rail keeps re-announcing itself in any log tail while a
// replaying pusher cannot drown the log; the suppressed count rides on the next line.
const FENCE_WARN_INTERVAL_MS = 60_000;

// Minimum gap between missing-pair coverage warnings for the SAME source chain.
// Same sizing rationale as FENCE_WARN_INTERVAL_MS: a pair that stays gone keeps
// re-announcing itself in any log tail, without one stalled feed flooding the log.
const MISSING_PAIR_WARN_INTERVAL_MS = 60_000;

module.exports = {

    // The plausible round band for THIS hub, or null when the local oracle
    // schedule is unresolvable (a mirror hub built without an OracleRound, a
    // test double, a hub whose clock predates ORACLE_EPOCH_START).
    //
    // Null means "no opinion" and every caller must treat it that way. A hub
    // that cannot resolve its own schedule must not start refusing its
    // federation's consensus output on a guess; see lib/oracle_round_band.js.
    roundBand() {
        let oracle = this.hub && this.hub.oracle;
        if (!oracle) return null;
        return roundBandLib.roundBand({
            epochStartMs:    oracle.epochStart,
            roundIntervalMs: oracle.roundInterval
        });
    },

    // Write-time half of the defence: refuse a round number the schedule
    // could not have produced. Returns null to accept, or the rejection reason.
    //
    // ONE-SIDED. Only the FUTURE side rejects, because only it is impossible:
    // replaying indexers, catching-up chain-only nodes and hour-wide batch
    // windows all legitimately push rounds that are hours or days old, and
    // bounding the past would drop real consensus output.
    refuseOutOfBandRound(round, sourceChain, what) {
        let band = this.roundBand();
        if (!band || !roundBandLib.isRoundImplausible(round, band)) return null;
        this.implausibleRoundRejections += 1;
        this.lastImplausibleRound = Number(round);
        // Never silent: an out-of-band round is either a corrupt row upstream or a
        // peer with a broken clock, and both need naming rather than a quiet drop.
        logger.warn('PriceAggregator: refusing ' + what + ' from ' +
                     (sourceChain || 'unknown') + ': ' +
                     roundBandLib.describeImplausibleRound(round, band));
        return 'implausible round';
    },

    // Name a pair that STOPPED arriving from a source chain. The PRODUCER path records a
    // durable 'skipped' row for every configured pair a finalized round omitted
    // (OracleConsensus.storeSnapshot, item #180) and getSubmissionsInfo surfaces those as
    // droppedPairs; this path had no equivalent, so on a mirror hub a pair that quietly
    // stopped appearing in pushed rounds left no row, no counter and no line naming it,
    // while consumers kept serving its previous round and the drop diagnostics read
    // healthy (item 5335).
    //
    // The reference set is the pairs THIS source chain has actually been sending, not this
    // hub's local pair config. Local config is the wrong basis on an ingest path: the round
    // is another federation's consensus output, so any pair it legitimately does not publish
    // (a gate not yet open there, a feed it cannot source, a version skew in its pair list)
    // would warn on every single round, and a detector that fires constantly names nothing.
    // A high-water set per chain self-calibrates instead: the first accepted round from a
    // chain only records what it carries, and only a pair that was arriving and then stops
    // is reported. The cost is that the set is in-memory, so a pair already gone before a
    // restart is not re-reported; that is the honest limit of a non-durable detector, and
    // the alternative (writing marker rows from local config) would put rows the source
    // chain never finalized into a consensus-MIRRORED table, its id-ordered bootstrap read
    // and its row:inserted stream, letting two hubs mirror one round differently.
    //
    // Warnings are throttled per source chain on the warnIngestFenceRejection pattern: the
    // first short round prints immediately, then at most one line per window, carrying both
    // the count it stands for and the running total of short rounds so nothing is lost.
    checkIngestPairCoverage(sourceChain, round, pairs) {
        let chain   = sourceChain || 'unknown';
        let present = new Set(pairs.map(p => p.pair));
        let state   = this._missingPairWarnState.get(chain);
        if (!state) {
            // First round from this chain: adopt its pair set as the baseline, report nothing.
            this._missingPairWarnState.set(chain, { seen: present, last: 0, suppressed: 0, rounds: 0 });
            return;
        }
        let missing = [...state.seen].filter(pair => !present.has(pair));
        // Grow the high-water set with anything new, so a pair that starts arriving is
        // covered from then on; a missing pair stays in `seen` so it keeps being reported
        // until it comes back.
        for (let pair of present) state.seen.add(pair);
        if (!missing.length) return;
        this.warnMissingIngestPairs(chain, round, missing, state);
    },

    warnMissingIngestPairs(chain, round, missingPairs, state) {
        let now = Date.now();
        state.rounds++;
        if (state.last && (now - state.last) < MISSING_PAIR_WARN_INTERVAL_MS) {
            state.suppressed++;
            return;
        }
        let suppressed = state.suppressed;
        state.last = now;
        state.suppressed = 0;
        logger.warn('PriceAggregator: round ' + round + ' from ' + chain + ' arrived without '
            + missingPairs.length + ' pair(s) this chain had been sending: ' + missingPairs.join(', ')
            + '. Consumers keep serving the previous round for each one until it returns.'
            + ' ' + state.rounds + ' round(s) from this chain have been short a pair so far'
            + (suppressed > 0 ? '; ' + suppressed + ' warning(s) suppressed since the last line' : '')
            + '. If a pair is gone for good, the source federation stopped publishing it;'
            + ' if it flaps, that federation is dropping it at its own aggregation gate.');
    },

    // An ingest-fence rejection must never be silent (a bare
    // { accepted:false } return), because a silent one kills a price rail: reset an
    // indexer DB and its push_generations counter restarts at 0, so every push from
    // it sits at or below a kept retraction_generation and is dropped. The operator
    // sees "prices stopped" with nothing anywhere naming the cause, and the
    // native-fee / XCHAIN-USD path that rides on prices fails with it.
    //
    // So say it out loud, with the remedy in the line: on this path the fence is far
    // more likely to be firing on a rebuilt indexer (a standing condition that stops
    // the rail until someone clears the row) than on the stale in-flight replay it
    // was built for (a one-off).
    //
    // Throttled per source chain because a replaying pusher must not be able to
    // flood the log: the first rejection prints immediately, then at most one line
    // per window, carrying the count it stands for so the volume is never lost.
    // The deployment network every fence read and write on this hub is scoped to. The fence
    // row is keyed (network, source_chain): without the network key, a hub DB shared by, or
    // outliving, more than one network holds ONE row per chain for all of them, so clearing
    // a regtest fence drops the live network's fence for that chain. A hub whose HUB_NETWORK is unset
    // keys the legacy '' bucket, which is exactly where its pre-column rows already are.
    // Normalized in the same shape as db.js normalizeFenceNetwork (trim + lowercase) rather
    // than by requiring db.js, which would pull the mariadb driver into this module's require
    // graph for a two-line string fold.
    fenceNetwork() {
        let net = this.hub && this.hub.network;
        return typeof net === 'string' ? net.trim().toLowerCase() : '';
    },

    warnIngestFenceRejection(sourceChain, kind, pushGeneration, actionIndex, wm) {
        let chain = sourceChain || 'unknown';
        let now   = Date.now();
        let state = this._fenceWarnState.get(chain);
        if (state && (now - state.last) < FENCE_WARN_INTERVAL_MS) {
            state.suppressed++;
            return;
        }
        let suppressed = state ? state.suppressed : 0;
        this._fenceWarnState.set(chain, { last: now, suppressed: 0 });
        logger.warn('PriceAggregator: WARNING: DROPPED ' + kind + ' price push from ' + chain
            + ' at the ingest fence (push_generation ' + pushGeneration + ' <= retraction_generation '
            + wm.retraction_generation + ' AND action_index ' + actionIndex + ' >= from_action_index '
            + wm.from_action_index + ').'
            + (suppressed > 0 ? ' ' + suppressed + ' further rejection(s) for this chain were suppressed since the last warning.' : '')
            + ' The ' + chain + ' price rail is DOWN for as long as this repeats, and the native-fee'
            + ' / XCHAIN-USD path fails with it. If the ' + chain + ' indexer DB was reset or rebuilt,'
            + ' its push_generations counter restarted at 0 and this fence row is stale: clear it'
            + " with DELETE FROM price_ingest_watermarks WHERE source_chain = '" + chain + "'"
            + " AND network = '" + this.fenceNetwork() + "'"
            + ' on the hub DB. The network clause is what keeps the clear off every OTHER'
            + " network's fence for the same chain, so run it exactly as written."
            + ' Otherwise this is a stale replay of a retracted action and the'
            + ' drop is correct.');
    }

};
