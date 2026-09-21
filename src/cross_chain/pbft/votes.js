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
 * XChain Hub - Cross-Chain PBFT Voting
 *
 * The three vote phases and what each one proves: a leader's PROPOSE verified and adopted,
 * PREPARE and COMMIT counted only with a verifying signature, the quorum test in both count
 * and stake modes, and the finalize that emits the round's signatures.
 *
 ********************************************************************/

const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../consensus/stake_weighted_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

const PENDING_EVICT_MS         = 10000;   // hold finalized state ~10s for late-arriving duplicates, then evict

module.exports = {
    async handlePropose(envelope){
        let proposal = this.leaderProposal(envelope);
        if(!proposal) return;
        let { rid, pending, view, row, canonical } = proposal;

        const validateAndBound = async () => {
            // INDEPENDENT confirmation: re-derive + validate against our own view of
            // the underlying data. This (not byte-equality with our locally pre-built
            // row) is the gate against a Byzantine leader.
            let ok = false;
            try { ok = await this.engine.validateProposedMatch(row); }
            catch(e){ ok = false; }
            if(!ok){
                logger.warn('CrossChainDexConsensus: PROPOSE ' + rid.substring(0,16) + '... failed local validation; not signing');
                return false;
            }

            // The per-chain follower bound on the row's ADMISSION MAP (C38, BF6), applied
            // here because this is the one PROPOSE handler every engine shares. XCALL also
            // applies the bound inside validateProposedMatch, so the proposal-scoped memo
            // makes both gates reuse one tip promise per reading chain.
            return this.admissionBoundHolds(row, rid);
        };
        const checked = this.hub && typeof this.hub.withAdmissionTipMemo === 'function'
            ? await this.hub.withAdmissionTipMemo(validateAndBound)
            : await validateAndBound();
        if(!checked) return;

        // Every await of the round sits in this function, so adopting the leader's row and
        // writing the leader's and our own signature are one synchronous step.
        let adopted = false;
        if(canonical !== pending.canonical){
            if(this.committedToOtherValue(pending, canonical, view)) return;
            let rebound = await this.rebindSnapshot(pending, row);
            if(!this.adoptLeaderRow(proposal, rebound)) return;
            adopted = true;
        }
        this.countLeaderAndOwnPrepare(proposal);

        // PREPARE/COMMIT votes that raced ahead of this PROPOSE failed signature
        // verification against our stale canonical and were buffered; replay them
        // now that the round canonical matches what they signed.
        if(adopted) this.drainEarlyMessages(rid);
    },

    // The synchronous half of what a PROPOSE proves before this hub votes on it: a live round
    // and the designated leader's verifying signature over a row that hashes to the round id.
    // handlePropose then awaits local validation and the admission bound itself.
    leaderProposal(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this.bufferEarlyMessage(rid, envelope); return; }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        let view = Number(d.view) || 0;
        if(view < pending.view) return;                                   // stale leader

        // Sender must be the designated leader for the claimed (matchId, view).
        if(senderPubkey !== this.leaderFor(rid, pending.validators, view)) return;
        if(!pending.validators.some(v => v.pubkey === senderPubkey)) return;

        // The proposed row must hash to this round's id.
        let row = d.row;
        if(!row || String(row[this.idField]).toLowerCase() !== rid) return;
        let canonical = this.engine.canonicalMatch(row, view);   // leader signed at THEIR view (d.view)

        // Verify the leader's signature over THEIR canonical.
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), senderPubkey)) return;
        return { d, rid, pending, senderPubkey, view, row, canonical };
    },

    // True when the round already sent COMMIT for a different VALUE than the leader's row.
    committedToOtherValue(pending, canonical, view){
        // Leader-choice fields (effective_time = the leader's clock second,
        // snapshot_block = the leader's chain-tip view) legitimately differ
        // from the row WE pre-built at discovery, so byte-equality here
        // deadlocked every round whose hubs polled in different seconds.
        // The leader's row passed independent validation above; adopt it as
        // the round canonical, unless we already committed to another VALUE.
        // A canonical that differs only because the view advanced (OUR row
        // at the leader's view == the leader's canonical) is value-identical:
        // with the EQUIV header active every view change moves the canonical
        // bytes, and refusing post-commit adoption of the same value would
        // deadlock every commit-phase node out of the new view, starving
        // failover quorum (H-8). PBFT forbids committing to a different
        // value, not re-voting the same value under a new view.
        let sameValueNewView = (this.engine.canonicalMatch(pending.row, view) === canonical);
        return Boolean(pending._commitSent && !sameValueNewView);
    },

    // Adopt a validated leader row whose canonical differs from the round's own, under the
    // membership handlePropose re-resolved for it (rebound). False when the round must not
    // proceed, true once adopted. Synchronous: the caller writes its votes right after.
    adoptLeaderRow(proposal, rebound){
        let { rid, pending, senderPubkey, row, canonical } = proposal;
        // The MEMBERSHIP travels with the row. snapshot_block is a leader-choice
        // field, and the XCALL rail accepts a leader block within its confirmation
        // window of the local tip, so the adopted row can declare a different
        // snapshot than the one this round opened over. Every consumer re-derives
        // the set at the row's DECLARED snapshot_block and measures the signatures
        // against THAT (xchain-indexer actions/xcall/index.js, recovery.js), so tallying
        // against the pre-adoption set can clear a threshold the declared snapshot
        // never authorised: across a stake activation or a membership change, four
        // signatures out of the old set finalize a row the new seven-member set
        // needs five for. The caller rebinds before a single vote is counted; fail CLOSED
        // (leave the round to its timer and view change) when the set cannot be
        // resolved, rather than counting votes under a set nobody will accept.
        if(rebound === false) return false;
        // The resolve the caller awaited is a real await, so re-check the round is still
        // the one we started on before mutating it.
        if(this.finalized.has(rid) || pending.finalized || this.pending.get(rid) !== pending) return false;
        // The proposing leader has to be a member of the set the row declares. Its
        // signature is one of the ones the indexer will measure, and a signature
        // from outside the declared set is discarded there.
        if(rebound && !rebound.validators.some(v => v.pubkey === senderPubkey)) return false;
        pending.row       = row;
        pending.canonical = canonical;
        if(rebound){
            pending.validators = rebound.validators;
            pending.quorum     = rebound.quorum;
            pending.weighted   = rebound.weighted;
        }
        pending.signatures.clear();   // any collected sigs were over the old canonical
        pending.prepares.clear();
        pending.commits.clear();
        pending._commitSent = false;
        logger.info('CrossChainDexConsensus: adopted leader canonical for ' + rid.substring(0,16) + '...');
        return true;
    },

    // The leader's signature and this hub's own PREPARE for the round canonical, then the
    // prepare-quorum check, in the same synchronous step as any adoption before it.
    countLeaderAndOwnPrepare(proposal){
        let { d, rid, pending, senderPubkey, view, canonical } = proposal;
        if(view > pending.view) pending.view = view;
        pending.signatures.set(senderPubkey, String(d.sig));             // leader's sig
        pending.prepares.add(senderPubkey);

        // Our own signature + PREPARE broadcast.
        if(!pending.signatures.has(pending.myPubkey)){
            let mySig = this.identity.sign(canonical);
            pending.signatures.set(pending.myPubkey, mySig);
            pending.prepares.add(pending.myPubkey);
            if(this.peerManager){
                this.peerManager.broadcast(this.types.PREPARE, {
                    matchId: rid, view: pending.view, sig_pubkey: pending.myPubkey, sig: mySig
                });
            }
        }
        this.checkPrepareQuorum(rid);
    },

    handlePrepare(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this.bufferEarlyMessage(rid, envelope); return; }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === senderPubkey)) return;
        if(!d.sig || !ValidatorIdentity.verify(pending.canonical, String(d.sig), senderPubkey)){
            // A vote only counts with a verifying signature over the round
            // canonical. A mismatch usually means this vote raced ahead of the
            // leader's PROPOSE (we still hold our pre-built canonical); buffer
            // it for replay after adoption rather than losing it.
            this.bufferEarlyMessage(rid, envelope);
            return;
        }
        pending.signatures.set(senderPubkey, String(d.sig));
        pending.prepares.add(senderPubkey);
        this.checkPrepareQuorum(rid);
    },

    // Quorum test for a collected vote set (prepares or commits). Stake-weighted
    // (source-deduped 3·Sigma>2·S) at/above activation; signer COUNT (>=2f+1) below it.
    meetsQuorum(pending, voteSet){
        if(pending.weighted)
            return swq.meetsStakeThreshold(pending.validators, voteSet);
        return voteSet.size >= pending.quorum;
    },

    checkPrepareQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || pending._commitSent) return;
        if(!this.meetsQuorum(pending, pending.prepares)) return;
        pending._commitSent = true;
        pending.commits.add(pending.myPubkey);
        let mySig = pending.signatures.get(pending.myPubkey) || null;
        if(this.peerManager){
            this.peerManager.broadcast(this.types.COMMIT, {
                matchId: rid, view: pending.view, sig_pubkey: pending.myPubkey, sig: mySig,
                // Phase-bound vote signature; see commitPayload.
                commit_sig: this.identity.sign(this.commitPayload(pending.canonical))
            });
        }
        this.checkCommitQuorum(rid);
    },

    handleCommit(envelope){
        let d = envelope.data;
        let rid = String(d.matchId || '').toLowerCase();
        if(!rid || this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){ this.bufferEarlyMessage(rid, envelope); return; }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === senderPubkey)) return;
        if(!d.sig || !ValidatorIdentity.verify(pending.canonical, String(d.sig), senderPubkey)){
            // Unverified commits must NOT count toward quorum: counting them let a
            // node whose canonical diverged "finalize" with zero collected
            // signatures and persist an unverifiable mirror row. Buffer for
            // replay in case the leader's PROPOSE (and adoption) is still racing.
            this.bufferEarlyMessage(rid, envelope);
            return;
        }
        // The artifact signature verified above proves the peer signed the
        // canonical (prepare-tier evidence); the phase-bound commit_sig proves
        // it actually reached COMMIT for this round. Without it a replayed
        // PREPARE would count as a commit vote (A-F6). Collect the
        // artifact sig either way (it is genuine and indexer-verifiable), but
        // only tally the commit with a verifying commit_sig.
        pending.signatures.set(senderPubkey, String(d.sig));
        if(!d.commit_sig || !ValidatorIdentity.verify(this.commitPayload(pending.canonical), String(d.commit_sig), senderPubkey)){
            logger.warn('CrossChainDexConsensus: COMMIT without verifying phase-bound commit_sig from ' +
                senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (vote not counted; a peer running older code, or a replayed PREPARE)');
            return;
        }
        pending.commits.add(senderPubkey);
        this.checkCommitQuorum(rid);
    },

    checkCommitQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        if(!this.meetsQuorum(pending, pending.commits)) return;
        this.finalize(rid);
    },

    finalize(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        pending.finalized = true;

        let sigs = [];
        for(let [pk, sg] of pending.signatures) sigs.push({ pubkey: pk, sig: sg });

        this.markFinalized(rid, pending.row, sigs, pending.view);
        if(pending.timer){ clearTimeout(pending.timer); pending.timer = null; }

        logger.info('CrossChainDexConsensus: finalized ' + rid.substring(0,16) + '... (' +
                    pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits, ' + sigs.length + ' sigs)');
        // `view` = the PBFT view this round finalized at (incremented per view-change).
        // Persisted as finalizing_view so the indexer rebuilds the exact EQUIV canonical
        // (WI-2 bump 2); below the EQUIV flag-day it is stored but unused.
        this.emit('match:finalized', { matchId: rid, row: pending.row, signatures: sigs, view: pending.view });

        let cleanup = setTimeout(() => this.pending.delete(rid), PENDING_EVICT_MS);
        if(cleanup.unref) cleanup.unref();             // housekeeping timer; never pin process liveness
    },

    // Reorg support (deepdive M-13): drop a round id from the finalized ring so a
    // re-confirmed action can run a FRESH round for it. Once a round finalizes its
    // id sits in `finalized` (ring-buffer bounded) and propose() no-ops on it, which
    // is correct steady-state dedup but permanently wrong after a reorg RETRACTS the
    // row and the underlying action later re-confirms: the deterministic round can
    // never re-finalize and the call/match stays stranded in 'retracted'. Retraction
    // paths call this so the next propose() runs. Also evicts any live pending round
    // (and its cached FINAL_SYNC payload) so a round still in flight at retraction
    // time cannot finalize afterward and resurrect the just-retracted row. Exactly-once
    // still holds: the DB row keyed on (call_id/match_id, phase) is the single slot
    // indexers act on, and re-finalization overwrites it (ON DUPLICATE KEY UPDATE),
    // so at most one live row exists per confirmed action.
    forgetFinalized(rid){
        rid = String(rid).toLowerCase();
        let had = this.finalized.delete(rid);
        this.finalizedRows.delete(rid);
        if(had){
            let i = this._finalizedOrder.indexOf(rid);
            if(i >= 0) this._finalizedOrder.splice(i, 1);
        }
        let p = this.pending.get(rid);
        if(p){
            if(p.timer) clearTimeout(p.timer);
            this.pending.delete(rid);
        }
        return had;
    },

    markFinalized(rid, row, signatures, view){
        if(this.finalized.has(rid)) return;
        this.finalized.add(rid);
        // Store the finalizing view too: FINAL_SYNC state-transfer must tell a straggler
        // which view the quorum signatures were taken at, so it rebuilds the exact EQUIV canonical.
        if(row) this.finalizedRows.set(rid, { row: row, signatures: signatures || [], view: view || 0 });
        this._finalizedOrder.push(rid);
        if(this._finalizedOrder.length > this.finalizedMax){
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
            this.finalizedRows.delete(oldest);
        }
    },
};
