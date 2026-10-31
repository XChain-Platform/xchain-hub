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
 * State checkpoint engine - the follower's co-sign
 *
 * Signing a proposed checkpoint only after our own indexer confirms it, and the
 * guards that refuse a record from another network or a malformed wire checkpoint.
 *
 ********************************************************************/

'use strict';

const canonicalForms    = require('./canonical_forms.js');
const { hasSupersedeFields } = require('./supersede_suffix.js');
const {
    supersedeCosignDecline,
    checkpointProposalDecline,
} = require('./replay_hold.js');
const ValidatorIdentity = require('../../validators/identity.js');
const { XCHK_SIGN, ALLOWED_CHAINS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Co-sign declines handleSignReq reaches before it authenticates the sender.
const PRE_AUTH_COSIGN_DECLINES = new Set(['own_tip_unresolved', 'snapshot_out_of_tolerance']);
// Fallback pre-auth decline log window when the engine has no stall-log window set.
const DECLINE_LOG_WINDOW_MS = 60 * 60 * 1000;

const DIVERGENCE_FIELDS = ['network', 'block_index', 'block_hash', 'ledger_hash', 'actions_hash', 'contract_hash',
    'state_root', 'state_root_version', 'block_merkle_root', 'block_merkle_version'];

// Name the signed fields where the proposal and our own indexer block differ (log detail only).
function divergentFields(cp, bh){
    const norm = (v) => (v == null ? '' : String(v).toLowerCase());
    const diff = DIVERGENCE_FIELDS.filter((f) => norm(cp[f]) !== norm(bh[f]));
    return diff.length ? 'differs on ' + diff.join(',') : 'canonical differs';
}

module.exports = {

    // Follower: independently confirm the proposed checkpoint against OUR OWN
    // indexer before signing (never sign state we don't hold ourselves).
    async handleSignReq(envelope){
        let d  = envelope.data;
        let cp = this.normalizeCheckpoint(d.checkpoint);
        if(!cp || !this.identity) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;                            // our own broadcast

        // One of the guard's call sites (propose, co-sign, peer finalized, persist,
        // catch-up). The indexer byte-match further down rebuilds `mine` with the network
        // OUR OWN indexer reports, so it catches record-vs-indexer drift and is blind to the
        // record-vs-DEPLOYMENT drift this predicate exists for: resolveCapabilityValidators
        // resolves the stake-weighted-quorum gate on `this.network`, so a hub whose
        // HUB_NETWORK disagrees with the record would co-sign under one quorum plane and
        // then refuse the finalized checkpoint under the other. Placed before the tip
        // resolve and the validator resolve, like the propose and peer FINALIZED paths, so
        // a cross-network record costs no lookups. A throw is caught by the XCHK_SIGN_REQ
        // .catch in handleMessage; an unscoped hub (this.network === '') is warned, not refused.
        this.assertCheckpointNetwork(cp, 'co-sign');

        // Freshness guard (fail-closed): the leader-supplied snapshot_block selects
        // the validator set AND every flag-day gate below, but is a wire field the
        // proposer chose. Bound it against our OWN resolved BTC tip before it can
        // reach leader-selection (grinding), the validator-set resolve, or the flag-
        // day gates (regression). If we cannot resolve our own tip, we decline rather
        // than co-sign blind. Mirrors StateAnchorPublisher.js:1467 / CrossChainCallEngine.js:536.
        // Both declines here run before the sender is authenticated, so any peer can
        // trigger them: noteCheckpointDecline throttles their warning per reason for that.
        let myBtc = await this.resolveSnapshotBlock();
        if(!Number.isFinite(myBtc)) return this.noteCosignDecline('own_tip_unresolved', cp);   // no own tip -> fail closed
        if(Math.abs(myBtc - Number(cp.snapshot_block)) > this.cosignToleranceBlocks)
            return this.noteCosignDecline('snapshot_out_of_tolerance', cp,
                'proposed ' + cp.snapshot_block + ', our tip ' + myBtc + ', tolerance ' + this.cosignToleranceBlocks);

        // Deterministic-seq guard: checkpoint_seq is a pure function of
        // snapshot_block, so re-derive it and refuse a leader whose seq does not match.
        // This closes seq-grinding (a leader picking an arbitrary seq to dodge the
        // replay guard below or fork the anchor/reward bookkeeping) and makes the
        // tightened (chain, network, checkpoint_seq) unique key a true split-brain fence.
        if(Number(cp.checkpoint_seq) !== canonicalForms.deriveCheckpointSeq(cp.snapshot_block)) return;

        let validators = await this.resolveCapabilityValidators('oracle_publish', cp.snapshot_block);
        if(!this.followsCadenceLeader(validators, sender, myPubkey, cp)) return;

        let canonical = canonicalForms.canonicalCheckpoint(cp);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;
        this.supersedeOwnAttempt(myBtc);                           // our tip moved past a round we led
        if(this.declinesOffCadence(cp, true)) return;              // too soon after the last checkpoint

        // Replay guard: never co-sign a seq at-or-below one we've already recorded.
        let maxSeq = await this.getMaxCheckpointSeq(cp.chain, cp.network);
        if(maxSeq != null && cp.checkpoint_seq <= maxSeq) return;

        await this.coSignConfirmedCheckpoint(cp, canonical, myPubkey);
    },

    async coSignConfirmedCheckpoint(cp, canonical, myPubkey){
        let bh = null;
        try { bh = await this.indexerCall(cp.chain, 'getblockhashes', { block_index: cp.block_index }); }
        catch(e){ return this.noteCosignDecline('indexer_read_failed', cp, String(e && e.message).slice(0, 200)); }   // can't confirm -> don't sign
        if(!bh) return this.noteCosignDecline('indexer_no_block', cp);
        let proposalDecline = supersedeCosignDecline(cp, bh.rules);
        let expectedSupersede;
        if(!proposalDecline && hasSupersedeFields(cp))
            expectedSupersede = await this.supersedeFieldsForRound(
                cp.chain, cp.network, bh);
        if(!proposalDecline)
            proposalDecline = checkpointProposalDecline(
                cp, bh, expectedSupersede);
        if(proposalDecline) return this.noteCosignDecline(proposalDecline, cp);
        this.coSignAgainstOwnBlock(cp, canonical, bh, myPubkey);
    },

    // Count a follower's refusal to co-sign and name it. Declining is the fail-closed answer;
    // a silent one lets a member drop out of every quorum with no trace while the rest still
    // sign. Every decline is counted; noteCheckpointDecline decides how often it is logged.
    noteCosignDecline(reason, cp, detail){
        const declines = this._cosignDeclines || (this._cosignDeclines = {});
        declines[reason] = (declines[reason] || 0) + 1;
        this._lastCosignDeclineReason = reason;
        this.noteCheckpointDecline(reason, cp, 'co-sign', detail, declines[reason]);
    },

    // Count a round this hub led that its own proposal check refused, name it for that chain
    // until clearRoundFailure, and return the reason (the hold is fail-closed, nothing else reports it).
    noteLeaderDecline(reason, cp){
        const declines = this._leaderDeclines || (this._leaderDeclines = {});
        declines[reason] = (declines[reason] || 0) + 1;
        this._leaderDeclinesTotal = (this._leaderDeclinesTotal || 0) + 1;
        if(!this._lastLeaderDeclineByChain) this._lastLeaderDeclineByChain = {};
        this._lastLeaderDeclineByChain[cp.chain] = { reason: reason, block: Number(cp.snapshot_block),
            block_index: Number(cp.block_index), seq: Number(cp.checkpoint_seq), at: Date.now() };
        this.noteCheckpointDecline(reason, cp, 'open leader round', null, declines[reason]);
        return reason;
    },

    // Log once per action, reason and seq, with the caller's own count. A co-sign decline
    // that runs before the sender is authenticated logs once per reason per stall-log window.
    noteCheckpointDecline(reason, cp, action, detail, count){
        if(action === 'co-sign' && PRE_AUTH_COSIGN_DECLINES.has(reason)){
            if(!this.preAuthDeclineLogDue(reason)) return;
        } else {
            const logged = this._cosignDeclineLogged || (this._cosignDeclineLogged = new Set());
            const key = action + '|' + reason + '|' + cp.chain + '|' + cp.network + '|' + cp.checkpoint_seq;
            if(logged.has(key)) return;
            logged.add(key);
            while(logged.size > 512) logged.delete(logged.values().next().value);
        }
        logger.warn('StateCheckpointEngine: declining to ' + action + ' ' + cp.chain + '@' + cp.block_index +
            ' seq ' + cp.checkpoint_seq + ': ' + reason + (detail ? ' (' + detail + ')' : '') +
            (count ? ' (declines for this reason so far: ' + count + ')' : ''));
    },

    // Throttle on time, not seq: the seq and snapshot_block of a pre-auth decline are
    // whatever an unauthenticated sender put on the wire, so a per-seq key logs every message.
    preAuthDeclineLogDue(reason){
        const loggedAt = this._cosignDeclineLoggedAt || (this._cosignDeclineLoggedAt = {});
        const windowMs = Number.isFinite(this._cadenceStallLogMs) ? this._cadenceStallLogMs : DECLINE_LOG_WINDOW_MS;
        const now = Date.now();
        if(loggedAt[reason] != null && now - loggedAt[reason] < windowMs) return false;
        loggedAt[reason] = now;
        return true;
    },

    // Refuse a round that starts less than intervalBlocks after our last FINALIZED
    // checkpoint, or inside the interval of another round this hub signed that may still
    // finalize (cadenceConflict in cadence.js): the follower half of the leader's gate in
    // tick. Without it a slot holder can checkpoint at every block it leads and pick the
    // snapshot_block that keys the bundle election. Called with `finalizedOnly` before the
    // indexer read, which spares the read for a stale round, and in full just before the
    // signature leaves: by then a FINALIZED or another co-signature may have landed, and
    // this hub may have yielded its own round to this one (yieldToLowerRound).
    declinesOffCadence(cp, finalizedOnly){
        let conflict = finalizedOnly ? this.finalizedConflict(cp.snapshot_block) : this.cadenceConflict(cp.snapshot_block);
        if(conflict == null) return false;
        this.noteCosignDecline('off_cadence', cp, 'proposed ' + Number(cp.snapshot_block) + ', ' + conflict);
        return true;
    },

    // The follower's leader check over the resolved set: this hub must be a member, and
    // the sender must hold the cadence slot for the checkpoint's snapshot_block.
    followsCadenceLeader(validators, sender, myPubkey, cp){
        // Dedupe to DISTINCT pubkeys before ranking, in lockstep with the leader
        // site in leadsCadenceSlot (see the rationale there). Both MUST rank the same list or leader
        // and follower disagree on the cadence slot (split-brain). Inert below SWQ.
        let pubkeys    = [...new Set(validators.map(v => String(v.pubkey).toLowerCase()))].sort();
        if(!pubkeys.includes(myPubkey)) return false;              // we don't qualify
        if(sender !== pubkeys[cp.snapshot_block % pubkeys.length]) return false;   // not the cadence leader
        return true;
    },

    // Co-sign `canonical` only when our own indexer's block `bh` rebuilds the identical
    // canonical, the checkpoint carries the roots its flag-day requires, and this hub
    // has not already signed a different payload at the sequence.
    coSignAgainstOwnBlock(cp, canonical, bh, myPubkey){
        let mine = canonicalForms.canonicalCheckpoint({
            chain: cp.chain, network: String(bh.network || ''), block_index: Number(bh.block_index),
            block_hash:    String(bh.block_hash    || '').toLowerCase(),
            ledger_hash:   String(bh.ledger_hash   || '').toLowerCase(),
            actions_hash:  String(bh.actions_hash  || '').toLowerCase(),
            contract_hash: String(bh.contract_hash || '').toLowerCase(),
            checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block,
            // SPV Phase 2: re-derive the roots from OUR OWN indexer so we co-sign only
            // when our state_root + block_merkle_root match the proposer's (same self-
            // verification guarantee the three flat hashes already get).
            state_root:           bh.state_root           != null ? String(bh.state_root).toLowerCase()        : null,
            state_root_version:   bh.state_root_version   != null ? Number(bh.state_root_version)   : null,
            block_merkle_root:    bh.block_merkle_root    != null ? String(bh.block_merkle_root).toLowerCase() : null,
            block_merkle_version: bh.block_merkle_version != null ? Number(bh.block_merkle_version) : null,
            supersedes_from:      cp.supersedes_from,
            rules_digest:         cp.rules_digest
        });
        if(mine !== canonical) return this.noteCosignDecline('indexer_divergence', cp, divergentFields(cp, bh));

        // Matching the proposer is NOT sufficient post-flag-day. Two rootless
        // hubs agree byte-for-byte (the canonical's root suffix is empty when the roots
        // are null), so the check above passes and we would co-sign a checkpoint that
        // carries none of the light-client commitment its own flag-day requires. The
        // propose path already refuses this; refuse it here too.
        if(canonicalForms.isRootless(cp))
            return this.noteCosignDecline('rootless', cp, 'checkpoint-commitment active, light-client roots absent');

        // One payload per sequence. The leader is free to choose block_index at a given
        // snapshot_block, so this is the guard that stops a proposer collecting quorum on
        // two payloads at one sequence; every check above has already passed for BOTH of
        // them. Last thing before the co-signature leaves the hub, so a proposal this hub
        // would have declined anyway never claims the sequence.
        this.yieldToLowerRound(cp);
        if(this.declinesOffCadence(cp)) return;
        if(!this.claimSeqSignature(cp, canonical)) return;
        this.noteRoundSignature(cp.snapshot_block);

        this.peerManager.broadcast(XCHK_SIGN, {
            id: this.roundId(cp), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    },

    normalizeCheckpoint(raw){
        if(!raw || !raw.chain || !raw.network || raw.block_index == null) return null;
        let chain = String(raw.chain).toUpperCase();
        if(!ALLOWED_CHAINS.includes(chain)) return null;
        return {
            chain:          chain,
            network:        String(raw.network),
            block_index:    Number(raw.block_index),
            block_hash:     String(raw.block_hash    || '').toLowerCase(),
            ledger_hash:    String(raw.ledger_hash   || '').toLowerCase(),
            actions_hash:   String(raw.actions_hash  || '').toLowerCase(),
            contract_hash:  String(raw.contract_hash || '').toLowerCase(),
            checkpoint_seq: Number(raw.checkpoint_seq),
            snapshot_block: Number(raw.snapshot_block),
            // SPV Phase 2: carried so a peer-received checkpoint reconstructs the SAME
            // post-flag-day canonical the proposer signed. null below the flag-day.
            state_root:           raw.state_root           != null ? String(raw.state_root).toLowerCase()        : null,
            state_root_version:   raw.state_root_version   != null ? Number(raw.state_root_version)   : null,
            block_merkle_root:    raw.block_merkle_root    != null ? String(raw.block_merkle_root).toLowerCase() : null,
            block_merkle_version: raw.block_merkle_version != null ? Number(raw.block_merkle_version) : null,
            supersedes_from:      raw.supersedes_from      != null ? Number(raw.supersedes_from) : null,
            rules_digest:         raw.rules_digest         != null ? String(raw.rules_digest).toLowerCase() : null
        };
    },

    // The SWQ gate here resolves on the DEPLOYMENT network
    // (`this.network`) while StateAnchorPublisher resolves the same gate on the
    // RECORD's network (resolveQuorumNetwork(cp, ...), "gate on the RECORD network to
    // match the indexer"). Two files, one gate, two planes.
    //
    // The v1 call is kept deliberately rather than switched to cp.network. Switching
    // would make a misconfigured hub silently adopt whatever network a PEER asserts in
    // a gossiped checkpoint, which is a worse failure than the one being fixed: the
    // quorum rule would then be chosen by the sender. Instead the drift is made LOUD.
    //
    // A checkpoint whose network disagrees with this hub's deployment network is
    // refused outright. That surfaces the misconfiguration where it is diagnosable (a
    // named error naming both values) rather than at consensus time, where it appears
    // as an unexplained quorum failure or, worse, as two hubs tallying the same
    // signature set under different rules and disagreeing about whether quorum was
    // reached. Callers treat a throw as "do not sign / do not persist".
    // Scoped to a genuine disagreement between two KNOWN networks. An UNSCOPED hub
    // (this.network === '') is a different, already-documented problem: it silently
    // resolves every flag-day gate to "off" (isStakeWeightedQuorumActive returns false
    // on an unknown network) and it is what #2236 found double-crediting the COLLECT
    // rail. It is warned about loudly here but NOT refused, because refusing would take
    // every unscoped deployment offline at once, which is a far larger behavioural
    // change than this finding asks for and is not what it is about.
    assertCheckpointNetwork(cp, context){
        let recordNet = (cp && cp.network != null) ? String(cp.network) : '';
        if(recordNet === '') return;
        if(this.network === ''){
            if(!this._warnedUnscopedNetwork){
                this._warnedUnscopedNetwork = true;
                logger.warn('StateCheckpointEngine: this hub has NO deployment network, so every ' +
                    'flag-day gate (stake-weighted quorum, equivocation-header, checkpoint-commitment) ' +
                    'resolves to OFF while the checkpoints it handles are scoped to "' + recordNet +
                    '". Set HUB_NETWORK. Continuing on the legacy unscoped path.');
            }
            return;
        }
        if(recordNet === this.network) return;
        throw new Error('checkpoint network mismatch in ' + context + ': record says "' + recordNet +
            '" but this hub is deployed on "' + this.network + '". Refusing rather than ' +
            'resolving the stake-weighted-quorum gate on one plane while the anchor ' +
            'publisher resolves it on the other.');
    },

    async getMaxCheckpointSeq(chain, network){
        let r = await this.db.getStateCheckpointsMaxCheckpointSeq(chain, network);
        return (r.length > 0 && r[0].max_seq != null) ? Number(r[0].max_seq) : null;
    }

};
