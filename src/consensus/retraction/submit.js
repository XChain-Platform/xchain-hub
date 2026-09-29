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
 * XChain Hub - Retraction Consensus: initiator
 *
 * The initiator side: record what our own indexer pushed, then either run the
 * signing round or fall through to the legacy unsigned broadcast.
 *
 * src/consensus/retraction.js installs every method below on
 * RetractionConsensus.prototype, non-enumerable like the class's own methods,
 * so callers and tests keep reaching them as retraction.<method>().
 *
 ********************************************************************/

'use strict';

const swq               = require('../stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
// The signed-retraction flag day is a registry row read by literal key (W5), on the
// retraction's BTC-anchored snapshot block.
const gateRegistry = require('../gate_registry');
const RETRACTION_SIGNING_KEY = 'retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION';
const { getLogger } = require('../../observability');
const logger = getLogger();

const { retractionClass } = require('./canonical.js');
const { XRETRACT_SIGN_REQ, QUORUM_CLASS_TABLES } = require('./wire.js');

module.exports = {

    // Entry point from the engines' retract paths, in place of a direct
    // broadcaster.broadcastDeletion(evt). Records the local intent (our own
    // indexer pushed this), then either runs the signing round (gate active)
    // or falls through to the legacy unsigned broadcast.
    async submitLocal(evt){
        this.pruneIntents();
        this.localIntents.set(retractionClass().intentKey(evt), Date.now());

        if(!QUORUM_CLASS_TABLES.has(String(evt.table))) return this.broadcastUnsigned(evt);
        if(!this.identity || !this.peerManager || !this.capSnapshot) return this.broadcastUnsigned(evt);

        return submitQuorumRetraction(this, evt, null);
    }
};

async function submitQuorumRetraction(self, evt, deferral){
    let snapshotBlock = await self.resolveSnapshotBlock();
    if(snapshotBlock == null){
        deferSigningRound(self, evt, 'snapshot block is unavailable', deferral);
        return;
    }
    if(!gateRegistry.activeAt(RETRACTION_SIGNING_KEY, self.network, null, snapshotBlock, null)){
        if(deferral)
            logger.info(retryLabel(deferral) + 'resolved below the signing gate; broadcasting unsigned');
        clearDeferral(self, evt, deferral);
        return self.broadcastUnsigned(evt);
    }

    let validators = await self.resolveCapabilityValidators('cross_chain', snapshotBlock, self.network);
    if(!validators.length){
        deferSigningRound(self, evt, 'validator set is empty', deferral);
        return;
    }
    clearDeferral(self, evt, deferral);

    let signedEvt = Object.assign({}, evt, { snapshot_block: Number(snapshotBlock) });
    let canonical = retractionClass().canonicalRetraction(signedEvt);
    let id        = self.roundId(canonical);
    if(self.pending.has(id) || self.finalized.has(id)){
        if(deferral) logger.info(retryLabel(deferral) + 'resolved to an existing signed round');
        return;
    }

    let myPubkey = self.identity.getPubkeyHex().toLowerCase();
    let mySig    = self.identity.sign(canonical);
    let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, self.network);
    let snapCount = validators.length;
    let quorum   = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

    if(snapCount <= 1){
        if(deferral) logger.info(retryLabel(deferral) + 'resolved; finalizing a single-validator signed round');
        await self.finalize(signedEvt, canonical, id, [{ pubkey: myPubkey, sig: mySig }], true);
        return;
    }

    openSigningRound(self, { evt, signedEvt, canonical, id, myPubkey, mySig,
        quorum, weighted, validators });
    self.checkQuorum(id);
    if(deferral) logger.info(retryLabel(deferral) + 'resolved; opened signed round ' + id.substring(0, 16) + '...');
}

