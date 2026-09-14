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
 * XChain Hub - Slash Detector: non-participation, as a SlashDetector.prototype mixin.
 *
 * Missed rounds counted over a sliding round window per validator, one
 * non_participation proposal per crossing of the threshold, and the garbage
 * collection that bounds the per-validator maps to the known validator set.
 *
 ********************************************************************/

const { getLogger } = require('../../observability');
const logger = getLogger();

// One non_participation proposal for a validator whose windowed miss count has reached the
// threshold, with the once-per-crossing latch held across the write.
async function recordNonParticipation(detector, pubkey, entry, round) {
    let rate = ((entry.history.length - entry.missed) / entry.history.length).toFixed(4);
    logger.warn('Slash: Validator ' + pubkey.substring(0, 16) +
        '... missed ' + entry.missed + ' of the last ' + entry.history.length +
        ' rounds (participation rate ' + rate + ')');

    // Latch optimistically BEFORE the await, then re-arm if the write
    // failed. checkRound is driven by the un-serialized round:finalized
    // listener, so two overlapping finalizations could both read the
    // latch as false during the first call's DB round-trip and record a
    // duplicate proposal. Setting the latch first closes that TOCTOU
    // window while a failed write still re-arms for a retry next round.
    detector.nonParticipationFired.set(pubkey, true);
    let recorded = await detector.recordSlashProposal(pubkey, 'non_participation', round,
        JSON.stringify({
            missedRounds: entry.missed,
            windowRounds: entry.history.length,
            participationRate: rate
        })
    );
    if (!recorded) detector.nonParticipationFired.set(pubkey, false);
}

module.exports = {

    async checkParticipation(round, participants, allValidators) {
        if (!allValidators || allValidators.length === 0) return;

        // Drop tracking state for pubkeys no longer in the known validator set
        // before recording this round (SLASH-MAP-NO-GC-1). Without this the four
        // per-validator maps kept one entry per pubkey ever seen, so a key
        // rotation leaked an entry forever over the process lifetime.
        this.gcValidatorState(allValidators);

        let participantSet = new Set(participants);

        for (let v of allValidators) {
            let entry = this.participation.get(v.pubkey);
            if (!entry) {
                entry = { history: [], missed: 0 };
                this.participation.set(v.pubkey, entry);
            }

            // Record this round's outcome in the sliding window (true = missed).
            let missedThisRound = !participantSet.has(v.pubkey);
            entry.history.push(missedThisRound);
            if (missedThisRound) entry.missed++;
            if (entry.history.length > this.participationWindowSize) {
                if (entry.history.shift()) entry.missed--;
            }

            if (entry.missed < this.missedRoundsThreshold) {
                // Windowed miss count is back under the threshold: the validator
                // is genuinely participating again, so re-arm the latch. A single
                // token participation while the window stays saturated does NOT
                // reach here (that reset was the earlier evasion this window closes).
                this.nonParticipationFired.set(v.pubkey, false);
                continue;
            }

            // Fire once per crossing at or past the threshold. `>=` plus the
            // latch keeps a single proposal per crossing while staying
            // retry-safe: an exact `===` fired only at the precise count, so
            // a DB write that failed at the threshold (errors are swallowed
            // in recordSlashProposal) could never be retried and the offense
            // was lost. The latch is set only after the row persists.
            if (!this.nonParticipationFired.get(v.pubkey)) {
                await recordNonParticipation(this, v.pubkey, entry, round);
            }
        }
    },

    // Bound the per-validator tracking maps to the currently-known validator set
    // so a signing-key rotation does not leak a map entry per retired pubkey for
    // the process lifetime (SLASH-MAP-NO-GC-1). A pubkey is kept if it is in this
    // round's validator set OR still in the live peer registry: a deviating
    // validator is recorded via resolveValidatorPubkey off the registry and may
    // be known there before/without appearing in the round's `allValidators`, so
    // reconciling against the registry too never drops an active validator's
    // window. A dropped-then-returning validator simply restarts its window,
    // which only makes non-participation detection more lenient, never wrongful.
    gcValidatorState(allValidators) {
        let live = new Set();
        for (let v of allValidators) if (v && v.pubkey) live.add(v.pubkey);
        let pm = this.hub.getPeerManager && this.hub.getPeerManager();
        if (pm && pm.validatorPubkeys) {
            for (let pk of pm.validatorPubkeys.values()) if (pk) live.add(pk);
        }
        for (let map of [this.participation, this.recentDeviations,
                         this.repeatedDeviationFired, this.nonParticipationFired]) {
            for (let key of map.keys()) if (!live.has(key)) map.delete(key);
        }
    }
};
