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
const { nominalRoundSeconds } = require('../consensus/round_time/round_time');
const { roundTimeGateActive } = require('../consensus/round_time/round_time_gate');
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

// True when the consensus engine reports a peer quorum, the same federation test
// the follower uses before refusing a PROPOSE with no real BTC height.
function isFederated(consensus) {
    return typeof consensus.getQuorum === 'function' && consensus.getQuorum() > 0;
}

// Store the round's durable skipped row instead of finalizing it; a rejected
// write still leaves a round_lost record rather than only a prose error line.
function storeAnchorSkip(consensus, round, btcBlockHeight, btcBlockTime, reason) {
    consensus.storeSkippedRound(round, btcBlockHeight, btcBlockTime, reason).catch(err => {
        logger.error(nodeUtil.format('Oracle: Failed to store skipped round ' + round + ':', err.message));
        noteRoundLost({ phase: 'finalize', round, cause: 'skip_store_rejected',
            err: err && err.message ? err.message : String(err) });
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
                        storeAnchorSkip(this.oracleConsensus, round, btcBlockHeight, btcBlockTime,
                            'chain-tip fallback active, anchor unreliable');
                        return;
                    }
                }
                // Skip a round-number anchor on a federated hub, even inside the first interval:
                // followers drop a PROPOSE pinned at a non-BTC height, so locking a snapshot there
                // only wastes the round. Single-node and regtest (quorum 0) keep the fallback.
                if (anchorIsRoundNumber && isFederated(this.oracleConsensus)) {
                    logger.warn('Oracle: Skipping finalization for round ' + round +
                        '; btcBlockHeight is the round-number fallback, not a BTC block, ' +
                        'and followers refuse a PROPOSE anchored there');
                    storeAnchorSkip(this.oracleConsensus, round, btcBlockHeight, btcBlockTime,
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
