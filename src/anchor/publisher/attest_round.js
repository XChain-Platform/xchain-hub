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
 * ANCHOR publisher - bundle publisher-attestation round
 *
 * The 2f+1 oracle_publish quorum attesting who earned a bundle's reward, carried
 * in the v0 tail so the indexer derives the reward instead of trusting a push.
 *
 ********************************************************************/

'use strict';

const StateAnchorPublisher = require('../publisher.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { resolveQuorumNetwork } = require('../quorum_network.js');
const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../stake_weighted_quorum.js');
const eq = require('../../equivocation_header.js');
const ar = require('../../anchor_reward_activation.js');
const { XANCPUB_SIGN_REQ, XANCPUB_SIGN } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Publisher-attestation canonical (XANCPUB): the string the 2f+1 oracle_publish quorum
    // signs to ATTEST which validator earns the anchor reward. MUST be BYTE-IDENTICAL to the
    // indexer's Anchor._rewardCanonical (a divergence forks the derived reward row). The
    // amount is the FROZEN consensus constant (ar.ANCHOR_REWARD_AMOUNT, read from the twin
    // module, NOT the operator-tunable ANCHOR_REWARD_PER_PUBLISH env). The EQUIV wrapper uses
    // the bundle's NETWORK (b.network) like _canonical/archiveCanonical, NOT this.network,
    // and a distinct 'XANCPUB|...' roundId gives the attestation its own equivocation family so
    // a validator that signs both the checkpoint root canonical and this reward attestation in
    // the same round is never falsely slashable.
    //
    // SIX positional fields, unchanged in COUNT from the retired per-chain form (D22):
    // slash.js reads snapshot_block at field index 3 for every XANCPUB family, so a
    // five-field bundle canonical would have made every bundle equivocation read
    // 'invalid: snapshot_block'. Field 2 is round_reference, which for a bundle IS the
    // snapshot block, hence the repeat.
    //
    //   XANCPUB|anchor_bundle|SNAPSHOT_BLOCK|SNAPSHOT_BLOCK|PUBLISHER|ANCHOR_REWARD_AMOUNT
    //
    // The roundId 'XANCPUB|bundle|NETWORK|SNAPSHOT_BLOCK' is disjoint from the archive
    // family ('XANCPUB|archive|...'), so the two can never equivocation-collide.
    _attestationCanonical(b, publisher){
        let base = ['XANCPUB', 'anchor_bundle', String(b.snapshot_block),
                    String(b.snapshot_block), String(publisher || '').toLowerCase(),
                    ar.ANCHOR_REWARD_AMOUNT].join('|');
        if(eq.isEquivHeaderActive(b.snapshot_block, b.network)){
            let roundId = 'XANCPUB|bundle|' + b.network + '|' + b.snapshot_block;
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
        }
        return base;
    },

    // Run the publisher-attestation round for a BUNDLE this hub is publishing (spec §2.5).
    // Resolves { met, sigs:[{pubkey,sig}], publisher } once a 2f+1 oracle_publish quorum
    // (stake-weighted at/above STAKE_WEIGHTED_QUORUM, else count) co-signs XANCPUB, or
    // { met:false } on timeout / short quorum. ONE round per bundle, where the retired
    // per-chain path ran one per row. The SIGNING/QUORUM set is resolved at the bundle's
    // snapshot_block, the SAME set the indexer (anchor.js) verifies the attestation
    // against, so the hub never collects a quorum the chain then rejects.
    async runPublisherAttestationRound(b, publisher){
        if(!this.identity) return { met: false, sigs: [] };

        // _resolveCapabilitySet FAILS CLOSED off regtest (it throws when the
        // deterministic snapshot is unavailable), which is right for the callers that
        // must not build on a divergent set. Here it would abort the whole anchor: this
        // round is awaited inside publishBundle, whose catch only logs the failure and
        // drops the bundle, so a transient snapshot outage would withhold the ANCHOR
        // itself rather than just its reward. Degrade instead, byte-identically to the
        // snapCount === 0 abstain below: no attestation, a v0 with ATTEST_SIG_COUNT 0
        // lands, no reward is recorded. Scoped to the resolve call only, so an unrelated
        // throw inside the round still surfaces.
        let signingSet;
        try {
            signingSet = await this._resolveCapabilitySet('oracle_publish', Number(b.snapshot_block), resolveQuorumNetwork(b, this.network));
        } catch(e){
            logger.warn('StateAnchorPublisher: oracle_publish set unresolvable at snapshot_block ' +
                         Number(b.snapshot_block) + ' (' + (e && e.message) + '); abstaining from the ' +
                         'publisher-attestation round (unattested bundle, no reward) rather than blocking the anchor');
            return { met: false, sigs: [] };
        }
        let signingPubkeys = signingSet.map(v => v.pubkey);
        let snapCount      = signingPubkeys.length;
        let weighted       = swq.isStakeWeightedQuorumActive(Number(b.snapshot_block), resolveQuorumNetwork(b, this.network));   // gate on the RECORD network to match the indexer
        let quorum         = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let me        = this.identity.getPubkeyHex().toLowerCase();
        let canonical = this._attestationCanonical(b, publisher);
        let mySig     = this.identity.sign(canonical);

        // An UNRESOLVED (empty) signing set is not a quorum of one: abstain. The rest of
        // this file fails closed on an unresolved set, and the two resolvers used across
        // one round can legitimately disagree (_getActiveOraclePublishPubkeys reads the
        // capability snapshot, _resolveCapabilitySet may take the weighted one), so a
        // hub can pass the eligible.length fail-closed gate in _publishPendingCheckpoints
        // and still resolve snapCount 0 here. Self-attesting on that would emit a v0
        // carrying one signature that every indexer rejects (it resolves a non-empty set),
        // while THIS hub banks and archives an anchor reward no live indexer credits: the
        // live-vs-recovered ledger fork the reward gates exist to prevent. An unattested
        // bundle is degraded, not divergent.
        if(snapCount === 0){
            logger.warn('StateAnchorPublisher: unresolved oracle_publish set at snapshot_block ' +
                         Number(b.snapshot_block) + '; abstaining from the publisher-attestation round ' +
                         '(unattested bundle, no reward) rather than self-attesting');
            return { met: false, sigs: [] };
        }
        // The publisher must itself hold oracle_publish at snapshot_block, or the indexer
        // drops the reward (PUBLISHER must be in the verified set). Fall back to an
        // unattested bundle rather than emit one whose reward can never be credited.
        if(!signingPubkeys.includes(me)) return { met: false, sigs: [] };

        let signatures = new Map();
        signatures.set(me, mySig);

        // Genuine single-node set (snapCount === 1, membership proven above): the
        // publisher's own attestation IS the quorum.
        if(snapCount <= 1 || !this.peerManager)
            return { met: true, sigs: [{ pubkey: me, sig: mySig }], publisher: publisher };

        return await new Promise((resolve) => {
            // Full {pubkey, source, weight} set so the stake-weighted tally can sum
            // distinct-source stake, identical to the archive round.
            let roundValidators = signingSet.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.amount != null ? v.amount : '0') }));
            // Preserve the truncation flag so the weighted reward quorum
            // (checkAttestQuorum via meetsStakeThreshold) fails closed on an over-cap
            // oracle_publish snapshot, identical to the archive round. Without this the
            // publisher-attestation quorum fail-OPENS on a truncated set, emitting a v0
            // whose reward the indexer would drop (stranded credit).
            if(signingSet.truncated === true) roundValidators.truncated = true;
            let round = {
                bundle: b, publisher, canonical, quorum, weighted, resolve,
                validators: roundValidators,
                signatures, done: false, timer: null
            };
            this._attestRound = round;
            round.timer = setTimeout(() => {
                if(this._attestRound === round && !round.done){
                    round.done = true;
                    this._attestRound = null;
                    logger.warn('StateAnchorPublisher: publisher-attestation round (bundle ' + b.network + ' @ ' +
                                 b.snapshot_block + ') timed out at ' + round.signatures.size + '/' + quorum +
                                 ' sigs; unattested fallback');
                    resolve({ met: false, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })) });
                }
            }, this.roundTimeoutMs);
            if(round.timer.unref) round.timer.unref();

            // The followers re-derive everything; the wire carries identity plus the BODY
            // they byte-match their own rebuild against (§2.5). `body` is the v0 with an
            // EMPTY attestation tail, which is exactly the part a follower can reproduce
            // from its own state_checkpoints rows before any signature exists.
            this.peerManager.broadcast(XANCPUB_SIGN_REQ, {
                network: String(b.network), snapshot_block: Number(b.snapshot_block),
                sections: b.sections.map(s => ({ chain: String(s.chain), block_index: Number(s.block_index),
                                                 checkpoint_seq: Number(s.checkpoint_seq) })),
                body: this._buildV7Payload(b.sections, publisher, []),
                publisher: publisher, sig_pubkey: me, sig: mySig
            });
            this.checkAttestQuorum();
        });
    },

    checkAttestQuorum(){
        let round = this._attestRound;
        if(!round || round.done) return;
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._attestRound = null;
        round.resolve({ met: true, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })), publisher: round.publisher });
    },

    // Follower: co-sign the BUNDLE publisher attestation ONLY when the proposer is the
    // legitimately rank-unlocked publisher of a bundle that BYTE-MATCHES the one we
    // rebuild from our own state_checkpoints rows, and we ourselves hold oracle_publish
    // at its snapshot_block. The frozen amount is enforced implicitly: we rebuild the
    // canonical with ar.ANCHOR_REWARD_AMOUNT, so a wire-supplied amount can never be
    // co-signed.
    async handleAttestSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !d || !Array.isArray(d.sections) || d.sections.length === 0) return;
        let network       = String(d.network || '');
        let snapshotBlock = Number(d.snapshot_block);
        if(!network || !Number.isFinite(snapshotBlock)) return;
        let myPubkey  = this.identity.getPubkeyHex().toLowerCase();
        let sender    = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;
        // The publisher attests ITSELF: the proposer must be the rewarded publisher, or it
        // is binding a pubkey it is not entitled to.
        let publisher = String(d.publisher || '').toLowerCase();
        if(publisher !== sender) return;

        // Re-run the BUNDLE publisher election (oracle_publish @ snapshot_block,
        // hash-ordered by the bundle election key) and confirm the proposer is
        // rank-unlocked on the SAME failover ladder publishBundle used, bounded to our own
        // BTC tip (anti-spam; the binding security is the byte-match below).
        let eligible = await this._getActiveOraclePublishPubkeys(snapshotBlock);
        if(eligible.length === 0) return;
        {
            // Run the ladder check for EVERY set size: a single-member set must
            // still bind sender === eligible[0] (rank 0), or any current member
            // could impersonate the sole elected publisher.
            let order = StateAnchorPublisher.hashOrder(
                this._bundleElectionKey({ network: network, snapshot_block: snapshotBlock }), eligible);
            let myBtc = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
            let since = Number.isFinite(myBtc) ? myBtc - snapshotBlock : null;
            if(!this._rankUnlocked(order, sender, since)) return;          // proposer not unlocked
        }
        // Only co-sign if WE hold oracle_publish at snapshot_block, or the indexer would drop
        // our attestation signature anyway (same gate the archive follower applies).
        if(!eligible.includes(myPubkey)) return;

        // THE byte-match (§2.5). Rebuild every announced section from OUR OWN
        // state_checkpoints row and rebuild the bundle body with the 2.1 ordering rules.
        // One rebuild covers every claim the wire makes at once: hashes, roots, per-section
        // seq and snapshot block, the section set, the MAX snapshot block, and both sorts.
        // A reorg-superseded row, a missing section, an extra section or a single flipped
        // hex digit all fail here.
        let mine = [];
        for(let sec of d.sections){
            let local = await this.db.getStateCheckpointByChain(String(sec.chain), network, Number(sec.block_index), Number(sec.checkpoint_seq));
            if(!local || local.length === 0) return;                       // we cannot vouch for a section we do not hold
            mine.push(local[0]);
        }
        if(this._buildV7Payload(mine, publisher, []) !== String(d.body || '')) return;
        // The proposer's own SNAPSHOT_BLOCK claim has to be the one our rows produce, or
        // the canonical we co-sign would name a block the bundle does not commit to.
        if(mine.reduce((m, r) => Math.max(m, Number(r.snapshot_block)), 0) !== snapshotBlock) return;

        let canonical = this._attestationCanonical({ network: network, snapshot_block: snapshotBlock }, publisher);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;   // proposer's own sig

        this.peerManager.broadcast(XANCPUB_SIGN, {
            network: network, snapshot_block: snapshotBlock,
            sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    },

    async handleAttestSign(envelope){
        let d = envelope.data;
        let round = this._attestRound;
        if(!round || round.done || !d) return;
        // Match the active round by bundle identity (network/snapshot_block), the same
        // pair the election key and the canonical are built from.
        if(String(d.network) !== String(round.bundle.network) ||
           Number(d.snapshot_block) !== Number(round.bundle.snapshot_block)) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this.checkAttestQuorum();
    }

};