function deferSigningRound(self, evt, reason, deferral){
    if(deferral){
        deferral.reason = reason;
        logger.warn(retryLabel(deferral) + 'still deferred because the ' + reason);
        scheduleDeferredRetry(self, deferral);
        return;
    }

    if(!self._retractionSubmitDeferrals) self._retractionSubmitDeferrals = new Map();
    let key = retractionClass().intentKey(evt);
    let existing = self._retractionSubmitDeferrals.get(key);
    if(existing && self.pending.get(existing.id) === existing){
        existing.evt = evt;
        return;
    }
    if(existing) self._retractionSubmitDeferrals.delete(key);

    let state = {
        id: 'deferred:' + key,
        key,
        evt,
        reason,
        attempts: 0,
        done: true,
        validators: [],
        signatures: new Map(),
        retryTimer: null,
        timeoutTimer: null
    };
    self._retractionSubmitDeferrals.set(key, state);
    self.pending.set(state.id, state);
    logger.warn('RetractionConsensus: deferring signed retraction ' + key + ' because the ' + reason);
    scheduleDeferredRetry(self, state);
}

function scheduleDeferredRetry(self, state){
    if(state.retryTimer || self.pending.get(state.id) !== state) return;
    let base = Number.isFinite(self.retrySignReqMs) && self.retrySignReqMs > 0 ? self.retrySignReqMs : 15000;
    let ceiling = Number.isFinite(self.roundTimeoutMs) && self.roundTimeoutMs > 0
        ? Math.max(base, self.roundTimeoutMs) : 180000;
    let delay = Math.min(ceiling, base * Math.pow(2, Math.min(state.attempts, 16)));
    state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        if(self.pending.get(state.id) !== state) return;
        state.attempts++;
        submitQuorumRetraction(self, state.evt, state).catch(error => {
            logger.warn(retryLabel(state) + 'failed: ' + (error && error.message));
            scheduleDeferredRetry(self, state);
        });
    }, delay);
    if(state.retryTimer.unref) state.retryTimer.unref();
}

function clearDeferral(self, evt, deferral){
    let state = deferral;
    if(!state && self._retractionSubmitDeferrals){
        let key = retractionClass().intentKey(evt);
        state = self._retractionSubmitDeferrals.get(key);
    }
    if(!state) return;
    if(state.retryTimer){
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
    }
    if(self.pending.get(state.id) === state) self.pending.delete(state.id);
    if(self._retractionSubmitDeferrals && self._retractionSubmitDeferrals.get(state.key) === state)
        self._retractionSubmitDeferrals.delete(state.key);
}

function retryLabel(state){
    return 'RetractionConsensus: signed retraction retry ' + state.attempts + ' for ' + state.key + ' ';
}

// Record the round, arm the re-ask and the timeout that falls back to the legacy
// unsigned broadcast, and ask the federation to sign. `evt` is the caller's own
// unsigned event, which is what a timed-out round broadcasts.
function openSigningRound(self, ctx){
    let { evt, signedEvt, canonical, id, myPubkey, mySig, quorum, weighted, validators } = ctx;
    let pendingValidators = validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0')) }));
    if(validators.truncated === true) pendingValidators.truncated = true;
    let pending = {
        id, evt: signedEvt, canonical, quorum, weighted,
        validators: pendingValidators,
        signatures: new Map([[myPubkey, mySig]]),
        done: false, timeoutTimer: null, retryTimer: null
    };
    self.pending.set(id, pending);

    let signReq = { retraction: signedEvt, sig_pubkey: myPubkey, sig: mySig };
    // Followers can only sign once their own indexer observes the reorg,
    // which lags ours by an unknowable few seconds/blocks: keep re-asking
    // until quorum or timeout instead of relying on one broadcast.
    pending.retryTimer = setInterval(() => self.peerManager.broadcast(XRETRACT_SIGN_REQ, signReq), self.retrySignReqMs);
    if(pending.retryTimer.unref) pending.retryTimer.unref();
    pending.timeoutTimer = setTimeout(() => {
        self.pending.delete(id);
        if(pending.retryTimer) clearInterval(pending.retryTimer);
        if(!pending.done){
            // Liveness over the signature tier: mirrors past the gate refuse the
            // unsigned event anyway (fail closed there), mirrors below it still
            // converge under the activation fences. Never silently drop a retraction.
            logger.warn('RetractionConsensus: round ' + id.substring(0, 16) + '... timed out at ' +
                pending.signatures.size + '/' + pending.quorum + ' sigs, broadcasting UNSIGNED (legacy tier)');
            self.broadcastUnsigned(evt);
        }
    }, self.roundTimeoutMs);
    if(pending.timeoutTimer.unref) pending.timeoutTimer.unref();

    self.peerManager.broadcast(XRETRACT_SIGN_REQ, signReq);
}
