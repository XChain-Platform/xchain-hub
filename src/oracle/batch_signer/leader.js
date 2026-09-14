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
 * XChain Hub - PRICE batch-signing round: the leader side
 *
 * Assembling one window's canonical bytes, sizing the quorum from the
 * price-capable set AT THE BATCH ANCHOR (the same set and anchor the indexer
 * resolves the wire against), and holding the round open until that quorum
 * co-signs or the timeout expires. A round that falls short returns met:false
 * and the window stays unpublished for a later leader to re-propose.
 *
 ********************************************************************/

'use strict';

const swq = require('../../stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { PRICE_BATCH_MAX_ROUND_COUNT } = require('../../price_batch_compression.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ---------------------------------------------------------------- leader

    // Run the batch-signing round for a window THIS hub is publishing.
    //
    // `rounds` is the canonical builder's input shape,
    // [{ round, timestamp, btcBlockHeight, pairs:[{pair|coinPair, price}] }].
    //
    // Resolves { met, sigs:[{pubkey,sig}], firstRound, lastRound, btcBlockHeight,
    // canonical } once a BFT quorum of the price-capable set AT THE BATCH ANCHOR
    // has co-signed, or { met:false } on timeout / short quorum / an unresolvable
    // set. On met:false the caller publishes NOTHING for this window: the sigs
    // collected so far are returned for observability only, never for a wire.
    async collectBatchSignatures(firstRound, lastRound, btcBlockHeight, rounds){
        let first  = parseInt(firstRound);
        let last   = parseInt(lastRound);
        let anchor = parseInt(btcBlockHeight);
        let empty  = { met: false, sigs: [], firstRound: first, lastRound: last, btcBlockHeight: anchor };

        if(!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(anchor) ||
           first < 0 || last < first) return empty;
        if(!Array.isArray(rounds) || rounds.length === 0 || rounds.length > PRICE_BATCH_MAX_ROUND_COUNT) return empty;
        if(!this.identity) return empty;

        this.stats.batchSignRounds++;

        let canonical = this.leaderCanonical(first, last, anchor, rounds);
        if(canonical === null) return empty;

        // The SIGNING set is the price-capable set at the BATCH ANCHOR, which is the
        // same set (and the same anchor) the indexer's _parseV0 resolves the wire's
        // quorum against. Resolving it anywhere else would let this hub collect a
        // quorum the chain then rejects, spending a DOGE fee for an invalid action.
        let signingSet;
        try {
            signingSet = await this.resolvePriceSet(anchor);
        } catch(e){
            logger.warn('OracleBatchSigner: price capability set unresolvable at anchor ' + anchor +
                         ' (' + (e && e.message) + '); no batch for window [' + first + ',' + last + ']');
            return empty;
        }

        let me = this.leaderInSigningSet(signingSet, anchor, first, last);
        if(me === null) return empty;
        let snapCount = signingSet.length;

        let mySig      = this.identity.sign(canonical);
        let signatures = new Map();
        signatures.set(me, mySig);

        // Genuine single-member set (membership proven above): this hub's own
        // signature IS the quorum, matching bftQuorumOrSingle's single-node bypass.
        if(snapCount <= 1 || !this.peerManager){
            this.stats.batchSignQuorums++;
            return { met: true, sigs: [{ pubkey: me, sig: mySig }],
                     firstRound: first, lastRound: last, btcBlockHeight: anchor, canonical: canonical };
        }

        return await this.openSignRound({ first, last, anchor, canonical, signingSet, snapCount,
                                          signatures, rounds });
    },

    // The ONE canonical builder's bytes for this window, or null when the engine that
    // owns it is not up. Every caller treats null as "no batch for this window".
    leaderCanonical(first, last, anchor, rounds){
        try {
            return this._canonical(first, last, anchor, rounds);
        } catch(e){
            logger.warn('OracleBatchSigner: cannot build the batch canonical for window [' + first + ',' + last +
                         '] (' + (e && e.message) + '); no batch for this window');
            return null;
        }
    },

    // This hub's own pubkey when it may lead this round, null when it may not.
    //
    // An unresolved (empty) set is not a quorum of one. Self-signing there would
    // emit a wire carrying a single signature that every indexer rejects, because
    // the indexer resolves a non-empty set at the same anchor. Withhold instead:
    // the rounds are still in the buffer and a later window re-proposes them.
    leaderInSigningSet(signingSet, anchor, first, last){
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let me             = this.identity.getPubkeyHex().toLowerCase();
        if(signingPubkeys.length === 0){
            logger.warn('OracleBatchSigner: zero price-capable validators at anchor ' + anchor +
                         '; withholding the batch for window [' + first + ',' + last + ']');
            return null;
        }
        // This hub must itself hold `price` at the anchor, or its own signature is
        // not counted by the verifier and the quorum arithmetic above is fiction.
        if(!signingPubkeys.includes(me)) return null;
        return me;
    },

    // Broadcast the request and hold the round open. Deliberately synchronous down to
    // the Promise executor: the request must leave in the same turn the round is
    // registered, or a fast peer's XPRICEB_SIGN arrives before there is a round to
    // count it against.
    openSignRound({ first, last, anchor, canonical, signingSet, snapCount, signatures, rounds }){
        return new Promise((resolve) => {
            let weighted = swq.isStakeWeightedQuorumActive(anchor, this.network);
            let quorum   = bftQuorumOrSingle(snapCount, 1);
            let roundValidators = signingSet.map(v => ({
                pubkey: v.pubkey,
                source: String(v.source != null ? v.source : ''),
                weight: String(v.amount != null ? v.amount : '0')
            }));
            // Carry the truncation flag through so meetsStakeThreshold fails CLOSED on
            // an over-cap snapshot, identical to the XANCPUB rounds. Without it a
            // truncated set under-counts total stake and a stake-evicted minority
            // could clear the 2/3 bar here while the indexer's own check rejects it.
            if(signingSet.truncated === true) roundValidators.truncated = true;

            let round = {
                first, last, anchor, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            this._signRound = round;
            round.timer = setTimeout(() => {
                if(this._signRound === round && !round.done){
                    round.done = true;
                    this._signRound = null;
                    this.stats.batchSignTimeouts++;
                    logger.warn('OracleBatchSigner: batch-signing round for window [' + first + ',' + last +
                                 '] at anchor ' + anchor + ' timed out at ' + round.signatures.size + '/' +
                                 quorum + ' sigs; window stays unpublished');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })),
                              firstRound: first, lastRound: last, btcBlockHeight: anchor });
                }
            }, this.signTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            // The request carries the exact canonical INPUT, not the canonical bytes:
            // peers must rebuild those from their own state, and shipping the bytes
            // would invite a peer to sign what it was handed.
            this.peerManager.broadcast(this.constructor.XPRICEB_SIGN_REQ, {
                first_round:      first,
                last_round:       last,
                btc_block_height: anchor,
                rounds:           rounds
            });
            this.checkSignQuorum();
        });
    },

};
