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
 * XChain Hub - Hub Class
 *
 * Orchestrates the database, P2P gossip, PBFT consensus, and
 * validator identity layers.
 *
 ********************************************************************/

const Database           = require('./db');
const PeerManager        = require('./peers/manager.js');
const Consensus          = require('./consensus/pbft.js');
const ValidatorIdentity  = require('./validators/identity.js');
const OracleConsensus    = require('./oracle/consensus.js');
const OracleRound        = require('./oracle/round.js');
const OracleBatchSigner  = require('./oracle/batch_signer.js');
const RewardTracker      = require('./anchor/reward_tracker.js');
const SlashDetector      = require('./validators/slash_detector.js');
const CrossChainEngine   = require('./cross_chain/engine.js');
const CrossChainDexEngine  = require('./cross_chain/dex_engine.js');
const CrossChainCallEngine = require('./cross_chain/call_engine.js');
const CrossChainBridgeEngine = require('./cross_chain/bridge_engine.js');
const StateCheckpointEngine = require('./anchor/checkpoint_engine.js');
const StateAnchorPublisher  = require('./anchor/publisher.js');
const RetractionConsensus   = require('./consensus/retraction.js');
const ReorgHandler       = require('./anchor/reorg_handler.js');
const SwapTracker        = require('./cross_chain/swap_tracker.js');
const Governance         = require('./validators/governance.js');
const SlashGovernance    = require('./validators/slash_governance.js');
const PriceAggregator    = require('./oracle/price_aggregator.js');
const OraclePublisher    = require('./oracle/publisher.js');
const { loadSignerHooks, applySignerHooks } = require('./lib/signer_loader.js');
const HubDbBroadcaster   = require('./peers/hub_db_broadcaster.js');
const CapabilityRegistry = require('./validators/capability_registry.js');
const CapabilitySnapshot = require('./validators/capability_snapshot.js');
const StakeWeightFeed    = require('./validators/stake_weight_feed.js');
const StakeShareWatcher  = require('./validators/stake_share_watcher.js');
const ProviderRegistry      = require('./validators/provider_registry.js');
const AttestationRound       = require('./attestation/round.js');
const AttestationConsensus   = require('./attestation/consensus.js');
const AttestationPublisher   = require('./attestation/publisher.js');
const AttestationRelay       = require('./attestation/relay.js');
const FullNodeChallengeRound = require('./consensus/full_node_challenge_round.js');
const RollcallRound          = require('./rollcall/round.js');
const AttestationSpotChecker = require('./attestation/spot_checker.js');
const AttestationResponseMirror = require('./attestation/response_mirror.js');
const AttestationBatchPublisher = require('./attestation/batch_publisher.js');
const axios = require('axios');
const nodeUtil = require('node:util');
const { getLogger } = require('./observability');
const logger = getLogger();
const Lifecycle = require('./hub/lifecycle.js');
const Oracle = require('./hub/oracle.js');
const Attestation = require('./hub/attestation.js');
const CrossChain = require('./hub/cross_chain.js');
const HubGovernance = require('./hub/governance.js');
const ConfigParams = require('./hub/config_params.js');
const Prices = require('./hub/prices.js');
const Validators = require('./hub/validators.js');
const CanonicalConfig = require('./hub/canonical_config.js');
const Capabilities = require('./hub/capabilities.js');
const CapabilityGossip = require('./hub/capability_gossip.js');
const ChainTips = require('./hub/chain_tips.js');
const IndexerUrls = require('./hub/indexer_urls.js');

// Every module the part files construct, call a static on, or post through. They
// reach it through this.constructor.modules rather than requiring it themselves:
// sixteen suites load THIS file through proxyquire with stubs keyed relative to
// it, and a part's own require would resolve the real module around the stub.
const MODULES = Object.freeze({
    Database, PeerManager, Consensus, ValidatorIdentity, PriceAggregator, HubDbBroadcaster,
    OracleRound, OracleConsensus, OracleBatchSigner, OraclePublisher, RewardTracker,
    SlashDetector, CrossChainEngine, CrossChainDexEngine, CrossChainCallEngine,
    CrossChainBridgeEngine, StateCheckpointEngine, StateAnchorPublisher, RetractionConsensus,
    SwapTracker, ReorgHandler, Governance, SlashGovernance, CapabilityRegistry,
    StakeShareWatcher, ProviderRegistry, AttestationRound, AttestationConsensus,
    AttestationPublisher, AttestationSpotChecker, AttestationResponseMirror,
    AttestationBatchPublisher, AttestationRelay, FullNodeChallengeRound, RollcallRound,
    loadSignerHooks, applySignerHooks, axios
});

// The timers, in-flight guards and last-known-good readings a running hub keeps.
// Every one of them is null or empty until the engine that owns it starts.
function initRuntimeState(hub) {
    hub._capabilityRecheckTimer = null;
    hub._capabilityConfigWatcher = null;
    hub._stakePollTimer          = null;
    hub._capabilityCheckRunning  = false;
    hub._stakePollRunning        = false;
    hub._transportSetTimer       = null;
    hub._transportSetRefreshRunning = false;
    hub._transportSignerSet      = new Set();  // last-known-good effective set, lowercased pubkey hex
    hub._transportSignerSetAt    = 0;       // ms epoch of the last successful refresh (0 = never)
    hub._ownPubkeyInSignerSet    = null;    // true/false once resolved; null = never resolved
    hub._latestBlockIndex        = null;
    hub._latestStakeAmount       = null;
}

class XChainHub {

    // The modules above, reached by the part files through this.constructor.
    static get modules(){ return MODULES; }

