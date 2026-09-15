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
 * XChain Hub - Oracle Round Execution
 *
 * The round tick: the boundary-aligned timer, the self-overlap guard, the
 * chain-tip anchor, the price fetch and gossip submission, and the record a
 * scheduler gap leaves behind. The awaits sit in the same order they always
 * did; the steps beside each method are synchronous unless their name says
 * otherwise.
 *
 ********************************************************************/

const { formatXchainPriceMeta } = require('./xchain_price_meta.js');
const { ORACLE_PRICE_SUBMIT } = require('./message_types.js');
const { noteRoundLost } = require('../../consensus/diagnostics');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Burned round numbers per scheduler gap that also get a skipped row; a wider gap
// is an outage, recorded once by range rather than as a flood of rows on return.
const ROUND_GAP_SKIP_ROW_CAP = 12;

module.exports = {

    // Start the periodic round timer, aligned to wall-clock round boundaries
    // anchored at this.epochStart. If we start mid-round and the submission
    // window is still open, run the current round immediately after a short
    // delay to let peer connections settle; otherwise wait until the next
    // boundary.
    startRoundTimer() {
        let elapsedInRound  = (Date.now() - this.epochStart) % this.roundInterval;
        let timeToNextRound = this.roundInterval - elapsedInRound;

        // A rejection out of a bare timer callback is an unhandled rejection
        // (process exit), so every timer-driven round execution catches here.
        const runRound = () => {
            this._executeRound().catch(err =>
                logger.error(nodeUtil.format('OracleRound: round execution error:', err && err.message ? err.message : err)));
        };

        let initialDelay = 5000;
        if (elapsedInRound + initialDelay < this.submissionWindow) {
            this.initialRoundTimer = setTimeout(() => {
                this.initialRoundTimer = null;
                runRound();
            }, initialDelay);
        }

        // Align to the next round boundary, then run on a steady interval.
        // Capture the handle so stop() can cancel it before it fires; null it
        // inside the callback so the idempotency guard in start() sees a clean
        // slate once the interval has taken over.
        this.boundaryTimer = setTimeout(() => {
            this.boundaryTimer = null;
            runRound();
            this.roundTimer = setInterval(runRound, this.roundInterval);
        }, timeToNextRound);
    },

    // Execute a single round: fetch prices, broadcast submission.
    //
    // Round self-overlap guard (house convention:
    // FullNodeChallengeRound._tick). The round-number test below looks like a guard but
    // is not one: it fences a REPEAT of the same round, and the next interval fires with
    // a NEW round number, so it passes. Everything after it reads and writes
    // this.currentRound across several awaits (network resolve, chain-tip read, the
    // external price fetch, the XCHAIN/USD derive, the submission persist), so a round
    // that outruns roundInterval has its currentRound reassigned underneath it by the
    // round that fired on top: the slow round then broadcasts ITS prices stamped with the
    // NEW round number, records them over the newer round's own entry in the submission
    // map, and persists the audit row under that number. Peers keep only the first
    // submission per sender per round (_handleMessage), so the federation aggregates one
    // price set while this hub's own map, DB row and finalization see the other: it
    // disagrees with the quorum about what it submitted. The reassignment also clobbers
    // currentBtcBlockHeight, so both rounds anchor to a height neither of them read.
    // Skipping the overlapping round drops one round's submission, which is recoverable
    // (round numbers are wall-clock derived and resync on the next tick); interleaving
    // corrupts the round already in flight. The guard is a wrapper rather than inline so
    // the finally cannot be skipped by any of the body's early returns; a rejected fetch
    // must not wedge the oracle for the process lifetime.
    async _executeRound() {
        if (this._roundInFlight) {
            logger.warn('Oracle: previous round still in flight; skipping this round tick');
            return;
        }
        this._roundInFlight = true;
        try {
            return await this.executeRoundInner();
        } finally {
            this._roundInFlight = false;
        }
    },

    async executeRoundInner() {
        let newRound = advanceRoundNumber.call(this);
        if (newRound === null) return;

        this.currentRound   = newRound;
        this.roundStartTime = Date.now();

        // Capture the BTC chain tip at the start of this round: the deterministic
        // anchor for cross-node price agreement. Network is resolved via the hub
        // helper so this works whether the hub serves mainnet, testnet or regtest
        // BTC indexers.
        try {
            let network = await this.hub.resolveBtcNetwork();
            // Remembered for the derived-pair composition gate below, which needs the network
            // synchronously. Left UNSET when this resolve throws, so a hub that could
            // not determine its own network fails the gate closed rather than guessing.
            this.currentBtcNetwork = network;
            let btcTip = await this.db.getChainTip('BTC', network);
            if (btcTip) {
                applyPushedChainTip.call(this, btcTip);
            } else {
                let directHeight = null;
                try { directHeight = await this.hub.resolveBtcLatestBlock(); }
                catch (_) { /* resolver failed; fall through to round-number anchor */ }

                if (directHeight) applyDirectHeight.call(this, directHeight);
                else applyRoundNumberAnchor.call(this);
            }
        } catch (err) {
            noteChainTipFailure.call(this, err);
        }

        startRoundSubmissionMap.call(this);

        await submitRoundPrices.call(this);
    },

    // Record a run of round numbers the scheduler stepped over: one line for the run,
    // a skipped row for the first ROUND_GAP_SKIP_ROW_CAP, anchored at each round's
    // nominal wall-clock start so every hub that stepped over it writes the same row.
    noteRoundNumbersSkipped(from, to) {
        let count = to - from + 1;
        noteRoundLost({
            phase: 'schedule', round: from, cause: 'round_numbers_skipped',
            from: from, to: to, count: count,
            last_executed: from - 1, resumed_at: to + 1
        });
        logger.warn('Oracle: scheduler stepped from round ' + (from - 1) + ' to ' + (to + 1) +
            ', burning ' + count + ' round number(s) ' + from + '..' + to +
            ' (forward clock step or a tick more than a round late); recording them as skipped');
        if (!this.oracleConsensus || typeof this.oracleConsensus.storeSkippedRound !== 'function') return;
        let upto = Math.min(to, from + ROUND_GAP_SKIP_ROW_CAP - 1);
        for (let r = from; r <= upto; r++) {
            let nominalStart = Math.floor((this.epochStart + r * this.roundInterval) / 1000);
            this.oracleConsensus.storeSkippedRound(r, null, nominalStart,
                'round number skipped by the scheduler (clock step or late tick)').catch(err =>
                logger.error(nodeUtil.format('Oracle: Failed to store scheduler-skipped round ' + r + ':',
                    err && err.message ? err.message : err)));
        }
    }

};

