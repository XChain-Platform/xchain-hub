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
 * XChain Hub - Oracle Round Finalization Scheduling
 *
 * The per-round timer that hands a round to consensus once its submission
 * window closes, including the chain-tip-fallback refusal that stores a
 * skipped row instead of anchoring a PRICE payload to an unreliable height.
 *
 ********************************************************************/

const { noteRoundLost } = require('../../consensus/diagnostics');
const { isFederatedHub, isFederatedHubActive, liveFederationSignals } = require('../../consensus/federation.js');
const { nominalRoundSeconds } = require('../consensus/round_time/round_time');
const { roundTimeGateActive } = require('../consensus/round_time_gate');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The wire block time for a round. Gate active: the nominal round time. Gate
// off: the captured value when it is a positive safe integer, else the nominal
// time, so a malformed value never reaches the wire.
function wireBlockTime(round, btcBlockHeight, captured, network, epochStart, roundInterval) {
    let nominal = nominalRoundSeconds(round, epochStart, roundInterval);
    if (roundTimeGateActive({ network, btcHeight: btcBlockHeight })) return nominal;
    if (nominal === null) return captured;
    return Number.isSafeInteger(captured) && captured > 0 ? captured : nominal;
}

// True when the consensus engine reports a peer quorum or, once FEDERATED_HUB_ACTIVATION
// is active at the anchor, any federation signal: the test the snapshot gates share
// (consensus/federation.js roundIsFederated). The follower's absent-height drop applies
// it at its own BTC tip instead, since the proposer chooses the wire height.
function isFederated(consensus, network, btcBlockHeight) {
    if (typeof consensus.getQuorum === 'function' && consensus.getQuorum() > 0) return true;
    return isFederatedHubActive(network, btcBlockHeight) &&
        isFederatedHub(liveFederationSignals(consensus));
}

// Backoff between re-attempts of a rejected skipped-row write. A DB outage that
// opens the circuit breaker rejects every write until its cooldown expires, and
// nothing else ever writes this round's row (the round number is wall-clock
// derived, so no later round revisits it): without a re-attempt the round stays
// a permanent hole in the presence record on this hub and on every mirror. The
// budget spans about half an hour, longer than a MariaDB restart or pause.
const SKIP_STORE_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000, 300000, 300000, 300000, 300000, 300000];

// True once the consensus engine holds the round as finalized: a federation
// PROPOSE landed the real rows, so a skipped marker has nothing left to add.
function roundAlreadyFinalized(consensus, round) {
    return !!(consensus.finalized && typeof consensus.finalized.has === 'function' && consensus.finalized.has(round));
}

// Store the round's durable skipped row instead of finalizing it; a rejected
// write still leaves a round_lost record rather than only a prose error line,
// and is re-attempted on a backoff until it lands or the budget runs out.
// While an attempt is in flight or a re-attempt is armed, the round holds a slot
// in finalizationTimers, so stop() clears the pending re-attempt, records the
// round and writes its row once more itself, and a rejection that settles after
// stop() (or after the round was rescheduled) finds its slot gone and stops there.
// The write is idempotent: it never demotes a finalized row.
function storeAnchorSkip(oracleRound, consensus, round, btcBlockHeight, btcBlockTime, reason, attempt = 0) {
    let slot = { skipStoreRound: round, attempt };
    oracleRound.finalizationTimers.set(round, slot);
    let ownsSlot = () => oracleRound.finalizationTimers.get(round) === slot;
    let release = () => { if (ownsSlot()) oracleRound.finalizationTimers.delete(round); };
    consensus.storeSkippedRound(round, btcBlockHeight, btcBlockTime, reason).then(release, err => {
        let message = err && err.message ? err.message : String(err);
        logger.error(nodeUtil.format('Oracle: Failed to store skipped round ' + round + ':', message));
        noteRoundLost({ phase: 'finalize', round, cause: 'skip_store_rejected', err: message });
        if (!ownsSlot()) return;
        if (attempt >= SKIP_STORE_RETRY_DELAYS_MS.length || roundAlreadyFinalized(consensus, round)) {
            if (attempt >= SKIP_STORE_RETRY_DELAYS_MS.length) {
                logger.error('Oracle: Giving up on the skipped row for round ' + round + ' after ' +
                    (attempt + 1) + ' attempts');
            }
            release();
            return;
        }
        let timer = setTimeout(() => {
            if (oracleRound.finalizationTimers.get(round) !== timer) return;
            if (roundAlreadyFinalized(consensus, round)) {
                oracleRound.finalizationTimers.delete(round);
                return;
            }
            storeAnchorSkip(oracleRound, consensus, round, btcBlockHeight, btcBlockTime, reason, attempt + 1);
        }, SKIP_STORE_RETRY_DELAYS_MS[attempt]);
        oracleRound.finalizationTimers.set(round, timer);
    });
}

