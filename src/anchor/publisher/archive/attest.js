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
 * ANCHOR publisher - archive publisher-attestation round
 *
 * The archive leg's twin of the bundle attestation round, plus the flag-day
 * predicates that say which reward types the chain re-derives.
 *
 ********************************************************************/

'use strict';

const { bftQuorumOrSingle } = require('../../../lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('../../quorum_network.js');
const ValidatorIdentity = require('../../../validators/identity.js');
const swq = require('../../../stake_weighted_quorum.js');
const eq = require('../../../equivocation_header.js');
const ar = require('../../../anchor_reward_activation.js');
const { XANCARCHPUB_SIGN_REQ, XANCARCHPUB_SIGN } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();
const { ANCHOR_FLAG_DAY_REWARD_TYPES, ARCHIVE_FLAG_DAY_REWARD_TYPE } = require('../constants.js');

module.exports = {

    // Archive publisher-attestation canonical: the string the 2f+1 oracle_publish
    // quorum signs to ATTEST which validator earns the anchor_archive reward. MUST be
    // BYTE-IDENTICAL to the indexer's Anchor._rewardCanonical for FORMAT 1 (a divergence
    // forks the derived reward row). The amount is the FROZEN consensus constant
    // (ar.ARCHIVE_REWARD_AMOUNT, from the twin module, NOT the operator-tunable env). The
    // 'XANCPUB|archive|...' roundId is disjoint from every per-chain XANCPUB roundId, so
    // the two attestation families can never equivocation-collide.
    archiveAttestationCanonical(cp, batchSeq, publisher){
        let base = ['XANCPUB', 'anchor_archive', String(batchSeq),
                    String(cp.snapshot_block), String(publisher || '').toLowerCase(),
                    ar.ARCHIVE_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network)){
            let roundId = 'XANCPUB|archive|' + cp.network + '|' + batchSeq + '|' + cp.snapshot_block;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    },

    async archiveAttestationSigningSet(cp){
        // Same fail-closed resolver, same reason to degrade rather than propagate (see
        // runPublisherAttestationRound): this round is awaited in publishArchive AFTER
        // the wrapper co-sign quorum has already been collected, so a throw here discards
        // a completed round instead of publishing the count-0 head the archive's own
        // liveness note promises. Abstaining matches the snapCount === 0 branch below.
        let signingSet;
        try {
            signingSet = await this.resolveCapabilitySet('oracle_publish', Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));
        } catch(e){
            logger.warn('StateAnchorPublisher: oracle_publish set unresolvable at snapshot_block ' +
                         Number(cp.snapshot_block) + ' (' + (e && e.message) + '); abstaining from the ' +
                         'archive publisher-attestation round (ATTEST_SIG_COUNT 0, no reward) rather than ' +
                         'discarding the archive');
            return null;
        }
        return signingSet;
    },

    // Open the archive round on the wire and settle it, including the displaced-round
    // settlement that keeps a superseded publish from waiting forever.
    openArchiveAttestRound(cp, batchSeq, publisher, canonical, quorum, weighted, signingSet, signatures, me, mySig){
        return new Promise((resolve) => {
            let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
            // Preserve the truncation flag so the weighted quorum fails closed on an
            // over-cap oracle_publish snapshot (same reasoning as the v0 bundle round: a
            // fail-open would emit a tail whose reward the indexer drops).
            if(signingSet.truncated === true) roundValidators.truncated = true;
            let round = {
                cp, batchSeq, publisher, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            // Settle whatever this round displaces. The timer below is guarded on
            // `this._archiveAttestRound === round`, so a displaced round's timer no-ops
            // and checkArchiveAttestQuorum only ever looks at the live field: without
            // this, the publishArchive awaiting the displaced round waits forever. Same
            // shape as the stop() teardown. The archive leg is the reachable one: the v0
            // twin's caller runs only inside flush(), which _flushing serializes.
            let displaced = this._archiveAttestRound;
            if(displaced && !displaced.done){
                displaced.done = true;
                if(displaced.timer) clearTimeout(displaced.timer);
                logger.warn('StateAnchorPublisher: archive publisher-attestation round (batch ' +
                             displaced.batchSeq + ') displaced by batch ' + batchSeq +
                             '; settling it unattested so its publish is not stranded');
                if(displaced.resolve) displaced.resolve({ met: false, sigs: [] });
            }
            this._archiveAttestRound = round;
            round.timer = setTimeout(() => {
                // Fire on !round.done alone. A round that has been displaced is already
                // marked done above, so the identity check only ever cost the round that
                // still needed settling.
                if(!round.done){
                    round.done = true;
                    if(this._archiveAttestRound === round) this._archiveAttestRound = null;
                    logger.warn('StateAnchorPublisher: archive publisher-attestation round (batch ' + batchSeq +
                                 ') timed out at ' + round.signatures.size + '/' + quorum +
                                 ' sigs; ATTEST_SIG_COUNT 0 fallback');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })) });
                }
            }, this.roundTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            this.peerManager.broadcast(XANCARCHPUB_SIGN_REQ, {
                batch_seq: batchSeq, publisher: publisher, sig_pubkey: me, sig: mySig
            });
            this.checkArchiveAttestQuorum();
        });
    },

    // Run the archive publisher-attestation round for a batch THIS hub is publishing
    // (mirrors runPublisherAttestationRound for the archive leg). The signing/quorum set
    // is resolved at the wrapper checkpoint's snapshot_block, the SAME set the indexer
    // (anchor.js formats[1]) verifies the attestation against.
    // The oracle_publish set the archive round tallies against, or null when the
    // snapshot is unavailable and the round must abstain rather than discard the archive.
    async runArchiveAttestationRound(cp, batchSeq, publisher){
        if(!this.identity) return { met: false, sigs: [] };
        let signingSet = await this.archiveAttestationSigningSet(cp);
        if(!signingSet) return { met: false, sigs: [] };
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let weighted       = swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block), resolveQuorumNetwork(cp, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let me        = this.identity.getPubkeyHex().toLowerCase();
        let canonical = this.archiveAttestationCanonical(cp, batchSeq, publisher);
        let mySig     = this.identity.sign(canonical);

        // Unresolved (empty) set: abstain, exactly as the v0 bundle round does. Self-attesting
        // here would emit a v1 whose lone signature every indexer rejects while this hub
        // banks and archives the archive-anchor reward locally.
        if(snapCount === 0){
            logger.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(cp.snapshot_block) + '; abstaining from the archive publisher-attestation ' +
                         'round (ATTEST_SIG_COUNT 0, no reward) rather than self-attesting');
            return { met: false, sigs: [] };
        }
        // The publisher must itself hold oracle_publish at snapshot_block, or the indexer
        // drops the reward (PUBLISHER must be in the verified set). Fall back to a count-0
        // tail rather than emit an attestation whose reward can never be credited.
        if(!signingPubkeys.includes(me)) return { met: false, sigs: [] };

        let signatures = new Map();
        signatures.set(me, mySig);

        // Genuine single-node set (snapCount === 1, membership proven above).
        if(snapCount <= 1 || !this.peerManager)
            return { met: true, sigs: [{ pubkey: me, sig: mySig }], publisher: publisher };
        return await this.openArchiveAttestRound(cp, batchSeq, publisher, canonical, quorum, weighted, signingSet, signatures, me, mySig);
    },

    checkArchiveAttestQuorum(){
        let round = this._archiveAttestRound;
        if(!round || round.done) return;
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._archiveAttestRound = null;
        round.resolve({ met: true, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })), publisher: round.publisher });
    },

    // Follower: co-sign the ARCHIVE publisher attestation ONLY when the proposer is an
    // archive leader we OBSERVED pass the election/rank check for THIS batch_seq (the same
    // observed-leader authority handleFinalized trusts), the attestation binds the
    // proposer itself as the earner, and we hold oracle_publish at the batch's wrapper
    // snapshot_block. The canonical is rebuilt from OUR OWN stashed checkpoint identity
    // and the frozen ARCHIVE_REWARD_AMOUNT, so neither a wire-supplied snapshot_block nor
    // a wire-supplied amount can ever be co-signed.
    async handleArchiveAttestSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d) return;
        let myPubkey  = this.identity.getPubkeyHex().toLowerCase();
        let sender    = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;
        let publisher = String(d.publisher || '').toLowerCase();
        if(publisher !== sender) return;
        let batchSeq = Number(d.batch_seq);
        if(!Number.isFinite(batchSeq)) return;
        // Fail closed on an un-observed round: we only attest an archive election we
        // ourselves witnessed via its XANC_SIGN_REQ.
        if(!this.isObservedArchiveLeader(batchSeq, sender)) return;
        let id = this.observedArchiveCheckpoint(batchSeq);
        if(!id) return;
        // Resolve the stashed identity to OUR OWN state_checkpoints row (never the wire).
        let rows = await this.db.getStateCheckpointByChain(id.chain, id.network, Number(id.block_index), Number(id.checkpoint_seq));
        if(!rows || rows.length === 0) return;
        let cp = this.cpFromRow(rows[0]);
        // Only co-sign if WE hold oracle_publish at snapshot_block, or the indexer would
        // drop our attestation signature anyway.
        let eligible = await this._getActiveOraclePublishPubkeys(Number(cp.snapshot_block));
        if(eligible.length === 0 || !eligible.includes(myPubkey)) return;

        let canonical = this.archiveAttestationCanonical(cp, batchSeq, publisher);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;   // proposer's own sig

        this.peerManager.broadcast(XANCARCHPUB_SIGN, {
            batch_seq: batchSeq,
            sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    },

    async handleArchiveAttestSign(envelope){
        let d = envelope.data;
        let round = this._archiveAttestRound;
        if(!round || round.done || !d) return;
        if(Number(d.batch_seq) !== Number(round.batchSeq)) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this.checkArchiveAttestQuorum();
    },

    // The flag-day twin of isChainDerivedReward, for the pending-reward selector, which has
    // to apply eligibility BEFORE its LIMIT; db/validators.js
    // findArchivableAnchorRewardsBelowFlagDays turns these thresholds into the selector's
    // exclusion clause. Emitted from the same two constants the predicate reads, on the
    // sqlRoundQualifier precedent, so the two forms cannot disagree about which reward type
    // is judged against which flag-day.
    //
    // Thresholds are read HERE rather than cached on the instance: both maps are mutable
    // module state that configuration and tests re-pin. When either is not a finite
    // number the hub is unscoped or on an unknown network, which is exactly when
    // isChainDerivedReward answers false for everything, so this returns null and the
    // selector keeps its original unnarrowed form.
    derivedRewardFlagDays(){
        let anchorFlagDay  = Number(ar.ANCHOR_REWARD_ACTIVATION[this.network]);
        let archiveFlagDay = Number(ar.ARCHIVE_REWARD_ACTIVATION[this.network]);
        if(!Number.isFinite(anchorFlagDay) || !Number.isFinite(archiveFlagDay))
            return null;
        return { anchorFlagDay, archiveFlagDay };
    },

    // A validator_rewards row the indexer credits from on-chain bytes is not archive
    // cargo: anchor_<CHAIN>/anchor_bundle at/above ANCHOR_REWARD_ACTIVATION, anchor_archive
    // at/above ARCHIVE_REWARD_ACTIVATION, judged on the row's block_index and this hub's
    // network (an unscoped hub answers false and keeps archiving: costs DOGE, never a row).
    isChainDerivedReward(row){
        let type  = String(row && row.reward_type || '');
        // A row with no block_index is pre-upgrade local state; the selector's SQL
        // already excludes it, and Number(null) would read as height 0 here.
        if(!row || row.block_index === null || row.block_index === undefined || row.block_index === '') return false;
        let block = Number(row.block_index);
        if(!Number.isFinite(block)) return false;
        if(ANCHOR_FLAG_DAY_REWARD_TYPES.indexOf(type) !== -1)
            return ar.isAnchorRewardActive(block, this.network);
        if(type === ARCHIVE_FLAG_DAY_REWARD_TYPE)
            return ar.isArchiveRewardActive(block, this.network);
        return false;
    }

};
