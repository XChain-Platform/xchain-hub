/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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

    // Subscribe to attestation events from CrossChainEngine
    start(crossChainEngine) {
        if (!crossChainEngine) return;
        this._attestationHandler = (attestation) => this._onAttestationFinalized(attestation);
        crossChainEngine.on('attestation:finalized', this._attestationHandler);
        console.log('SWAP tracker started');
    }

    stop(crossChainEngine) {
        if (this._attestationHandler && crossChainEngine) {
            crossChainEngine.removeListener('attestation:finalized', this._attestationHandler);
            this._attestationHandler = null;
        }
    }

    // Record a new SWAP initiation
    async initiateSwap(sourceChain, sourceActionIndex, destChain, destActionIndex) {
        let query = `INSERT INTO swap_records
            (source_chain, source_action_index, dest_chain, dest_action_index, status)
            VALUES (?, ?, ?, ?, 'initiated')
            ON DUPLICATE KEY UPDATE dest_chain = ?, dest_action_index = ?, updated_at = NOW()`;
        await this.db.doQuery(query, [
            sourceChain, sourceActionIndex, destChain, destActionIndex || null,
            destChain, destActionIndex || null
        ]);
        console.log('SWAP: Initiated ' + sourceChain + ':' + sourceActionIndex + ' → ' + destChain);
    }

    // Get a specific swap by source
    async getSwap(sourceChain, sourceActionIndex) {
        let query = "SELECT * FROM swap_records WHERE source_chain = ? AND source_action_index = ? LIMIT 1";
        let rows = await this.db.doQuery(query, [sourceChain, sourceActionIndex]);
        return rows.length > 0 ? rows[0] : null;
    }

    // Query swaps by status
    async getSwaps(status, limit) {
        let query = "SELECT * FROM swap_records";
        let args = [];
        if (status) {
            query += " WHERE status = ?";
            args.push(status);
        }
        query += " ORDER BY created_at DESC LIMIT ?";
        args.push(limit || 50);
        return await this.db.doQuery(query, args);
    }

    // Update swap status
    async updateSwapStatus(sourceChain, sourceActionIndex, status, attestationId) {
        let query = "UPDATE swap_records SET status = ?";
        let args = [status];
        if (attestationId) {
            query += ", attestation_id = ?";
            args.push(attestationId);
        }
        query += ", updated_at = NOW() WHERE source_chain = ? AND source_action_index = ?";
        args.push(sourceChain, sourceActionIndex);
        await this.db.doQuery(query, args);
    }

    // Called when an attestation is finalized — progress matching swap to 'attested'
    async _onAttestationFinalized(attestation) {
        if (!attestation || !attestation.sourceChain || !attestation.sourceActionIndex) return;

        // Check if there's a swap record matching this attestation
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