module.exports = {

    // Schedule finalization for a round after the submission window
    scheduleFinalization(round) {
        // Capture the BTC chain tip values for this round at scheduling time
        let btcBlockHeight = this.currentBtcBlockHeight;
        let btcBlockTime   = wireBlockTime(round, btcBlockHeight, this.currentBtcBlockTime,
            this.hub.network, this.epochStart, this.roundInterval);
        // Remember whether that height is the round-number stand-in rather than a
        // real BTC tip; the flag and the stand-in height are always set together.
        let anchorIsRoundNumber = !!this.chainTipFallbackActive;
        let prior = this.finalizationTimers.get(round);
        if (prior) clearTimeout(prior);
        // Every exit below that is neither a finalizeRound call nor a skipped row
        // leaves a round_lost record; the prose lines stay for a reader.
        let timer = setTimeout(() => {
            this.finalizationTimers.delete(round);
            try {
                // No consensus engine is a standalone hub, not a lost round: nothing
                // was ever going to finalize here, so there is nothing to record.
                if (!this.oracleConsensus) return;
                if (this.chainTipFallbackActive) {
                    let lastGoodTip = this.lastSuccessfulChainTipFetchAt ?? this._startTime;
                    if ((Date.now() - lastGoodTip) > this.roundInterval) {
                        logger.error('Oracle: Skipping finalization for round ' + round +
                            '; chain-tip fallback active for >' + Math.round(this.roundInterval / 1000) +
                            's; btcBlockHeight anchor is unreliable, PRICE payload suppressed');
                        // storeSkippedRound emits 'round:skipped' once the row is
                        // durable, which is what advances the streak (item 4942); a
                        // local increment here would double-count a round whose fetch
                        // had already failed.
                        storeAnchorSkip(this, this.oracleConsensus, round, btcBlockHeight, btcBlockTime,
                            'chain-tip fallback active, anchor unreliable');
                        return;
                    }
                }
                // Skip a round-number anchor on a federated hub, even inside the first interval:
                // followers drop a PROPOSE pinned at a non-BTC height, so locking a snapshot there
                // only wastes the round. Single-node and regtest (quorum 0) keep the fallback.
                if (anchorIsRoundNumber && isFederated(this.oracleConsensus, this.hub.network, btcBlockHeight)) {
                    logger.warn('Oracle: Skipping finalization for round ' + round +
                        '; btcBlockHeight is the round-number fallback, not a BTC block, ' +
                        'and followers refuse a PROPOSE anchored there');
                    storeAnchorSkip(this, this.oracleConsensus, round, btcBlockHeight, btcBlockTime,
                        'round-number anchor on a federated hub');
                    return;
                }
                this.oracleConsensus.finalizeRound(round, btcBlockHeight, btcBlockTime).catch(err => {
                    logger.error(nodeUtil.format('Oracle: Finalization error for round ' + round + ':', err.message));
                    noteRoundLost({ phase: 'finalize', round, cause: 'finalize_rejected',
                        err: err && err.message ? err.message : String(err) });
                });
            } catch (err) {
                logger.error(nodeUtil.format('Oracle: Finalization threw for round ' + round + ':', err && err.message ? err.message : err));
                noteRoundLost({ phase: 'finalize', round, cause: 'finalize_threw',
                    err: err && err.message ? err.message : String(err) });
            }
        }, this.submissionWindow);
        this.finalizationTimers.set(round, timer);
    }

};
