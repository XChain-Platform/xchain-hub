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
 * XChain Hub - Cross-Chain PBFT Failover
 *
 * Leader failover and straggler rescue: the view-change votes, the rotated leader's new view
 * and re-proposal, and the FINAL_SYNC state transfer that hands a stuck round the quorum
 * proof the federation already finalized.
 *
 ********************************************************************/

const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../stake_weighted_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    initiateViewChange(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        pending.view++;
        let view = pending.view;
        if(!pending.viewChanges.has(view)) pending.viewChanges.set(view, new Set());
        pending.viewChanges.get(view).add(pending.myPubkey);
        if(this.peerManager) this.peerManager.broadcast(this.types.VIEW_CHANGE, {
            matchId: rid, view: view, sig_pubkey: pending.myPubkey, sig: this.signControl(this.controlTags.vc, rid, view)
        });
        if(pending.timer) clearTimeout(pending.timer);
        pending.timer = this.armTimer(rid);
        this.maybeAssumeLeadership(rid, view);
    },

    handleViewChange(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid) return;
        if(this.finalized.has(rid)){
            // A VIEW_CHANGE for a round we finalized means the voter is a
            // straggler stuck in failover purgatory. The round can never
            // re-reach quorum (everyone else moved on), so answer with the
            // finalized row + its quorum signatures (state transfer).
            let fin = this.finalizedRows.get(rid);
            if(fin && this.peerManager){
                this.peerManager.broadcast(this.types.FINAL_SYNC, {
                    matchId: rid, row: fin.row, signatures: fin.signatures, view: fin.view
                });
            }
            return;
        }
        let pending = this.pending.get(rid);
        if(!pending){ this.bufferEarlyMessage(rid, envelope); return; }
        let view = Number(d.view);
        if(!Number.isFinite(view)) return;
        let voter = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === voter)) return;     // not a validator
        if(!this.verifyControl(this.controlTags.vc, rid, view, voter, d.sig)) return; // unauthenticated vote
        if(!pending.viewChanges.has(view)) pending.viewChanges.set(view, new Set());
        pending.viewChanges.get(view).add(voter);
        this.maybeAssumeLeadership(rid, view);
    },

    // On 2f+1 view-change votes for `view`, the rotated leader announces NEW_VIEW
    // and re-proposes so the round can make progress under a fresh leader.
    maybeAssumeLeadership(rid, view){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        let votes = pending.viewChanges.get(view);
        if(!votes || !this.meetsQuorum(pending, votes)) return;
        if(view > pending.view) pending.view = view;
        let newLeader = this._leaderFor(rid, pending.validators, view);
        if(newLeader === pending.myPubkey){
            // Rebuild the round canonical for the NEW view before signing (H-8):
            // once the EQUIV header is active the view is folded into the
            // canonical, so re-signing the view-0 bytes under a new-view PROPOSE
            // fails every follower's verification (they recompute at d.view) and
            // failover can never make progress. Votes collected so far covered
            // the OLD canonical, so they are dropped with it; below the EQUIV
            // flag-day the rebuild is byte-identical and this is a no-op that
            // preserves collected votes.
            let canonical = this.engine._canonicalMatch(pending.row, pending.view);
            if(canonical !== pending.canonical){
                pending.canonical = canonical;
                pending.signatures.clear();
                pending.prepares.clear();
                pending.commits.clear();
                pending._commitSent = false;
            }
            if(this.peerManager) this.peerManager.broadcast(this.types.NEW_VIEW, {
                matchId: rid, view: view, sig_pubkey: pending.myPubkey, sig: this.signControl(this.controlTags.nv, rid, view)
            });
            this.broadcastPropose(pending).catch(e => logger.warn('CrossChainDexConsensus: re-propose failed: ' + (e && e.message)));
        }
    },

    // FINAL_SYNC (straggler catch-up): a peer answered our VIEW_CHANGE for a
    // round the federation already finalized. The quorum signatures over the
    // canonical ARE the proof (the same proof the indexers verify), so a
    // forged sync would need 2f+1 real validator signatures. Adopt + finalize.
    //
    // Deliberately NOT bound by the admission map (that guard lives at
    // _handlePropose via admissionBoundHolds, refusing a PROPOSER that invents
    // a height). Here the row already carries 2f+1 signatures, so refusing it
    // finalizes nothing, it only strands THIS hub outside the federation until
    // an operator intervenes; there is no proposer left to bound.
    async handleFinalSync(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;                          // only rescues a live stuck round

        let row = d.row;
        if(!row || String(row[this.idField]).toLowerCase() !== rid) return;
        let syncView  = Number(d.view) || 0;                                    // the view the offered proof was signed at
        let canonical = this.engine._canonicalMatch(row, syncView);   // sigs were taken at the finalizing view

        // The proof is measured against the set the OFFERED row declares, not the one
        // this stuck round happens to hold. Same reason as the PROPOSE adoption above:
        // the offered row can name a different snapshot_block, and a proof that clears
        // the local round's threshold can sit under the threshold its own declared
        // snapshot sets. An unresolvable declared set refuses the sync outright and
        // leaves the round to its timer, rather than ratifying an unmeasurable proof.
        let rebound = await this.rebindSnapshot(pending, row);
        if(rebound === false) return;
        // A rebind is a real await, so re-check the round before measuring anything.
        if(this.finalized.has(rid) || pending.finalized || this.pending.get(rid) !== pending) return;
        let setValidators = rebound ? rebound.validators : pending.validators;
        let setQuorum     = rebound ? rebound.quorum     : pending.quorum;
        let setWeighted   = rebound ? rebound.weighted   : pending.weighted;

        let verified = this.verifiedSyncSignatures(canonical, d, setValidators, setQuorum, setWeighted);
        if(!verified) return;

        pending.row        = row;
        pending.canonical  = canonical;
        pending.signatures = verified;
        // Keep the round's binding with the row it adopted, so anything that reads the
        // set after this (leader election on a later message, the finalize emit) sees
        // the snapshot the published row declares.
        if(rebound){
            pending.validators = rebound.validators;
            pending.quorum     = rebound.quorum;
            pending.weighted   = rebound.weighted;
        }
        // Finalize under the view the proof VERIFIED at, never our local one. finalize
        // emits pending.view and markFinalized caches it for the next straggler, so a
        // node that had already rotated would otherwise publish these signatures under a
        // view whose EQUIV canonical none of them cover (persisted as finalizing_view,
        // mirrored, and folded into the anchor archive). Lowering the view is safe and
        // deliberate: finalize sets pending.finalized, and handleViewChange /
        // handleNewView both short-circuit on a finalized round, so the monotonic-view
        // guard is never consulted for this round again. Taking the higher view is the bug.
        pending.view       = syncView;
        logger.info('CrossChainDexConsensus: FINAL_SYNC caught up ' + rid.substring(0,16) + '... (' + verified.size + ' sigs)');
        this.finalize(rid);
    },

    // The offered FINAL_SYNC signatures that verify against the declared set, or null when
    // they do not clear that set's quorum.
    verifiedSyncSignatures(canonical, d, setValidators, setQuorum, setWeighted){
        let offered = Array.isArray(d.signatures) ? d.signatures : [];
        let verified = new Map();
        for(let s of offered){
            if(!s || !s.pubkey || !s.sig) continue;
            let pk = String(s.pubkey).toLowerCase();
            if(!setValidators.some(v => v.pubkey === pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s.sig), pk)) continue;
            verified.set(pk, String(s.sig));
        }
        // The offered signatures must themselves clear the declared snapshot's quorum
        // (weighted at/above activation, else >=2f+1). A forged sync would need a real
        // quorum of the set the row names.
        let proofOk = setWeighted
            ? swq.meetsStakeThreshold(setValidators, verified.keys())
            : (verified.size >= Math.max(setQuorum, 1));
        if(!proofOk) return null;                                               // not a quorum proof; ignore
        return verified;
    },

    handleNewView(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this.bufferEarlyMessage(rid, envelope); return; }
        let view = Number(d.view);
        if(!Number.isFinite(view) || view <= pending.view) return;        // monotonic: never rewind
        let announcer = String(d.sig_pubkey || '').toLowerCase();
        // Announcer must be the designated leader for the CLAIMED view, and prove it
        // with a valid signature (mirrors Consensus.handleNewView's leader-identity
        // guard: a Byzantine node can only announce views in which it is the leader).
        let expected = this._leaderFor(rid, pending.validators, view);
        if(!expected || announcer !== expected) {
            logger.warn('CrossChainDexConsensus: ignoring NEW_VIEW for view ' + view + ' from non-leader');
            return;
        }
        if(!this.verifyControl(this.controlTags.nv, rid, view, announcer, d.sig)) return;
        // Quorum gate (A-F3): a valid leader signature over NEW_VIEW is NOT proof
        // that a real view-change quorum occurred. Without this, a Byzantine node
        // that is the deterministic leader for some future view can unilaterally
        // drag every honest hub's `pending.view` forward with no 2f+1 VIEW_CHANGE
        // votes behind it (griefing / forced-failover). Require this hub to have
        // independently collected a view-change quorum for `view` (the same votes
        // maybeAssumeLeadership counts) before advancing. If the votes have not
        // arrived yet we simply do not advance here; an honest advance still
        // happens via maybeAssumeLeadership as the VIEW_CHANGE votes land, and
        // the round's own timeout re-triggers view-change otherwise, so liveness
        // is preserved and bounded.
        let votes = pending.viewChanges.get(view);
        if(!votes || !this.meetsQuorum(pending, votes)){
            logger.warn('CrossChainDexConsensus: deferring NEW_VIEW for view ' + view + ' (no local view-change quorum yet)');
            return;
        }
        pending.view = view;
    },
};