// This tick's round number, or null when the tick repeats the round already
// executed (the caller then does nothing).
function advanceRoundNumber() {
    // Compute the round number from wall-clock time so every hub in the
    // federation agrees on the round number for the same point in time
    // (and so a restarted hub resumes at the correct number instead of 1).
    let newRound = Math.floor((Date.now() - this.epochStart) / this.roundInterval);
    if (newRound === this.lastExecutedRound) return null;
    // A forward clock step, a suspended process or a late tick burns every number
    // in between with no tick, no submission and no row: record the run first.
    // A fresh start (-1) is not a gap.
    if (this.lastExecutedRound >= 0 && newRound > this.lastExecutedRound + 1) {
        this.noteRoundNumbersSkipped(this.lastExecutedRound + 1, newRound - 1);
    }
    this.lastExecutedRound = newRound;
    return newRound;
}

// Anchor the round on a chain tip the indexer pushed into the hub DB.
function applyPushedChainTip(btcTip) {
    this.currentBtcBlockHeight         = btcTip.blockHeight;
    this.currentBtcBlockTime           = btcTip.blockTime;
    this.lastSuccessfulChainTipFetchAt = Date.now();
    this.chainTipFetchFailures         = 0;
    this.chainTipFallbackActive        = false;
    // Record the pushed tip's own block time so diagnostics can age it. A
    // present-but-frozen row (indexer catch-up suppressing pushes) clears
    // every fetch counter above but leaves this block time stale.
    this.anchorTipBlockTime = (typeof btcTip.blockTime === 'number' && btcTip.blockTime > 0)
        ? btcTip.blockTime : null;
}

