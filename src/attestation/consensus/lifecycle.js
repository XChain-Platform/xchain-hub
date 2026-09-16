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
 * XChain Hub - Attestation Consensus Lifecycle
 *
 * Attaching to and detaching from the peer wire, and the one sizing floor that
 * is checked out loud at start and again whenever governance moves the provider
 * deadline window it derives from.
 *
 ********************************************************************/

'use strict';
const { getLogger } = require('../../observability');
const logger = getLogger();
const { NONOK_THROUGHPUT_PER_BLOCK } = require('./constants.js');

module.exports = {

    // item 3421 - observability for the nonOkPublished ring's SIZING FLOOR (see the
    // constructor). The cap is a fixed operator/env value read once at startup, but
    // the horizon it must clear is max(deadline_window_blocks), which is governance-
    // controlled JSON that ProviderRegistry loads verbatim and that nothing bounds.
    // A routine proposal raising http_get's window past 100, or registering a
    // provider with a longer one, silently invalidates the floor: nothing failed,
    // nothing warned, and the first symptom was nonOkEvictedWhilePendingCount rising
    // AFTER real BTC fees had already been re-burned on retry rounds. Deliberately
    // log-only and non-throwing: an undersized ring wastes fees, it does not fork, so
    // refusing to run would be the worse failure. Called at start() and again from
    // XChainHub after every provider hotReload, i.e. the moment governance lands.
    checkNonOkSizingFloor(){
        if(!this.providerRegistry || typeof this.providerRegistry.maxDeadlineWindowBlocks !== 'function') return null;
        let { blocks, providerId } = this.providerRegistry.maxDeadlineWindowBlocks();
        if(!(blocks > 0)) return null;
        let floor = blocks * NONOK_THROUGHPUT_PER_BLOCK;
        let ok    = this.nonOkPublishedMax >= floor;
        if(!ok){
            logger.warn('AttestationConsensus: ATTESTATION_NONOK_PUBLISHED_MAX=' + this.nonOkPublishedMax +
                ' is BELOW the sizing floor of ' + floor + ' implied by provider "' + providerId +
                '" (deadline_window_blocks=' + blocks + ' x ' + NONOK_THROUGHPUT_PER_BLOCK +
                ' non-ok finalizations/block). A still-pending non-ok entry can be evicted while ' +
                'retry rounds keep running, and each later retry re-quorum-signs and re-broadcasts ' +
                'the same failure status, burning a BTC tx per poll cycle. Raise ' +
                'ATTESTATION_NONOK_PUBLISHED_MAX to at least ' + floor + ' or lower that window.');
        }
        return { ok, floor, cap: this.nonOkPublishedMax, blocks, providerId };
    },

    async stop(){
        if(this._messageHandler){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for(let [_, p] of this.pending){
            if(p.timer) clearTimeout(p.timer);
        }
        this.pending.clear();
        this.earlyMessages.clear();
        this.earlyMessageTtl.clear();
        this.earlyCommits.clear();
        this.nonOkPublished.clear();
        this._nonOkPublishedOrder = [];
        this.tornDown.clear();
        this._tornDownOrder = [];
        this.proposerSeen.clear();
        this._proposerSeenOrder = [];
    }

};
