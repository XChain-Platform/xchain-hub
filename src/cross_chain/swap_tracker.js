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
 * XChain Hub - SWAP Lifecycle Tracker
 *
 * Tracks cross-chain SWAP actions through their lifecycle:
 * initiated → attested → executed → settled
 *
 * Listens to CrossChainEngine attestation:finalized events to
 * automatically progress swap status.
 *
 ********************************************************************/

class SwapTracker {

    constructor(hub) {
        this.hub = hub;
        this.db  = hub.db;
        this._attestationHandler = null;
    }

    start(crossChainEngine) {
        if (!crossChainEngine) return;
        this._attestationHandler = (attestation) => {
            this.onAttestationFinalized(attestation).catch(err =>
                console.error('SwapTracker: attestation:finalized handling failed:', err && err.message ? err.message : err));
        };
        crossChainEngine.on('attestation:finalized', this._attestationHandler);
        console.log('SWAP tracker started');
    }

    stop(crossChainEngine) {
        if (this._attestationHandler && crossChainEngine) {
            crossChainEngine.removeListener('attestation:finalized', this._attestationHandler);
            this._attestationHandler = null;
        }
    }

    async initiateSwap(sourceChain, sourceActionIndex, destChain, destActionIndex) {
        await this.db.createSwapRecord(
            sourceChain, sourceActionIndex, destChain, destActionIndex || null,
            destChain, destActionIndex || null
        );
        console.log('SWAP: Initiated ' + sourceChain + ':' + sourceActionIndex + ' → ' + destChain);
    }

    async getSwap(sourceChain, sourceActionIndex) {
        let rows = await this.db.getSwapRecordBySourceAction(sourceChain, sourceActionIndex);
        return rows.length > 0 ? rows[0] : null;
    }

    async getSwaps(status, limit) {
        // Two statements, not one built string: an absent status drops the WHERE
        // clause entirely rather than matching on a null.
        if (status) return await this.db.findSwapRecordsByStatus(status, limit || 50);
        return await this.db.findSwapRecords(limit || 50);
    }

    async updateSwapStatus(sourceChain, sourceActionIndex, status, attestationId) {
        // An absent attestation id leaves the column untouched, so the write that
        // carries one is a separate statement rather than a stamped null.
        if (attestationId) {
            await this.db.updateSwapRecordStatusAndAttestation(status, attestationId, sourceChain, sourceActionIndex);
            return;
        }
        await this.db.updateSwapRecordStatus(status, sourceChain, sourceActionIndex);
    }

    // Called when an attestation is finalized; progresses matching swap to 'attested'
    async onAttestationFinalized(attestation) {
        if (!attestation || !attestation.sourceChain || !attestation.sourceActionIndex) return;

        let swap = await this.getSwap(attestation.sourceChain, attestation.sourceActionIndex);
        if (swap && swap.status === 'initiated') {
            await this.updateSwapStatus(
                attestation.sourceChain,
                attestation.sourceActionIndex,
                'attested',
                attestation.attestationId
            );
            console.log('SWAP: Attested ' + attestation.sourceChain + ':' + attestation.sourceActionIndex);
        }
    }
}

module.exports = SwapTracker;
