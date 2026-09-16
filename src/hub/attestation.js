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
 * XChain Hub - Attestation Bring-Up
 *
 * The attestation family: the consensus round and its provider registry, the
 * publishers and the mirror that serve a finalized request, the relay, and
 * the two liveness engines (full-node challenge and roll call).
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

// The provider registry and the consensus round that reads it.
async function constructAttestationRound(hub, modules) {
    const { ProviderRegistry, AttestationConsensus, AttestationRound } = modules;
    hub.providerRegistry = new ProviderRegistry(hub);
    await hub.providerRegistry.load();
    // Rebuild the block-anchored provider-config history from finalized governance
    // proposals so a freshly-started hub resolves the same fetch/judge model per block
    // as a long-running one.
    await hub.providerRegistry.loadGovernanceHistory();

    hub.attestationConsensus = new AttestationConsensus(hub, hub.providerRegistry);
    hub.attestationRound     = new AttestationRound(hub, hub.providerRegistry);
    hub.attestationRound.setConsensus(hub.attestationConsensus);
}

// Everything that serves a finalized request: the publisher, the mirror that
// replaced its response leg, the batch publisher and the relay.
function constructAttestationPublishers(hub, modules) {
    const { AttestationPublisher, AttestationSpotChecker, AttestationResponseMirror,
            AttestationBatchPublisher, AttestationRelay, loadSignerHooks, applySignerHooks } = modules;
    hub.attestationPublisher  = new AttestationPublisher(hub);
    // Mirrors startOracle's HUB_SIGNER_MODULE wiring: without it a validator finalizes
    // ATTEST responses but never broadcasts them and the queue grows forever.
    // Wired on the DOGE rail it has always used. Its response leg is retired in
    // practice by AttestationResponseMirror, and the leg's own chain
    // declaration belongs with that retirement, not with this change; the
    // AttestationPublisher/AttestationRelay files are owned elsewhere right now.
    let attestationSignerHooks = loadSignerHooks();
    if(attestationSignerHooks && applySignerHooks(hub.attestationPublisher, attestationSignerHooks, 'DOGE')){
        logger.info('AttestationPublisher: operator signer wired (' + attestationSignerHooks.source + ')');
    }
    hub.attestationSpotChecker = new AttestationSpotChecker(hub, hub.providerRegistry);

    // The mirror producer, and the publisher's counterpart above the ATTEST
    // response mirror activation height: the publisher declines a mirror-era
    // request and this writes its row instead, so exactly one of the two serves
    // every finalized round. Needs no signer wiring at all, which is the point of
    // the design: a mirrored response costs no validator a chain transaction.
    hub.attestationResponseMirror = new AttestationResponseMirror(hub);

    // The mirror's chain-side counterpart: one ATTEST v5 head (plus v6
    // continuations) per window on the DOGE rail, so the response history stays
    // reconstructible from chain parse even though no response is its own
    // transaction. Third consumer of the one operator signer and wallet, with its
    // own buffer, dead-letter, spend budget and marker table; it schedules nothing
    // on a network whose mirror activation entry is null.
    hub.attestationBatchPublisher = new AttestationBatchPublisher(hub);
    if(attestationSignerHooks){
        applySignerHooks(hub.attestationBatchPublisher, attestationSignerHooks, 'DOGE');
    }

    // Cross-chain relay driver, opt-in via ATTEST_RELAY_ENABLED=1 and a no-op otherwise,
    // so merely deploying it changes nothing. Its v3 request leg broadcasts on BTC and
    // so takes the SAME operator signer the publisher uses; its v4 response leg
    // broadcasts on the ORIGIN chain and is wired separately, by <COIN>_ENCODER_URL plus
    // <COIN>_ADDRESS or by an explicit setChainBroadcastHook. An operator broadcast hook
    // builds and sends on the one chain it was configured for, so it must never be
    // handed a foreign-chain leg.
    //
    // Wired on DOGE, unchanged: the relay owns its own per-chain rails
    // (setChainWalletSignHook) and its file is owned elsewhere right now, so its
    // home-leg chain declaration is deliberately left to that owner.
    hub.attestationRelay = new AttestationRelay(hub);
    if(attestationSignerHooks){
        applySignerHooks(hub.attestationRelay, attestationSignerHooks, 'DOGE');
    }
}