// Anchor the round on the hub's own direct indexer read.
//
// No pushed chain tip in the hub DB. The indexer→hub `pushchaintip`
// path only populates getChainTip when an indexer is co-located with
// (and configured to push to) this hub, which a master/standalone hub
// box running the oracle may not have. Before degrading to the round
// number, try the hub's direct indexer resolver (getlatestblock via
// BTC_INDEXER_API_URL or the configs table). It returns only a height,
// so anchor the timestamp to the wall clock. A real height is a real
// anchor, so clear the fallback flag: finalization must NOT be
// suppressed when we have an authoritative block height.
function applyDirectHeight(directHeight) {
    this.currentBtcBlockHeight         = directHeight;
    this.currentBtcBlockTime           = Math.floor(Date.now() / 1000);
    this.lastSuccessfulChainTipFetchAt = Date.now();
    this.chainTipFetchFailures         = 0;
    this.chainTipFallbackActive        = false;
    // Direct-resolver height carries no block time; the anchor is wall
    // clock, so block-age monitoring does not apply.
    this.anchorTipBlockTime = null;
}

// No BTC tip available at all; fall back to round number.
function applyRoundNumberAnchor() {
    this.chainTipFetchFailures++;
    if (!this.chainTipFallbackActive) this.chainTipFallbackActive = true;
    if (this.chainTipFetchFailures > 1) {
        logger.error('Oracle: BTC chain tip unavailable (failure ' + this.chainTipFetchFailures + '); using round number as fallback anchor');
    } else {
        logger.warn('Oracle: BTC chain tip unavailable; using round number as fallback anchor');
    }
    this.currentBtcBlockHeight = this.currentRound;
    this.currentBtcBlockTime   = Math.floor(Date.now() / 1000);
    this.anchorTipBlockTime    = null;
}

// The chain-tip read itself threw: same round-number anchor, counted and logged
// against the read rather than against an absent tip.
function noteChainTipFailure(err) {
    this.chainTipFetchFailures++;
    if (!this.chainTipFallbackActive) this.chainTipFallbackActive = true;
    if (this.chainTipFetchFailures > 1) {
        logger.error(nodeUtil.format('Oracle: Failed to read BTC chain tip (failure ' + this.chainTipFetchFailures + '):', err));
    } else {
        logger.warn(nodeUtil.format('Oracle: Failed to read BTC chain tip:', err));
    }
    this.currentBtcBlockHeight = this.currentRound;
    this.currentBtcBlockTime   = Math.floor(Date.now() / 1000);
    this.anchorTipBlockTime    = null;
}

// Age out the in-memory and durable submission records, then open this round's
// own submission map.
function startRoundSubmissionMap() {
    // Prune old submissions (keep current and previous round only)
    this.pruneSubmissions();
    // Best-effort DB retention for the oracle_submissions audit table. Fire-and-
    // forget: a retention failure must never stall or crash a money-bearing
    // consensus round (same posture as the tolerated audit-row insert failures).
    // Not awaiting is the requirement; DISCARDING the rejection was not, and it
    // made this the only error path in the round loop with no log and no counter.
    // The round number is captured HERE rather than read inside the handler: the
    // sweep settles asynchronously and this.currentRound may already have advanced.
    this.pruneSubmissionsDb().catch(err => this.onSubmissionsPruneFailure(err, this.currentRound));

    // Initialize submission map for this round
    if (!this.submissions.has(this.currentRound)) {
        this.submissions.set(this.currentRound, new Map());
    }
}