    constructor(dbHost, dbPort, dbName, dbUser, dbPass, p2pConfig, opts) {
        this.dbHost    = dbHost;
        this.dbPort    = dbPort;
        this.dbName    = dbName;
        this.dbUser    = dbUser;
        this.dbPass    = dbPass;
        this.p2pConfig = p2pConfig || null;
        // Activation gating (notably STAKE_WEIGHTED_QUORUM). In validator mode it comes
        // from p2pConfig, validated in api.js. A STANDALONE hub runs no consensus but
        // still INGESTS network-keyed content (PriceAggregator.receiveValidatedBatch
        // resolves the EQUIV wrap, the quorum mode, the sig-tally order and the pair-name
        // bound off this string), so it takes the network api.js validated the same way
        // for HUB_NETWORK there. Unset stays '', the pre-existing behaviour of every
        // single-host deployment. p2pConfig === null, never emptiness here, remains the
        // standalone-mode signal for startP2P and everything gated behind it.
        this.network   = (this.p2pConfig && this.p2pConfig.HUB_NETWORK) ? String(this.p2pConfig.HUB_NETWORK)
                       : ((opts && opts.network) ? String(opts.network) : '');
        // Seeded HERE, not in startCapabilities: startP2P constructs
        // FullNodeChallengeRound first and it snapshots cfg.FULLNODE at construction.
        // Never creates p2pConfig; a null one is startP2P's standalone-mode signal.
        this.seedCanonicalFullnode();
        this.db               = null;
        this.peerManager      = null;
        this.consensus        = null;
        this.identity         = null;
        this.oracle           = null;
        this.oracleConsensus  = null;
        this.rewardTracker    = null;
        this.slashDetector    = null;
        this.crossChain       = null;
        this.reorgHandler     = null;
        this.swapTracker      = null;
        this.governance       = null;
        this.slashGovernance  = null;
        this.priceAggregator  = null;
        this.oraclePublisher  = null;
        this.oracleBatchSigner = null;
        this.hubDbBroadcaster = null;
        this.capabilityRegistry      = null;
        this.capabilitySnapshot      = new CapabilitySnapshot(this);  // available pre-startCapabilities so consensus engines can use it from start()
        // The federation's stake view for a hub that serves no capability of its own.
        // Built here for the same reason as the snapshot above: it answers the
        // threshold question the snapshot asks on its very first fetch, which happens
        // before startCapabilities decides what this hub can serve. Inert on a hub
        // whose capability registry carries its own thresholds.
        this.stakeWeightFeed         = new StakeWeightFeed(this);
        this.stakeShareWatcher       = null;  // minted in startCapabilities(); watches our own stake share vs the weighted quorum gate
        this.providerRegistry        = null;
        this.attestationRound        = null;
        this.attestationConsensus    = null;
        this.attestationPublisher    = null;
        this.attestationSpotChecker  = null;
        this.attestationResponseMirror = null;
        this.attestationBatchPublisher = null;
        this.attestationRelay        = null;
        this.fullNodeChallenge       = null;
        this.rollcallRound           = null;
        initRuntimeState(this);
    }

    // Applies a finalized ATTESTATION_PROVIDER change to the block-anchored provider
    // history, on the anchoring rationale applyCapabilityGovernanceChange documents.
    async applyProviderGovernanceChange(ev){
        if(!ev || !ev.parameter || !this.providerRegistry) return;
        let providerId = ProviderRegistry.parseAttestationProviderParam(ev.parameter);
        if(!providerId) return;
        if(ev.activationBlock === undefined || ev.activationBlock === null || !Number.isInteger(Number(ev.activationBlock))){
            logger.warn('Governance ATTESTATION_PROVIDER change for ' + providerId +
                ' has no activation_block; not applying (would be unanchored, risking cross-hub divergence)');
            return;
        }
        let ac, ms, cs;
        try {
            let parsed = JSON.parse(String(ev.newValue));
            ac = (parsed && parsed.additional_config) ? parsed.additional_config : parsed;
            // The provider stake floor rides the same entry. Read here as well as in
            // ProviderRegistry.loadGovernanceHistory: this is the LIVE apply path and that is
            // the RESTART replay path, and a floor seen by only one would have a restarted hub
            // and a long-running one resolve different floors for the same block.
            ms = (parsed && parsed.min_stake_xchain !== undefined) ? parsed.min_stake_xchain : undefined;
            // The PBFT consensus_strategy rides it too, on the same both-paths rule.
            cs = (parsed && parsed.consensus_strategy !== undefined) ? parsed.consensus_strategy : undefined;
        } catch (e) {
            logger.warn(nodeUtil.format('Governance ATTESTATION_PROVIDER change for ' + providerId +
                ' has unparseable proposed_value; not applying:', e && e.message ? e.message : e));
            return;
        }
        this.providerRegistry.applyProviderConfigActivation(providerId, Number(ev.activationBlock), ac, ms, cs);
    }
}

// Installed from the part files rather than written in the class body above:
// each part holds one behaviour of this class, and its members land here with
// the descriptors a class body would give them.
for (const Part of [Lifecycle, Oracle, Attestation, CrossChain, HubGovernance, ConfigParams, Prices, Validators, CanonicalConfig, Capabilities, CapabilityGossip, ChainTips, IndexerUrls]) {
    for (const [from, to] of [[Part.prototype, XChainHub.prototype], [Part, XChainHub]]) {
        for (const key of Object.getOwnPropertyNames(from)) {
            if (key === 'constructor' || key === 'length' || key === 'name' || key === 'prototype') continue;
            Object.defineProperty(to, key, Object.getOwnPropertyDescriptor(from, key));
        }
    }
}

module.exports = XChainHub;
