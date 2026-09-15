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
 * XChain Hub - Full-Node Challenge Round: verifiers, claimants and the answer
 *
 * Who may sign and who may be verified, which of them leads, and the possession
 * answer plus the two digests a claim is made and checked with.
 *
 * src/consensus/full_node_challenge_round.js installs every method below on
 * FullNodeChallengeRound.prototype, non-enumerable like the class's own methods,
 * so callers and tests keep reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const crypto            = require('crypto');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Throttle for the truncated-verifier-set alarm. eligibleVerifiers runs once per
// poll tick (30s by default), so an unthrottled warning would emit thousands of
// times a day for one standing condition; an hour is loud enough to be seen and
// quiet enough to stay readable. Same idiom as CapabilitySnapshot.getQuorum.
const TRUNC_WARN_THROTTLE_MS = 3600000;

module.exports = {

    // scriptPubKey (hex) of a seed-selected output in the buried target block.
    async computeAnswer(target, seed){
        let blockHash = await this.coinCall('getblockhash', [Number(target)]);
        let block     = await this.coinCall('getblock', [blockHash, 2]);
        let txs = (block && block.tx) || [];
        if(txs.length === 0) throw new Error('empty target block');
        let txIndex = Number(BigInt('0x' + seed.slice(0, 16)) % BigInt(txs.length));
        let tx = txs[txIndex];
        let vouts = (tx && tx.vout) || [];
        if(vouts.length === 0) throw new Error('selected tx has no outputs');
        let voutIndex = Number(BigInt('0x' + seed.slice(16, 32)) % BigInt(vouts.length));
        let spk = vouts[voutIndex] && vouts[voutIndex].scriptPubKey;
        if(!spk || !spk.hex) throw new Error('no scriptPubKey at selected output');
        return String(spk.hex).toLowerCase();
    },

    // Signed canonical for an XNODE_ANSWER broadcast. Since R2-FN2 the second
    // field is the pubkey-bound answer DIGEST, never the plaintext answer.
    answerCanonical(challengeId, answerDigest){
        return 'XNODEANS|' + challengeId + '|' + String(answerDigest);
    },

    // R2-FN2: pubkey-bound possession digest. Binding the claimant's pubkey into
    // the hash makes every claimant's expected wire value distinct for the same
    // underlying answer, so knowledge of ANOTHER claimant's digest (public gossip)
    // is useless without the answer preimage, which only a real full node can
    // compute. Verifiers hold the preimage from their own node and recompute the
    // expected digest per claimant, so no reveal phase is needed.
    answerDigest(challengeId, pubkey, answer){
        return crypto.createHash('sha256')
            .update('XNODEANSV1|' + challengeId + '|' + String(pubkey).toLowerCase() + '|' + String(answer))
            .digest('hex');
    },

    // Returns the pubkey of the currently elected leader for `state`: the
    // verifier at the unlocked rank in the SHA256(challenge_id || pubkey) ordering.
    // Used by onSignReq to reject SIGN_REQ messages from non-leaders before
    // locking the passList.
    electedLeader(state){
        if(!state.eligible || state.eligible.size === 0) return null;
        let ranked = Array.from(state.eligible).map(pk => ({
            pk, h: crypto.createHash('sha256').update(state.challengeId).update(pk).digest('hex')
        })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
        let unlockedRank = Math.min(state.leadRank || 0, ranked.length - 1);
        return ranked[unlockedRank] ? ranked[unlockedRank].pk : null;
    },

    // Elected leader = lowest SHA256(challenge_id || pubkey) among eligible
    // verifiers, with a simple elapsed-time failover ladder (the next-ranked
    // verifier takes over a collection window later if no verdict has landed).
    isLeader(state, myPubkey){
        if(!myPubkey || !state.eligible.has(myPubkey)) return false;
        let ranked = Array.from(state.eligible).map(pk => ({
            pk, h: crypto.createHash('sha256').update(state.challengeId).update(pk).digest('hex')
        })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
        let myRank = ranked.findIndex(r => r.pk === myPubkey);
        if(myRank < 0) return false;
        // Rank 0 leads at the chain-anchored close; if no verdict lands, each further
        // closeDepth of chain height promotes the next rank as a failover (chain-based
        // so all hubs agree on who leads, escalated in tick via state.leadRank).
        let unlockedRank = Math.min(state.leadRank || 0, ranked.length - 1);
        return myRank === unlockedRank;
    },

    // Eligible verifiers at the epoch block: verified full nodes (from the
    // indexer) union configured genesis verifiers. Matches the indexer's acceptance
    // rule in nodeproof.js so a quorum the hub assembles is one the chain accepts.
    //
    // CONSENSUS-CRITICAL: the returned set is the domain of leader election
    // (electedLeader / isLeader) and the 2/3+1 quorum denominator (maybeFinalize).
    // On an UNRESOLVED set (any indexer RPC failure: 401 / timeout / transport) this
    // returns null so the caller ABSTAINS (skips the epoch), rather than degrading to
    // the genesis-only subset. A per-hub, reachability-dependent fallback would split
    // the federation's view of the member list across honest hubs (divergent leader /
    // quorum -> duplicate or stalled on-chain NODEPROOF verdicts). This fails CLOSED,
    // matching claimantSet in this file and the StateAnchorPublisher / CrossChainEngine
    // siblings; it trades liveness on a prolonged indexer outage for cross-hub safety.
    // The legitimate genesis-only path (a genuinely genesis-only federation) is on the
    // SUCCESS branch, where the indexer returns an empty validators list; only the
    // error-degradation path changes.
    async eligibleVerifiers(epoch){
        let set = new Set(this.genesis);
        try {
            let verified = await this.indexerCall('getfullnodeverifiers', { block_index: epoch });
            // Alarm-and-proceed on a TRUNCATED verifier set. getfullnodeverifiers carries
            // `truncated` precisely so a hub can say so (it is set when the indexer's read
            // hit VALIDATOR_QUERY_LIMIT), and this set is the 2/3+1 quorum denominator and
            // the leader-election domain: consumed silently, a cap lowers the quorum bar
            // with no operator signal at all. We still proceed rather than abstain, because
            // every indexer truncates identically at the same block, so the capped set
            // stays cross-hub deterministic; refusing would halt the round the moment the
            // verifier set outgrows the cap, which is the worse failure. Throttled, since
            // this runs once per poll tick. Same shape as CapabilitySnapshot.getQuorum.
            if (verified && verified.truncated === true){
                let now = Date.now();
                if (now - this._truncWarnAt > TRUNC_WARN_THROTTLE_MS){
                    this._truncWarnAt = now;
                    logger.error('FullNodeChallengeRound: eligibleVerifiers: the indexer returned a TRUNCATED ' +
                        'verified-full-node set at epoch ' + epoch + ' (' +
                        ((verified.validators && verified.validators.length) || 0) + ' verifier(s) returned): it hit ' +
                        'VALIDATOR_QUERY_LIMIT, so the eligible set is CAPPED below the true verifier universe and the ' +
                        '2/3+1 quorum denominator is a floor, not the real N. The round still runs (every indexer ' +
                        'truncates identically, so the capped set is cross-hub deterministic); raise the frozen ' +
                        'VALIDATOR_QUERY_LIMIT consensus constant on the indexers (coordinated fleet upgrade).');
                }
            }
            let list = (verified && verified.validators) || [];
            for(let v of list){
                let pk = String(v.pubkey || v).toLowerCase();
                if(/^[0-9a-f]{64}$/.test(pk)) set.add(pk);
            }
        } catch(err){
            let status = err && err.response && err.response.status;
            if (status === 401)
                logger.warn('FullNodeChallengeRound: eligibleVerifiers: 401 Unauthorized from indexer (misconfigured API key?); ABSTAINING (skip epoch), NOT degrading to genesis-only');
            else
                logger.warn('FullNodeChallengeRound: eligibleVerifiers: RPC error (absent/old indexer or transport failure: ' + (err && err.message) + '); ABSTAINING (skip epoch), NOT degrading to genesis-only');
            return null;
        }
        return set;
    },

    // Claimant universe = validators holding the full_node capability at the
    // epoch block (the block-boundary snapshot every hub locks identically).
    //
    // CONSENSUS-CRITICAL: mirrors eligibleVerifiers. capabilitySnapshot.getSnapshot
    // signals every UNRESOLVED state (transport error, 401/403, malformed shape,
    // block-echo mismatch, unconfigured MIN_STAKE against a live registry) by
    // returning null, never by throwing, so the catch below is a backstop, not the
    // primary path. On an unresolved snapshot this returns null so the caller
    // ABSTAINS (skips the epoch) rather than degrading to an EMPTY claimant set:
    // an empty set would let two honest hubs lock different (full_node, epoch)
    // universes (leader broadcasts no XNODE_SIGN_REQ / verifier rejects the
    // legitimate list as outsiders), the exact divergence this lock exists to
    // prevent. A legitimately empty snapshot is distinguished by a real validators
    // array (coerceValidators guarantees one on the SUCCESS branch) and still
    // yields a real, empty Set. This fails CLOSED, trading liveness on a prolonged
    // snapshot outage for cross-hub safety.
    async claimantSet(epoch){
        let set = new Set();
        try {
            let snap = await this.capabilitySnapshot.getSnapshot('full_node', epoch);
            if(!snap || !Array.isArray(snap.validators)){
                logger.warn('FullNodeChallengeRound: claimantSet: capability snapshot unresolved for full_node at epoch=' + epoch + '; ABSTAINING (skip epoch), NOT degrading to an empty claimant set');
                return null;
            }
            for(let v of snap.validators){
                let pk = String(v.pubkey || v).toLowerCase();
                if(/^[0-9a-f]{64}$/.test(pk)) set.add(pk);
            }
        } catch(err){
            let status = err && err.response && err.response.status;
            if (status === 401)
                logger.warn('FullNodeChallengeRound: claimantSet: 401 Unauthorized from capability snapshot (misconfigured API key?); ABSTAINING (skip epoch)');
            else
                logger.warn('FullNodeChallengeRound: claimantSet: snapshot error (' + (err && err.message) + '); ABSTAINING (skip epoch)');
            return null;
        }
        return set;
    }
};
