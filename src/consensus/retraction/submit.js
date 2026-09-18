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

        let snapshotBlock = await this.resolveSnapshotBlock();
        if(snapshotBlock == null || !gateRegistry.activeAt(RETRACTION_SIGNING_KEY, this.network, null, snapshotBlock, null))
            return this.broadcastUnsigned(evt);

        let validators = await this.resolveCapabilityValidators('cross_chain', snapshotBlock, this.network);
        if(!validators.length) return this.broadcastUnsigned(evt);

        let signedEvt = Object.assign({}, evt, { snapshot_block: Number(snapshotBlock) });
        let canonical = retractionClass().canonicalRetraction(signedEvt);
        let id        = this.roundId(canonical);
        if(this.pending.has(id) || this.finalized.has(id)) return;   // duplicate submit (e.g. per-row DEX loop)

        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, this.network);
        let snapCount = validators.length;
        let quorum   = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        if(snapCount <= 1){
            await this.finalize(signedEvt, canonical, id, [{ pubkey: myPubkey, sig: mySig }], true);
            return;
        }

        openSigningRound(this, { evt, signedEvt, canonical, id, myPubkey, mySig,
            quorum, weighted, validators });
        this.checkQuorum(id);
    }
};

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
