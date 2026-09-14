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
 * XChain Hub - Cross-Chain Bring-Up
 *
 * The cross-chain family: the attestation engine and its DEX, XCALL and
 * XBRIDGE siblings, the checkpoint and anchor publishers that settle their
 * state, and the read surface over swaps and calls.
 *
 ********************************************************************/



class CrossChain {

    async startCrossChain(){
        if(!this.peerManager) return;
        const { CrossChainEngine, SwapTracker, CrossChainDexEngine, CrossChainCallEngine,
                CrossChainBridgeEngine, StateCheckpointEngine, RetractionConsensus,
                StateAnchorPublisher } = this.constructor.modules;
        this.crossChain = new CrossChainEngine(this);
        let validators = await this._loadValidatorSet();
        this.crossChain.setValidatorSet(validators);

        let chainPairMap = await this.loadChainPairValidators();
        this.crossChain.setChainPairValidators(chainPairMap);

        this.swapTracker = new SwapTracker(this);
        this.swapTracker.start(this.crossChain);

        await this.crossChain.start();

        // Matches cross-chain ORDER/SWAP offers and drives their settlement over the
        // validator-broadcast XSETTLE rail. Idles harmlessly unless at least one chain's
        // <COIN>_INDEXER_URL is configured.
        this.crossChainDex = new CrossChainDexEngine(this);
        await this.crossChainDex.start();

        // XCALL: confirmation-gates contract-emitted call requests, PBFTs the dispatch and
        // result rows, and mirrors them to indexers on the same transport as
        // cross_chain_matches, so a call costs no chain write. Idles without indexer URLs.
        this.crossChainCalls = new CrossChainCallEngine(this);
        await this.crossChainCalls.start();

        // XBRIDGE: confirmation-gates lock/burn legs, PBFTs the transfer record and the
        // per-token policy snapshot, and mirrors both to indexers. Idles below the
        // activation gate and without indexer URLs.
        this.crossChainBridge = new CrossChainBridgeEngine(this);
        await this.crossChainBridge.start();

        // Quorum-signed per-chain ledger/actions/contract hash commitments, written
        // off-chain to state_checkpoints and streamed over the hub-DB mirror so explorers
        // and wallets can verify indexer state.
        this.stateCheckpoints = new StateCheckpointEngine(this);
        await this.stateCheckpoints.start();

        // Signed retractions: collects 2f+1 co-signatures over quorum-class
        // reorg-retraction broadcasts before they reach the mirror stream. The engines
        // route their retract-path deletions through it; below the flag-day or without an
        // identity they fall through to the legacy unsigned broadcast.
        this.retractionConsensus = new RetractionConsensus(this);

        // Commits the latest checkpoints (v0) and the cross-chain match archive (v1/v2) on
        // DOGE so federation state is recoverable from chain parse alone. A clean no-op
        // when DOGE publishing is not configured.
        this.stateAnchorPublisher = new StateAnchorPublisher(this);
        await this.stateAnchorPublisher.start();
    }

    getCrossChain(){
        return this.crossChain;
    }

    getCrossChainDex(){
        return this.crossChainDex;
    }

    async requestAttestation(sourceChain, sourceActionIndex, destChain){
        if(!this.crossChain) throw new Error('Cross-chain engine not active');
        return await this.crossChain.requestAttestation(sourceChain, sourceActionIndex, destChain);
    }

    async initiateSwap(sourceChain, sourceActionIndex, destChain, destActionIndex){
        if(!this.swapTracker) throw new Error('SWAP tracker not active');
        await this.swapTracker.initiateSwap(sourceChain, sourceActionIndex, destChain, destActionIndex);
        return true;
    }

    async getSwap(sourceChain, sourceActionIndex){
        if(!this.swapTracker) return null;
        return await this.swapTracker.getSwap(sourceChain, sourceActionIndex);
    }

    async getSwaps(status, limit){
        if(!this.swapTracker) return [];
        return await this.swapTracker.getSwaps(status, limit);
    }

    // Read-only views of the hub's own cross_chain_calls table: getCrossChainCall
    // resolves a call_id to both XCALL phases of one call's lifecycle, and
    // listCrossChainCalls lists rows under optional filters.
    async getCrossChainCall(callId){
        if(!this.crossChainCalls) return null;
        return await this.crossChainCalls.getCall(callId);
    }

    async listCrossChainCalls(filters){
        if(!this.crossChainCalls) return [];
        return await this.crossChainCalls.listCalls(filters);
    }
}

module.exports = CrossChain;
