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
 * XChain Hub - Full-Node Challenge Round: verdict finalize and the spend audit
 *
 * The leader's end of a round: the signed verdict canonical, the durable spend
 * audit either side of the fee, and the quorum-gated broadcast itself.
 *
 * src/consensus/full_node_challenge_round.js installs every method below on
 * FullNodeChallengeRound.prototype, non-enumerable like the class's own methods,
 * so callers and tests keep reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const fs                = require('fs');
const path              = require('path');
const eq                = require('../equivocation_header.js');
const { isAmbiguousSendError } = require('../../lib/idempotent_broadcast.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const { XNODE_DONE } = require('./message_types.js');

// Everything that must hold before a verdict fee may be spent, in the order
// maybeFinalize applied inline: the restart guard, leadership, quorum, the signer
// chain, the spend guard's check and its reservation. Null means no verdict this
// tick; the reservation it returns IS the fee, so the caller must commit or
// release it.
function claimVerdictSpend(self, state, epoch){
    // A prior process already committed this epoch's BTC fee. The epoch is
    // recomputed deterministically from the tip, so a restart inside acceptWindow
    // rebuilds the same round and can re-win leadership; without this the verdict
    // goes out a second time. Claim the round rather than merely
    // returning, so the reconstructed round stops re-entering every incoming sig.
    if(self._committedEpochs.has(epoch)){
        state.finalized = true;
        logger.warn('FullNodeChallengeRound: epoch ' + epoch + ' already carries a committed verdict spend ' +
                     'in ' + self.spendLogPath + '; NOT re-broadcasting after restart');
        return null;
    }
    let myPubkey = self.identity ? self.identity.getPubkeyHex().toLowerCase() : null;
    if(!self.isLeader(state, myPubkey)) return null;            // only the leader broadcasts
    let quorum = Math.floor((2 * state.eligible.size) / 3) + 1;
    if(state.sigs.size < quorum) return null;

    // Wrong-chain signer check FIRST, ahead of the spend guard's reservation and of
    // anything the encoder builds: a mismatch is a standing configuration fact, not
    // a transient send failure, so it must not consume this window's budget or
    // claim the round. Warned once, then the round simply stays observe-only.
    let chainMismatch = self.signerChainMismatch();
    if(chainMismatch){
        if(!self._chainMismatchWarned){ self._chainMismatchWarned = true; logger.warn(chainMismatch); }
        return null;
    }

    // Shared SpendGuard gate on the PRIMARY (leader) verdict spend path.
    // A runtime pause (per-capability) or an exhausted per-window spend ceiling
    // DEFERS finalization (return without claiming the round) so a later tick
    // retries once resumed/budget frees. Checked BEFORE the finalize lock so a
    // paused publisher never claims-then-reverts, and never spends on the leader
    // path (the enabled kill-switch only gated start(), not this send).
    let g = self.spendGuard.check();
    if(!g.ok){ logger.warn('FullNodeChallengeRound: ' + g.reason + ' (epoch ' + epoch + '); deferring verdict broadcast'); return null; }

    // RESERVE on top of that check: broadcastVerdict is AWAITED, and the pure
    // predicate pair check()/record() leaves a window in which every epoch that
    // crosses quorum inside it reads the same pre-send budget and all of them
    // spend. The reservation consumes the budget in this synchronous turn, and it
    // IS the recorded spend, so record() must never also run for it. check() stays
    // above because reserve() takes no balance argument, so dropping it would
    // silently retire the wallet floor. Same shape RollcallRound.publishPairs and
    // lib/idempotent_broadcast.broadcastOnce use.
    let spendToken = self.spendGuard.reserve();
    if(!spendToken){
        logger.warn('FullNodeChallengeRound: ' + self.spendGuard.noteBlocked() +
                     ' (epoch ' + epoch + '); deferring verdict broadcast');
        return null;
    }
    return { quorum, spendToken };
}

// A verdict that reached the wire: charge the reservation, record the send and
// tell peers to stop. The rank marker is what makes a failover verdict visible.
function recordVerdictSent(self, state, epoch, quorum, spendToken, res){
    self.spendGuard.commit(spendToken);   // the reservation IS the BTC fee charged
    state.txid = res && res.txid ? res.txid : null;
    // Mirror the reload rule in-process, so a spend is gated identically
    // whether the log was read at start() or written this run.
    self._committedEpochs.add(epoch);
    // Name the rank this verdict was broadcast at, in the durable spend record
    // and in the log line. A failover verdict (leadRank > 0, the ladder in
    // tick promoting the next rank after each closeDepth of height with no
    // verdict) is otherwise byte-identical to a healthy rank-0 verdict in every
    // observable signal, so a dead elected leader stays invisible while the
    // ladder absorbs its rounds. Same marker StateAnchorPublisher carries at
    // its own anchor publish.
    let leadRank = Number(state.leadRank) || 0;
    self.recordSpend({ phase: 'sent', epoch, challengeId: state.challengeId, txid: state.txid, leadRank });
    self.peerManager && self.peerManager.broadcast(XNODE_DONE, { epoch, challengeId: state.challengeId, txid: state.txid });
    logger.info('FullNodeChallengeRound: verdict broadcast epoch=' + epoch + ' pass=' + state.passList.length +
                ' sigs=' + state.sigs.size + '/' + quorum + (state.txid ? ' txid=' + state.txid : '') +
                (leadRank > 0
                    ? ' [FAILOVER: broadcast at backup rank ' + leadRank + ' of ' + state.eligible.size +
                      '; the rank-0 leader did not land a verdict for this epoch]'
                    : ''));
}

// Never blind-retry an AMBIGUOUS send. A timeout / reset / 5xx
// after the request left the wire may mean the BTC node accepted the
// verdict tx; reverting the finalize lock would let a later tick
// re-broadcast and double-spend the fee (same-challenge NODEPROOF replay).
// Keep the round claimed (no retry); an operator verifies on-chain, and a
// fresh epoch re-challenges if it truly never landed. Only a DEFINITIVE
// pre-send/reject failure unlocks for retry.
function settleFailedVerdict(self, state, epoch, spendToken, e){
    if(isAmbiguousSendError(e)){
        // The whole point of the intent record: an ambiguous send may have cost
        // a fee, and the round is deliberately left claimed. Say so on disk, so
        // the operator reconciling on-chain has the challenge_id without stdout.
        self._committedEpochs.add(epoch);   // a fee may have been paid
        // COMMIT, not release: the round is left claimed precisely because the
        // verdict may be on the wire, so its fee must be charged to the window.
        // Releasing here is what let a later epoch spend an allowance this
        // possibly-paid fee had already consumed.
        self.spendGuard.commit(spendToken);
        self.recordSpend({ phase: 'ambiguous', epoch, challengeId: state.challengeId,
                            error: e && e.message ? String(e.message).slice(0, 200) : String(e) });
        logger.warn(nodeUtil.format('FullNodeChallengeRound: AMBIGUOUS verdict send (epoch ' + epoch +
                     '); NOT re-broadcasting to avoid a double spend:', e && e.message ? e.message : e));
    } else {
        // Definitive: nothing left this process, so the budget goes back and a
        // later tick can retry inside the same window.
        self.spendGuard.release(spendToken);
        self.recordSpend({ phase: 'failed', epoch, challengeId: state.challengeId,
                            error: e && e.message ? String(e.message).slice(0, 200) : String(e) });
        state.finalized = false;   // definitive failure; unlock so a later sig/tick retries
        logger.warn(nodeUtil.format('FullNodeChallengeRound: verdict broadcast failed (epoch ' + epoch + '):', e && e.message ? e.message : e));
    }
}

module.exports = {

    // Defence in depth behind signer-loader's chain gate: name any hook wired for
    // another coin. The loader is the only production wiring path, but a hook set
    // directly (a driver, a future wiring site, an operator patch) would otherwise
    // sign a BTC verdict with a foreign key and pay that chain's fee for a payload
    // BTC cannot read. Returns a reason string, or null when the wiring is sound.
    signerChainMismatch(){
        let wrong = [];
        if(this._broadcastHookChain && this._broadcastHookChain !== this.signingChain)
            wrong.push('broadcast hook wired for ' + this._broadcastHookChain);
        if(this._signHookChain && this._signHookChain !== this.signingChain)
            wrong.push('wallet-sign hook wired for ' + this._signHookChain);
        if(!wrong.length) return null;
        return 'FullNodeChallengeRound: REFUSING to publish a NODEPROOF verdict: it settles on ' +
               this.signingChain + ' but the ' + wrong.join(' and ') + '. Nothing was built, funded or ' +
               'signed. Configure a HUB_SIGNER_MODULE declaring chains: [\'' + this.signingChain +
               '\'], or leave this round observe-only.';
    },

    // A peer landed the verdict: the round is over here too, and its txid is the
    // one that landed.
    onDone(d){
        let state = this.rounds.get(Number(d.epoch));
        if(!state) return;
        state.finalized = true;
        state.txid = d.txid || state.txid;
    },

    // The verdict spend log is read back here because a durable intent that nothing
    // reads back guards only one process lifetime, not a restart. Fold the
    // append-only log into the set of epochs whose fee is already committed, using the
    // same sticky rules as AttestationRelay._loadWal: a terminal 'sent' or 'ambiguous'
    // is committed and never cleared, a bare 'intent' counts as committed (fail closed
    // toward NOT spending twice, since the tx may have reached the node), and only a
    // 'failed' - the definitive pre-send failure where _maybeFinalize itself unlocks
    // the round - clears a bare intent so a genuine retry still runs. Read-only: the
    // log stays append-only and is never rewritten here.
    //
    // The fold is LAST-RECORD-WINS below the sticky 'sent', not first-record-wins: an
    // epoch that failed definitively and then retried appends a SECOND intent, and
    // that intent must re-arm the guard exactly like the first one. Keying the intent
    // clause on 'no prior record' instead dropped it, so intent/failed/intent - retry,
    // then crash after the node accepted - reloaded as uncommitted and re-broadcast,
    // which is the very failure mode this durable guard exists to prevent.
    loadSpendLog(){
        let text;
        try { text = fs.readFileSync(this.spendLogPath, 'utf8'); }
        catch(e){ return; }   // absent on a first run
        let outcome = new Map();
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }   // a torn tail line
            let epoch = Number(rec.epoch);
            if(!Number.isFinite(epoch)) continue;
            let prior = outcome.get(epoch);
            if(rec.phase === 'sent' || rec.phase === 'ambiguous') outcome.set(epoch, 'sent');
            else if(prior === 'sent') continue;                                    // terminal, never cleared
            else if(rec.phase === 'failed') outcome.set(epoch, 'failed');          // clears a bare intent
            else if(rec.phase === 'intent') outcome.set(epoch, 'intent');          // including a retry's
        }
        for(let [epoch, state] of outcome)
            if(state === 'sent' || state === 'intent') this._committedEpochs.add(epoch);
    },

    async maybeFinalize(epoch){
        let state = this.rounds.get(epoch);
        if(!state || state.finalized || !state.passList) return;
        let claim = claimVerdictSpend(this, state, epoch);
        if(!claim) return;
        let { quorum, spendToken } = claim;

        // Optimistic finalize lock: maybeFinalize runs on EVERY incoming XNODE_SIGN
        // (and from closeCollection), so without claiming the round BEFORE the async
        // broadcast, two sigs that cross quorum within the broadcast's await window both
        // pass the `finalized` guard above and the leader emits the NODEPROOF verdict tx
        // twice (wasted BTC fee; the second is a same-challenge replay). Claim the round
        // now and revert on failure so a later sig/tick can still retry.
        state.finalized = true;
        let wire = this.buildVerdictWire(state);

        // Durable intent record BEFORE the money moves, and the broadcast
        // is GATED on it, matching the rule AttestationPublisher states at its own
        // durable append: an unwritable audit path must not let a real BTC fee be
        // spent with no recoverable trace. Failing here reverts the finalize lock, so
        // this defers the verdict to a later tick rather than losing the round.
        if(!this.recordSpend({ phase: 'intent', epoch, challengeId: state.challengeId,
                                pass: state.passList.length, sigs: state.sigs.size, quorum })){
            state.finalized = false;
            // Nothing was broadcast, so the reservation goes back; keeping it would
            // charge the window for a verdict this tick deliberately did not send.
            this.spendGuard.release(spendToken);
            logger.error('FullNodeChallengeRound: spend-audit path unwritable at ' + this.spendLogPath +
                          '; deferring the verdict broadcast for epoch ' + epoch +
                          ' rather than spending a BTC fee with no durable record');
            return;
        }

        try {
            let res = await this.broadcastVerdict(wire);
            recordVerdictSent(this, state, epoch, quorum, spendToken, res);
        } catch(e){
            settleFailedVerdict(this, state, epoch, spendToken, e);
        }
    },

    // Append one fsync'd spend-audit line. Returns true only on a
    // confirmed durable write; the intent call SITES the gate on that result, the
    // outcome calls are best-effort (the fee is already committed by then, so
    // refusing to proceed would help nobody). Mirrors AttestationPublisher.recordSpend,
    // including creating the directory lazily so a fresh hub does not need it
    // provisioned ahead of its first verdict.
    recordSpend(entry){
        let line = JSON.stringify({ ts: Date.now(), effector: 'FULLNODE_VERDICT', ...entry }) + '\n';
        try {
            fs.mkdirSync(path.dirname(this.spendLogPath), { recursive: true });
            let fd = fs.openSync(this.spendLogPath, 'a');
            try {
                fs.writeSync(fd, line);
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            return true;
        } catch (e) {
            logger.error(nodeUtil.format('FullNodeChallengeRound: failed to write spend-audit record to ' +
                          this.spendLogPath + ':', e && e.message ? e.message : e));
            return false;
        }
    },

    // CONSENSUS-CRITICAL: must byte-match the indexer's nodeproof.js canonical.
    verdictCanonical(challengeId, epoch, sortedPassList){
        let raw = challengeId + '|' + epoch + '|' + sortedPassList.join(',');
        if(eq.isEquivHeaderActive(epoch, this.network))
            raw = eq.buildEquivCanonical(eq.ENGINE_TAGS.NODEPROOF, challengeId, 0, raw);
        return raw;
    }
};
