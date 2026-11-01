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
 * State checkpoint engine - the leader's round
 *
 * Proposing a checkpoint, collecting follower signatures and finalizing at quorum,
 * plus the one-payload-per-sequence claim every signature leaving this hub passes.
 *
 ********************************************************************/

'use strict';

const canonicalForms    = require('./canonical_forms.js');
const { replayWindowFor, supersedeFieldsFor, supersedeGateRefusal } = require('./supersede_fill.js');
const { checkpointProposalDecline } = require('./replay_hold.js');
const { hasSupersedeFields } = require('./supersede_suffix.js');
const ValidatorIdentity = require('../../validators/identity.js');
const swq               = require('../../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { XCHK_SIGN_REQ, XCHK_FINALIZED } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// How many (chain, network, checkpoint_seq) signing commitments the engine holds. One
// entry per chain per cadence round, so a few hundred spans many cadences on every
// configured chain. Evicting the oldest is safe: the co-sign replay guard refuses a
// sequence at or below the highest one already seated, so an evicted sequence is fenced
// by the DB as soon as any later checkpoint finalizes.
const CHECKPOINT_SIGNED_SEQ_MEMORY = 512;
// Re-leads of one timed-out round at its snapshot block before the cadence moves on.
const CHECKPOINT_ROUND_RETRIES = 3;
// Ticks a failed leader self-accept is re-run on, and how many distinct ones are held.
const CHECKPOINT_SELF_ACCEPT_RETRIES = 30;
const CHECKPOINT_SELF_ACCEPT_MEMORY  = 64;

module.exports = {

    // `retry` ({ attempt, blockIndex }) marks a re-lead of a round that timed out unfinalized.
    async runRound(chain, snapshotBlock, validators, retry){
        let bh = await this.roundTargetBlock(chain);

        // A retry re-proposes the SAME payload. If the tip moved the target off the timed-out
        // block, a re-lead would be a second payload at the sequence (refused, and logged as
        // equivocation); drop it, the signatures on the first payload cannot be reused anyway.
        // A round that threw before proposing has no block yet (blockIndex null) and signed
        // nothing, so its retry proposes whatever the indexer serves now.
        if(retry && retry.blockIndex != null && Number(bh.block_index) !== Number(retry.blockIndex)) return;

        let network = String(bh.network || '');
        if(!network) throw new Error(chain + ' indexer returned no network (refusing a network-agnostic checkpoint)');
        // Seq is a deterministic function of the round's BTC snapshot_block, NOT
        // COALESCE(MAX(seq))+1. The old read-then-allocate let two one-block-tip-skewed
        // leaders read the same MAX and mint the SAME seq for DIFFERENT blocks; every
        // honest leader now derives its seq from the (per-hub-unique-at-a-given-tip)
        // snapshot_block, so a shared seq implies a shared snapshot_block implies one
        // payload. Followers re-derive and refuse a mismatch (handleSignReq).
        let cp = await this.checkpointForRound(chain, network, bh, snapshotBlock);
        // A decline returns its reason, so the cadence callers keep this chain's failure entry.
        const proposalDecline = await this.leaderProposalDecline(chain, network, cp, bh);
        if(proposalDecline) return this.noteLeaderDecline(proposalDecline, cp);
        // Post-flag-day the signed shape REQUIRES the roots; refuse to sign a malformed
        // (empty-root) canonical if the indexer hasn't produced them yet (operator must
        // pick a snapshot_block at/after every chain's STATE_COMMITMENT flag-day).
        if(canonicalForms.isRootless(cp))
            throw new Error('checkpoint-commitment active for ' + chain + '@' + cp.block_index +
                            ' but indexer returned no light-client roots (state-commitment flag-day not yet reached on ' + chain + ')');
        let canonical = canonicalForms.canonicalCheckpoint(cp);
        let id        = this.roundId(cp);
        if(this.pending.has(id)) return;
        if(!this.identity) throw new Error('no validator identity (cannot sign checkpoints)');

        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        // The SWQ gate below resolves on this.network; refuse before signing if
        // the checkpoint we just built disagrees (a mis-set indexer network).
        this.assertCheckpointNetwork(cp, 'propose');
        // The interval rule, re-read here because a peer's FINALIZED or this hub's own
        // co-signature on another round of the interval may have landed during the reads above.
        if(this.declinesOwnRound(cp)) return;
        // One payload per sequence (first of the two call sites, with co-sign), ahead of
        // the signature so a refused proposal never produces one.
        if(!this.claimSeqSignature(cp, canonical)) return;
        this.noteRoundSignature(snapshotBlock);
        let mySig    = this.identity.sign(canonical);
        let snapCount = validators.length;   // raw row count (matches handleFinalized + the indexer's quorum.js oracleN)
        // STAKE_WEIGHTED_QUORUM: weighted (source-deduped) at/above activation, else count.
        let weighted  = swq.isStakeWeightedQuorumActive(cp.snapshot_block, this.network);
        let quorum    = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        // Single-node self-sign fast path. Below SWQ this is snapCount<=1 (one row).
        let soleSelf = this.isSoleSelfFederation(validators, myPubkey);
        if(snapCount <= 1 || (weighted && soleSelf)){
            await this.acceptSoleSelf(cp, [{ pubkey: myPubkey, sig: mySig }], quorum);
            return;
        }

        this.openLeaderRound({ id, cp, canonical, quorum, weighted, validators, myPubkey, mySig, attempt: retry ? retry.attempt : 0 });
    },

    async leaderProposalDecline(chain, network, cp, bh){
        let expectedSupersede;
        if(hasSupersedeFields(cp))
            expectedSupersede = await this.supersedeFieldsForRound(
                chain, network, bh);
        return checkpointProposalDecline(cp, bh, expectedSupersede);
    },

    // Checkpoint the chain's tip minus a confirmation margin, so every peer's
    // indexer/replica has indexed the block and a shallow reorg can't race the round.
    async roundTargetBlock(chain){
        let tip = await this.indexerCall(chain, 'getblockhashes', {});
        if(!tip || tip.block_index == null) throw new Error('no tip block hashes from ' + chain + ' indexer');
        let target = Number(tip.block_index) - this.confirmations;
        if(target < 0) target = Number(tip.block_index);
        let bh = (target === Number(tip.block_index)) ? tip : await this.indexerCall(chain, 'getblockhashes', { block_index: target });
        if(!bh || bh.block_index == null || !bh.block_hash) throw new Error('no block hashes for ' + chain + ' @ ' + target);
        return bh;
    },

    // No peer holds a sole-self checkpoint, so a failed write is queued for retry and still
    // thrown, which meters the round failure for this chain.
    async acceptSoleSelf(cp, sigs, quorum){
        try { await this.acceptFinalized(cp, sigs, quorum, true); }
        catch(e){ this.queueSelfAccept(cp, sigs, quorum, e); throw e; }
    },

    // The checkpoint record a leader proposes from its own indexer's block hashes `bh` at
    // the target height: hashes lowercased, roots carried only where the indexer served them.
    checkpointFromBlockHashes(chain, network, bh, seq, snapshotBlock, supersedeFields){
        let cp = {
            chain:          chain,
            network:        network,
            block_index:    Number(bh.block_index),
            block_hash:     String(bh.block_hash).toLowerCase(),
            ledger_hash:    String(bh.ledger_hash    || '').toLowerCase(),
            actions_hash:   String(bh.actions_hash   || '').toLowerCase(),
            contract_hash:  String(bh.contract_hash  || '').toLowerCase(),
            checkpoint_seq: seq,
            snapshot_block: Number(snapshotBlock),
            // SPV Phase 2: the additive light-client roots the post-flag-day canonical signs.
            state_root:           bh.state_root           != null ? String(bh.state_root).toLowerCase()        : null,
            state_root_version:   bh.state_root_version   != null ? Number(bh.state_root_version)   : null,
            block_merkle_root:    bh.block_merkle_root    != null ? String(bh.block_merkle_root).toLowerCase() : null,
            block_merkle_version: bh.block_merkle_version != null ? Number(bh.block_merkle_version) : null
        };
        if(supersedeFields) Object.assign(cp, supersedeFields);
        return cp;
    },

    async checkpointForRound(chain, network, bh, snapshotBlock){
        const seq = canonicalForms.deriveCheckpointSeq(snapshotBlock);
        const supersedeFields = await this.supersedeFieldsForRound(chain, network, bh);
        const cp = this.checkpointFromBlockHashes(
            chain, network, bh, seq, snapshotBlock, supersedeFields);
        if(supersedeGateRefusal(cp, canonicalForms.isCheckpointSupersedeActive(cp)))
            throw new Error('checkpoint supersession fields are not active for snapshot_block ' + cp.snapshot_block);
        return cp;
    },

    async supersedeFieldsForRound(chain, network, bh){
        const rules = bh && bh.rules;
        const replayWindow = replayWindowFor(rules);
        if(!replayWindow) return null;
        const finalizedRows = await this.db.findUnsupersededStateCheckpointsInReplayWindow(
            chain, network, replayWindow.target, replayWindow.replay_to);
        return supersedeFieldsFor(bh.rules, finalizedRows);
    },

    // At/above SWQ the snapshot is one row per (source, pubkey), so a lone validator
    // whose one key is delegated by multiple sources has snapCount>1 even though THIS
    // hub is the entire federation; meetsStakeThreshold structurally cannot credit one
    // key for multiple sources (pubkey->source is 1:1), so that round could never
    // gather a second signer and would stall (item 2651). Detect the genuine
    // sole-self case - every snapshot row is our own pubkey - and self-finalize,
    // mirroring the CrossChainDexConsensus soleSelf guard. The tick cadence check
    // already proved we are a member, so a distinct-pubkey count of 1 means that one
    // pubkey is ours. Inert below SWQ, where distinct pubkeys == snapCount (no dupes),
    // so the weighted term never fires and the condition is byte-for-byte snapCount<=1.
    isSoleSelfFederation(validators, myPubkey){
        let oneDistinctPubkey = (new Set(validators.map(v => String(v.pubkey).toLowerCase()))).size === 1;
        let soleSelf = oneDistinctPubkey && String(validators[0].pubkey).toLowerCase() === myPubkey;
        return soleSelf;
    },

    // Open the leader's round for a proposal that needs peer signatures: the pending entry
    // and its timeout, the SIGN_REQ, then a quorum check the leader's own signature seeds.
    openLeaderRound(round){
        let { id, cp, canonical, quorum, weighted, validators, myPubkey, mySig, attempt } = round;
        // Re-map to the signer-verification shape, preserving the truncation flag so
        // checkQuorum's meetsStakeThreshold still fails closed on an over-cap snapshot
        // (the .map would otherwise drop it, same defect class as the resolver above).
        let pendingValidators = validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0')) }));
        if(validators.truncated === true) pendingValidators.truncated = true;
        let pending = {
            id, cp, canonical, quorum, weighted,
            validators: pendingValidators,
            signatures: new Map([[myPubkey, mySig]]),
            done:       false,
            timer:      null
        };
        this.pending.set(id, pending);
        pending.timer = setTimeout(() => {
            this.pending.delete(id);
            if(!pending.done){
                this._roundTimeouts++;
                logger.warn('StateCheckpointEngine: round ' + id + ' timed out at ' +
                    pending.signatures.size + '/' + quorum + ' sigs, retrying; missing: ' +
                    this.missingSigners(pending));
                this.queueRoundRetry(cp, attempt || 0);
            }
        }, this.roundTimeoutMs);
        if(pending.timer.unref) pending.timer.unref();

        this.peerManager.broadcast(XCHK_SIGN_REQ, { checkpoint: cp, sig_pubkey: myPubkey, sig: mySig });
        this.checkQuorum(id);
    },

    // Remember a timed-out (or thrown) round so the next tick re-leads it at the same
    // snapshot block. tick treats a tip still at this hub's attempt as already led, so
    // without this a frozen tip never re-leads and the chain is never checkpointed.
    // Bounded per chain.
    queueRoundRetry(cp, attempt){
        if(attempt >= CHECKPOINT_ROUND_RETRIES) return;
        if(!this._roundRetries) this._roundRetries = new Map();
        this._roundRetries.set(cp.chain, { snapshotBlock: cp.snapshot_block, blockIndex: cp.block_index, attempt: attempt + 1 });
    },

    // The validators that did not sign a timed-out round, sorted and deduped (a weighted
    // snapshot can list one pubkey under several sources), capped so the warn line stays short.
    missingSigners(pending){
        let missing = [...new Set(pending.validators.map(v => v.pubkey))]
            .filter(pk => !pending.signatures.has(pk)).sort();
        let shown = missing.slice(0, 16).join(',') || 'none';
        return missing.length > 16 ? shown + ' (+' + (missing.length - 16) + ' more)' : shown;
    },

    // Leader: collect follower signatures.
    handleSign(envelope){
        let d  = envelope.data;
        let id = String(d.id || '');
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(pending.canonical, String(d.sig || ''), pubkey)) return;
        pending.signatures.set(pubkey, String(d.sig));
        this.checkQuorum(id);
    },

    checkQuorum(id){
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let met = pending.weighted
            ? swq.meetsStakeThreshold(pending.validators, pending.signatures.keys())
            : (pending.signatures.size >= pending.quorum);
        if(!met) return;
        pending.done = true;
        if(pending.timer){ clearTimeout(pending.timer); pending.timer = null; }
        this.pending.delete(id);
        // A checkpoint inside this interval finalized while the signatures came in (two
        // slot holders led one interval): this round yields and no retry is queued.
        if(this.declinesOwnRound(pending.cp)) return;
        let sigs = [];
        for(let [pk, sg] of pending.signatures) sigs.push({ pubkey: pk, sig: sg });
        this.peerManager.broadcast(XCHK_FINALIZED, { checkpoint: pending.cp, signatures: sigs });
        this.acceptFinalized(pending.cp, sigs, pending.quorum, true)
            .catch(e => this.queueSelfAccept(pending.cp, sigs, pending.quorum, e));
    },

    // Hold a leader self-accept that failed after quorum (a DB blip on the snapshot or the
    // checkpoint write) so the next tick writes the row again. Peers persist it from the
    // FINALIZED broadcast; without this the leader alone would lack it until a restart.
    queueSelfAccept(cp, sigs, quorum, err){
        if(!this._selfAcceptRetries) this._selfAcceptRetries = new Map();
        this._selfAcceptFailures = (this._selfAcceptFailures || 0) + 1;
        let id   = this.roundId(cp);
        let held = this._selfAcceptRetries.get(id);
        this._selfAcceptRetries.set(id, { cp: cp, sigs: sigs, quorum: quorum, attempts: held ? held.attempts : 0 });
        while(this._selfAcceptRetries.size > CHECKPOINT_SELF_ACCEPT_MEMORY){
            this._selfAcceptRetries.delete(this._selfAcceptRetries.keys().next().value);
            this._selfAcceptsAbandoned = (this._selfAcceptsAbandoned || 0) + 1;
        }
        logger.error('StateCheckpointEngine: accept error (leader, ' + id + '), retrying on the next tick: ' + (err && err.message));
    },

    // Re-run each held self-accept once. Safe to repeat: the writes are INSERT IGNORE, and a
    // different payload already seated at the sequence returns without writing anything.
    async retryFailedSelfAccepts(){
        if(!this._selfAcceptRetries || this._selfAcceptRetries.size === 0) return;
        for(let [id, held] of [...this._selfAcceptRetries]){
            try {
                await this.acceptFinalized(held.cp, held.sigs, held.quorum, true);
                this._selfAcceptRetries.delete(id);
                this.clearRoundFailure(held.cp.chain);
            } catch(e){
                this._selfAcceptFailures = (this._selfAcceptFailures || 0) + 1;
                held.attempts++;
                if(held.attempts < CHECKPOINT_SELF_ACCEPT_RETRIES){
                    logger.warn('StateCheckpointEngine: leader accept retry ' + held.attempts + ' failed for ' + id + ': ' + (e && e.message));
                    continue;
                }
                this._selfAcceptRetries.delete(id);
                this._selfAcceptsAbandoned = (this._selfAcceptsAbandoned || 0) + 1;
                logger.error('StateCheckpointEngine: gave up writing leader checkpoint ' + id + ' after ' +
                             held.attempts + ' retries (peer catch-up restores it on reconnect or restart): ' + (e && e.message));
            }
        }
    },

    roundId(cp){ return cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq; },

    // Claim the right to sign `canonical` at this checkpoint's sequence: true for an
    // unsigned sequence and for a re-delivery of the payload already signed there (a
    // repeated canonical creates no second checkpoint), false for a DIFFERENT payload,
    // which is the double-signature that lets one sequence carry two quorum-signed
    // checkpoints. Call it wherever a signature leaves this hub; false means do not sign.
    //
    // The refusal is unconditional, including for an honest leader that lost a round in
    // flight and re-proposes a new block at the same snapshot_block, and for a reorg that
    // moves the block under one: both are indistinguishable from equivocation to every
    // peer, and the signatures already collected on the first payload can still be
    // assembled by anyone. The cost is that one round; the next block's cadence leader
    // retries the interval, since only a FINALIZED checkpoint moves the latch.
    claimSeqSignature(cp, canonical){
        let key  = cp.chain + '|' + cp.network + '|' + Number(cp.checkpoint_seq);
        let held = this._signedAtSeq.get(key);
        if(held !== undefined && held !== canonical){
            this._seqDoubleSignRefusals++;
            logger.error('StateCheckpointEngine: SECOND PAYLOAD at ' + cp.chain + '/' + cp.network +
                          ' seq ' + cp.checkpoint_seq + ': this hub signed a different payload at that ' +
                          'sequence and refuses block ' + Number(cp.block_index) + ' (' +
                          String(cp.block_hash) + '). One signature per sequence is what keeps two ' +
                          'quorum-signed checkpoints from existing there; the proposer put two on the wire.');
            return false;
        }
        if(held === undefined){
            this._signedAtSeq.set(key, canonical);
            while(this._signedAtSeq.size > CHECKPOINT_SIGNED_SEQ_MEMORY)
                this._signedAtSeq.delete(this._signedAtSeq.keys().next().value);
        }
        return true;
    }

};
