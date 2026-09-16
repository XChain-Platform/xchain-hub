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
 * XChain Hub - Full-Node Challenge Round: the tick and the epoch
 *
 * When a round exists: the poll that opens, closes and prunes rounds by chain
 * height, and the epoch run that derives the challenge and answers it.
 *
 * src/consensus/full_node_challenge_round.js installs every method below on
 * FullNodeChallengeRound.prototype, non-enumerable like the class's own methods,
 * so callers and tests keep reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const crypto            = require('crypto');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const { XNODE_ANSWER } = require('./message_types.js');

// A fresh round record for one epoch: the derived challenge, the two locked
// populations, and the empty answer, signature and verdict slots the round fills.
function newEpochState(ctx){
    let { epoch, target, seed, challengeId, eligible, claimants } = ctx;
    return {
        epoch, target, seed, challengeId,
        eligible, claimants,
        answers: new Map(),     // pubkey -> answer hex
        sigs:    new Map(),     // pubkey -> sig hex (over the canonical PASS list)
        passList: null,
        myAnswer: null,
        finalized: false,
        closed: false,
        leadRank: 0,
        startedAt: Date.now(),
        txid: null,
    };
}

// Compute our own answer if we can: a CLAIMANT (proving itself) or an
// eligible VERIFIER (needs the answer to lead a round and to confirm peers).
// Only a claimant BROADCASTS it as its own possession claim; a verifier that
// isn't also a claimant computes silently so it can still lead/verify. A
// light mirror has no coin RPC and stays silent on both counts.
//
// Null when this hub computes no answer for the epoch. Synchronous so runEpoch
// awaits only the computation itself: a hub with nothing to compute reaches the
// round's log line in the same turn that opened the round.
function ownAnswerRole(self, state, myPubkey){
    let amClaimant = !!(myPubkey && state.claimants.has(myPubkey));
    let amVerifier = !!(myPubkey && state.eligible.has(myPubkey));
    if(myPubkey && self.coinRpcUrl && (amClaimant || amVerifier)) return { amClaimant };
    return null;
}

// R2-FN2: broadcast (and store) the pubkey-bound digest, never
// the plaintext answer. `answers` holds digests for every
// claimant including self, so the leader/verifier comparison
// paths treat self and peers identically.
function broadcastOwnAnswer(self, state, myPubkey){
    let { epoch, challengeId } = state;
    let digest = self.answerDigest(challengeId, myPubkey, state.myAnswer);
    state.answers.set(myPubkey, digest);
    let sig = self.identity.sign(self.answerCanonical(challengeId, digest));
    self.peerManager && self.peerManager.broadcast(XNODE_ANSWER, {
        epoch, challengeId, answer_digest: digest, sig_pubkey: myPubkey, sig
    });
}