// Governance-driven reloads of the provider registry and the capability
// thresholds. No-op until startGovernance has run.
function wireGovernanceReloads(hub) {
    if(hub.governance && typeof hub.governance.on === 'function'){
        hub.governance.on('proposal:finalized', () => {
            hub.providerRegistry.hotReload().then(() => {
                // A proposal may widen deadline_window_blocks, the horizon the fixed
                // nonOkPublished ring cap must clear. Re-check the floor on change so
                // the warning lands then, not later when evictions start burning fees.
                if(hub.attestationConsensus && typeof hub.attestationConsensus.checkNonOkSizingFloor === 'function')
                    hub.attestationConsensus.checkNonOkSizingFloor();
            }).catch(e =>
                logger.error(nodeUtil.format('ProviderRegistry hot-reload failed:', e)));
        });

        // A passed MIN_STAKE proposal updates the in-memory capConfig and re-evaluates
        // this node's qualification, so long-running and freshly-started hubs converge
        // on the same qualified set without a restart. No-op for non-capability params.
        hub.governance.on('proposal:finalized', (ev) => {
            hub.applyCapabilityGovernanceChange(ev).catch(e =>
                logger.error(nodeUtil.format('Capability config hot-reload failed:', e)));
        });

        // Append block-anchored ATTESTATION_PROVIDER changes to the provider config history
        // so the LLM fetch/judge model resolves deterministically at the request's block on
        // every hub. No-op for non-provider params.
        hub.governance.on('proposal:finalized', (ev) => {
            hub.applyProviderGovernanceChange(ev).catch(e =>
                logger.error(nodeUtil.format('Provider config history update failed:', e)));
        });
    }
}

// The verified-validator tier: NODEPROOF verdicts settle on BTC.
async function startFullNodeChallenge(hub, modules) {
    const { SlashDetector, FullNodeChallengeRound, loadSignerHooks, applySignerHooks } = modules;
    // Full-node challenge round (verified-validator tier). It shares the operator signer
    // wiring the attestation and oracle publishers use; without a broadcast hook, or an
    // encoder plus wallet-sign, the elected leader assembles verdicts it cannot post, so
    // the engine stays observe-only. The slash detector is otherwise created by
    // startOracle, and a hub running this tier without the price-oracle subsystem still
    // needs one to record failed-challenge slash proposals.
    if(!hub.slashDetector) hub.slashDetector = new SlashDetector(hub);
    hub.fullNodeChallenge = new FullNodeChallengeRound(hub);
    // NODEPROOF verdicts settle on BTC. A DOGE-only operator module (every module
    // written before the `chains` declaration) is refused here and the round stays
    // observe-only with a warn line, instead of signing a BTC payload with the DOGE
    // key and burning a DOGE fee on it.
    let fnSignerHooks = loadSignerHooks();
    if(fnSignerHooks && applySignerHooks(hub.fullNodeChallenge, fnSignerHooks, 'BTC')){
        logger.info('FullNodeChallengeRound: operator signer wired (' + fnSignerHooks.source + ')');
    }
    await hub.fullNodeChallenge.start();
}

// ROLLCALL presence proofs (validator liveness).
async function startRollcall(hub, modules) {
    const { RollcallRound, loadSignerHooks, applySignerHooks } = modules;
    // ROLLCALL presence proofs (validator liveness). Signs every BTC epoch and
    // gossips the signature regardless of whether this hub can publish: the
    // sweepers exist so a wallet-less validator still gets rolled, so signing
    // must never be gated on a DOGE rail. Publishing needs a signer module
    // exporting broadcast(payload) (every ROLLCALL is two-phase P2SH); without
    // one the engine stays sign-and-gossip only and getrollcallstatus says so.
    // The DOGE hooks are borrowed at send time via resolveSigner, so this
    // construction does not depend on startOracle having run.
    hub.rollcallRound = new RollcallRound(hub);
    let rcSignerHooks = loadSignerHooks();
    if(rcSignerHooks && applySignerHooks(hub.rollcallRound, rcSignerHooks, 'DOGE')){
        logger.info('RollcallRound: operator signer wired (' + rcSignerHooks.source + ')');
    }
    await hub.rollcallRound.start();
}

class Attestation {

    // No-op when P2P is not active. Must run after startGovernance: the hot-reload
    // wiring below attaches to this.governance, and silently attaches nothing when it
    // is still null.
    async startAttestation(){
        if(!this.peerManager) return;
        const modules = this.constructor.modules;
        await constructAttestationRound(this, modules);
        constructAttestationPublishers(this, modules);

        await this.attestationConsensus.start();
        await this.attestationRound.start();
        await this.attestationPublisher.start();
        await this.attestationSpotChecker.start();
        await this.attestationResponseMirror.start();
        await this.attestationBatchPublisher.start();
        await this.attestationRelay.start();
        wireGovernanceReloads(this);

        logger.info('Attestation framework started (providers: ' + this.providerRegistry.listProviderIds().join(', ') + ')');
        await startFullNodeChallenge(this, modules);
        await startRollcall(this, modules);
    }

    getRollcallRound(){          return this.rollcallRound; }
    getFullNodeChallenge(){      return this.fullNodeChallenge; }
    getAttestationRound(){       return this.attestationRound; }
    getAttestationConsensus(){   return this.attestationConsensus; }
    getAttestationPublisher(){   return this.attestationPublisher; }
    getAttestationSpotChecker(){ return this.attestationSpotChecker; }
    getAttestationResponseMirror(){ return this.attestationResponseMirror; }
    getAttestationRelay(){       return this.attestationRelay; }
    getProviderRegistry(){       return this.providerRegistry; }
}

module.exports = Attestation;