// Fetch this round's prices, append the derived pair when its gate is open,
// gossip and persist the submission, and arm finalization. Async because it
// holds every await the round has after the chain-tip anchor, in the original
// order; it is the LAST thing executeRoundInner does, so nothing of the round
// runs between its completion and the caller's return.
async function submitRoundPrices() {
    // Fetch prices from external sources
    let prices;
    try {
        prices = await this.priceFetcher.fetchPrices();
    } catch (err) {
        this.fetchFailures++;
        logger.error(nodeUtil.format('Oracle: Price fetch failed for round ' + this.currentRound + ':', err));
        // Still schedule finalization so the round leaves a durable record.
        // If peers gossiped submissions the round can be salvaged; if nobody
        // has prices, OracleConsensus writes a 'skipped' price_snapshots row
        // instead of the round vanishing without a trace. The skip streak is
        // advanced by that durable write's 'round:skipped' event, not here: a
        // local fetch failure the federation then salvages is not a skipped
        // round, and counting it here also double-counted a round that went on
        // to hit the chain-tip-fallback skip below (item 4942).
        this.scheduleFinalization(this.currentRound);
        return;
    }

    if (!prices || prices.length === 0) {
        logger.warn('Oracle: No prices available for round ' + this.currentRound);
        // Same rationale as the fetch-failure path above: record the gap, and
        // let the durable skip write advance the streak.
        this.scheduleFinalization(this.currentRound);
        return;
    }

    if (this.xchainPriceSource && this.xchainPriceGateOpen()) {
        let entry = await this.xchainPriceSource.derive(derivationRequest.call(this, prices));
        appendDerivedPair.call(this, prices, entry);
    }

    let myAddr = broadcastOwnSubmission.call(this, prices);

    // Persist to DB; await so a persistence failure is counted and observable
    // (surfaced via getDiagnostics), not silently dropped. Does not throw.
    await this.persistSubmissions(this.currentRound, myAddr, prices);

    // The stall gauges (consecutiveSkippedRounds / lastSuccessfulRoundTime) are
    // deliberately NOT stamped here: a successful local submission is not a
    // finalized round. They are updated by markRoundFinalized() on the consensus
    // 'round:finalized' event, so a commit-quorum stall (where the fetch keeps
    // succeeding but no round finalizes) ages the gauge instead of masking it.
    this.scheduleFinalization(this.currentRound);
}

// What the derived XCHAIN/USD source is asked for, if the activation gate has
// opened on this network for this round. Deliberately OUTSIDE fetchPrices():
// it is not fetched, it is computed from this validator's own BTC indexer
// rows, and it must not be able to disturb the 36 API pairs. The source never
// throws and returns null to abstain, so a hub without indexer access - or one
// whose chain-tip anchor is unreliable - simply omits the pair while the rest
// of the round proceeds untouched (§6 local-failure taxonomy).
//
// The gate is checked by the CALLER rather than inside the source because it is
// not a property of this hub's ability to derive: a hub that could compute the
// pair perfectly well must still not submit it before the federation-wide instant
// (§8 deploy order), regardless of local config.
//
// Fed this round's own BTC/USD from the fetch above, because the published
// value is on-chain XCHAIN/BTC x the validator's own BTC/USD (§6).
function derivationRequest(prices) {
    let btcUsd = prices.find(p => p.coinPair === 'BTC/USD');
    return {
        round:            this.currentRound,
        referenceHeight:  this.currentBtcBlockHeight,
        btcUsdPrice:      btcUsd ? btcUsd.price : null,
        chainTipReliable: !this.chainTipFallbackActive,
    };
}

// Add the derived pair to the round's price set, when the source produced one.
function appendDerivedPair(prices, entry) {
    if (entry) {
        // meta is local observability only (§10 step 6) and is NOT part of the
        // signed payload; strip it so the gossiped entry is shaped exactly like
        // every other pair and the canonical payload stays byte-identical.
        let { meta, ...wire } = entry;
        prices.push(wire);
        logger.info('Oracle: derived ' + wire.coinPair + '=' + wire.price +
            ' ' + formatXchainPriceMeta(meta));
    }
}

// Gossip this hub's own submission and record it in the round's map, returning
// the addr it was recorded under so the caller can persist the same row.
function broadcastOwnSubmission(prices) {
    // Count total sources across all pairs
    let totalSources = prices.reduce((sum, p) => sum + p.sources, 0);

    logger.info('Oracle: Round ' + this.currentRound + ' - fetched ' + prices.length +
        ' pairs from ' + totalSources + ' source queries');

    // Broadcast our submission via gossip
    this.peerManager.broadcast(ORACLE_PRICE_SUBMIT, {
        round:   this.currentRound,
        prices:  prices,
        sources: totalSources
    });

    // Record our own submission
    let myAddr = this.peerManager.validatorAddr;
    this.submissions.get(this.currentRound).set(myAddr, {
        prices:    prices,
        sources:   totalSources,
        timestamp: Date.now(),
        // Own verified identity, matching the pubkey stamped on peer
        // submissions so the snapshot membership filter treats self the same.
        pubkey:    this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null
    });
    return myAddr;
}