module.exports = {

    async tick(){
        if(this.interval <= 0) return;
        // In-flight guard (house convention, mirrors StateCheckpointEngine.tick).
        // A tick makes up to three sequential indexerCall round trips at a 15s
        // timeout each, against a 30s poll: under a slow indexer the next interval
        // fires while this one is still awaiting. Two overlapping ticks would both
        // pass the rounds.has(epoch) test below before either reached the
        // rounds.set() inside runEpoch (two more awaits later), starting one epoch
        // twice: duplicate XNODE_ANSWER broadcasts and a second rounds.set that
        // clobbers the first run's accumulated answers/signatures. The finally is
        // load-bearing: a rejected indexer call must not wedge the flag forever.
        if(this._ticking) return;
        this._ticking = true;
        try {
            let tip = await this.indexerCall('getblockhashes', {});
            let tipBlock = tip && tip.block_index != null ? Number(tip.block_index) : null;
            if(tipBlock == null) return;

            // Close (and eventually prune) open rounds by CHAIN HEIGHT: every hub closes
            // a round at the same chain point (tip >= epoch + closeDepth), regardless of
            // when it locally detected the epoch, so the leader has collected every
            // claimant's answer (which were all broadcast within ~1 block of the epoch).
            for(let [e, st] of this.rounds){
                if(!st.finalized && tipBlock >= e + this.closeDepth){
                    // Chain-based leader failover: rank 0 leads at the close point; each
                    // further closeDepth of height with no verdict promotes the next rank.
                    let rank = Math.floor((tipBlock - (e + this.closeDepth)) / Math.max(1, this.closeDepth));
                    if(!st.closed || rank > st.leadRank){
                        st.closed = true;
                        st.leadRank = rank;
                        this.closeCollection(e).catch(err => logger.warn(nodeUtil.format('FullNodeChallengeRound close:', err && err.message)));
                    }
                }
                if((tipBlock - e) > (this.acceptWindow + this.closeDepth + this.interval)) this.rounds.delete(e);
            }

            // The most recent epoch boundary that is both buried enough for a stable
            // target block and still inside the verdict-acceptance window.
            let epoch = Math.floor(tipBlock / this.interval) * this.interval;
            if(epoch < this.confirmDepth) return;                 // target would be < genesis
            if((tipBlock - epoch) > this.acceptWindow) return;    // too late to land a verdict this epoch
            if(this.rounds.has(epoch)) return;                    // already running/finalized
            await this.runEpoch(epoch, tipBlock);
        } finally {
            this._ticking = false;
        }
    },

    async runEpoch(epoch, tipBlock){
        let bh = await this.indexerCall('getblockhashes', { block_index: epoch });
        if(!bh || !bh.ledger_hash){ return; }
        let seed   = String(bh.ledger_hash);
        let target = epoch - this.confirmDepth;
        let challengeId = crypto.createHash('sha256')
            .update(String(this.network) + ':' + epoch + ':' + seed + ':' + target).digest('hex');

        // Set<pubkey>: who may SIGN / who may be verified
        let eligible  = await this.eligibleVerifiers(epoch);
        // Unresolved eligible set (indexer RPC failure): ABSTAIN for this epoch
        // rather than run on a per-hub-divergent member list. No round state is
        // created, so this hub neither elects/claims leadership, signs, nor
        // broadcasts a verdict; a later tick re-attempts once the indexer recovers
        // (while still inside the verdict-accept window).
        if(eligible === null){
            logger.warn('FullNodeChallengeRound: epoch=' + epoch + ' skipped (eligible-verifier set unresolved; abstaining rather than running on a genesis-only subset)');
            return;
        }
        let claimants = await this.claimantSet(epoch);
        // Unresolved claimant set (capability-snapshot failure): ABSTAIN for this
        // epoch alongside the eligible-set gate above, rather than lock an empty
        // (full_node, epoch) universe that diverges from hubs whose snapshot resolved.
        if(claimants === null){
            logger.warn('FullNodeChallengeRound: epoch=' + epoch + ' skipped (claimant set unresolved; abstaining rather than locking an empty full_node set)');
            return;
        }
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;

        let state = newEpochState({ epoch, target, seed, challengeId, eligible, claimants });
        this.rounds.set(epoch, state);

        let role = ownAnswerRole(this, state, myPubkey);
        if(role){
            try {
                state.myAnswer = await this.computeAnswer(target, seed);
                if(role.amClaimant) broadcastOwnAnswer(this, state, myPubkey);
            } catch(e){
                logger.warn(nodeUtil.format('FullNodeChallengeRound: own answer failed (epoch ' + epoch + '):', e && e.message ? e.message : e));
            }
        }

        logger.info('FullNodeChallengeRound: epoch=' + epoch + ' challenge=' + challengeId.substring(0,16) +
                    '... target=' + target + ' eligible=' + eligible.size + ' claimants=' + claimants.size +
                    ' leader=' + (this.isLeader(state, myPubkey) ? 'me' : 'peer'));

        // Collection closes from tick once the tip reaches epoch + closeDepth
        // (chain-anchored); the leader then proposes the PASS list and every node
        // evaluates window-based pass-rate eligibility. No wall-clock timer: a hub that detects
        // the epoch earlier must not close before peers (on a slightly later poll)
        // have broadcast their answers.
    }
};
