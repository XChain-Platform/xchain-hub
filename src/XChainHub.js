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

const Database           = require('./db.js');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS } = require('./constants.js');
const coins              = require('./coins');
const PeerManager        = require('./PeerManager.js');
const Consensus          = require('./Consensus.js');
const ValidatorIdentity  = require('./ValidatorIdentity.js');
const OracleConsensus    = require('./OracleConsensus.js');
const OracleRound        = require('./OracleRound.js');
const RewardTracker      = require('./RewardTracker.js');
const SlashDetector      = require('./SlashDetector.js');
const CrossChainEngine   = require('./CrossChainEngine.js');
const CrossChainDexEngine  = require('./CrossChainDexEngine.js');
const CrossChainCallEngine = require('./CrossChainCallEngine.js');
const StateCheckpointEngine = require('./StateCheckpointEngine.js');
const StateAnchorPublisher  = require('./StateAnchorPublisher.js');
const RetractionConsensus   = require('./RetractionConsensus.js');
const ReorgHandler       = require('./ReorgHandler.js');
const SwapTracker        = require('./SwapTracker.js');
const Governance         = require('./Governance.js');
const SlashGovernance    = require('./SlashGovernance.js');
const PriceAggregator    = require('./PriceAggregator.js');
const OraclePublisher    = require('./OraclePublisher.js');
const { loadSignerHooks, applySignerHooks } = require('./lib/signer-loader.js');
const fullnodeActivation = require('./lib/fullnode_activation.js');
const HubDbBroadcaster   = require('./HubDbBroadcaster.js');
const CapabilityRegistry = require('./CapabilityRegistry.js');
const CapabilitySnapshot = require('./CapabilitySnapshot.js');
const ProviderRegistry      = require('./ProviderRegistry.js');
const AttestationRound       = require('./AttestationRound.js');
const AttestationConsensus   = require('./AttestationConsensus.js');
const AttestationPublisher   = require('./AttestationPublisher.js');
const AttestationRelay       = require('./AttestationRelay.js');
const FullNodeChallengeRound = require('./FullNodeChallengeRound.js');
const AttestationSpotChecker = require('./AttestationSpotChecker.js');
const { bcmul, bcdiv }   = require('./bcmath.js');
const mathjs             = require('mathjs');
const fs                 = require('fs');
const axios              = require('axios');
const PARAMETER_LIST     = ["host", "port", "service_port", "db_host", "db_port", "name", "user", "pass"];
const OPERATIONAL_PARAMS = new Set(["GAS_PRICE", "ACTIVATION_DELAY_BLOCKS", "EXPIRATION_FEE_PER_DAY"]);
const JSON_BLOB_PARAMS   = new Set(["GAS_SCHEDULE", "STAKING"]);

class XChainHub {
    constructor(dbHost, dbPort, dbName, dbUser, dbPass, p2pConfig) {
        this.dbHost    = dbHost;
        this.dbPort    = dbPort;
        this.dbName    = dbName;
        this.dbUser    = dbUser;
        this.dbPass    = dbPass;
        this.p2pConfig = p2pConfig || null;
        // Consensus activation gating (notably STAKE_WEIGHTED_QUORUM). Set in validator
        // mode, validated in api.js; '' in standalone, where no consensus runs.
        this.network   = (this.p2pConfig && this.p2pConfig.HUB_NETWORK) ? String(this.p2pConfig.HUB_NETWORK) : '';
        // Seeded HERE, not in startCapabilities: startP2P constructs
        // FullNodeChallengeRound first and it snapshots cfg.FULLNODE at construction.
        // Never creates p2pConfig; a null one is startP2P's standalone-mode signal.
        this._seedCanonicalFullnode();
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
        this.hubDbBroadcaster = null;
        this.capabilityRegistry      = null;
        this.capabilitySnapshot      = new CapabilitySnapshot(this);  // available pre-startCapabilities so consensus engines can use it from start()
        this.providerRegistry        = null;
        this.attestationRound        = null;
        this.attestationConsensus    = null;
        this.attestationPublisher    = null;
        this.attestationSpotChecker  = null;
        this.attestationRelay        = null;
        this._capabilityRecheckTimer = null;
        this._capabilityConfigWatcher = null;
        this._stakePollTimer          = null;
        this._capabilityCheckRunning  = false;
        this._stakePollRunning        = false;
        this._transportSetTimer       = null;
        this._transportSetRefreshRunning = false;
        this._transportSignerSet      = new Set();  // last-known-good effective set, lowercased pubkey hex
        this._transportSignerSetAt    = 0;       // ms epoch of the last successful refresh (0 = never)
        this._latestBlockIndex        = null;
        this._latestStakeAmount       = null;
    }

    async start(){
        // Verify the bundled coin files against CONSENSUS_CONFIG_PIN before any DB or
        // serving work: the hub serves consensusHashes federation-wide, so a drifted
        // bundle must halt boot. A null pin skips; a mismatch on an armed network throws.
        for(const net of coins.NETWORKS) coins.verifyConsensusPin(net);

        this.db = new Database(this.dbHost, this.dbPort, this.dbName, this.dbUser, this.dbPass);
        await this.db.createDatabase();
        await this.db.verifyTables();
        await this.db.runMigrations();

        // Started here, not in startP2P: receiving on-chain PRICE actions needs no
        // consensus, so a standalone hub still aggregates.
        this.priceAggregator = new PriceAggregator(this);
        // Mirrors aggregator row writes onto the hub-DB sync channel indexers subscribe to.
        this.hubDbBroadcaster = new HubDbBroadcaster(this.p2pConfig || {}, this.db);
        this.priceAggregator.on('row:inserted', (event) => {
            this.hubDbBroadcaster.broadcastRow(event);
        });
        this.priceAggregator.on('row:deleted', (event) => {
            this.hubDbBroadcaster.broadcastDeletion(event);
        });
        console.log('XChain Hub started (MariaDB: ' + this.dbName + ')');
    }

    async startP2P(){
        if(!this.p2pConfig) return;

        if(this.p2pConfig.SIGNING_PRIVKEY_HEX){
            this.identity = new ValidatorIdentity(this.p2pConfig.SIGNING_PRIVKEY_HEX);
            console.log('Validator identity loaded (pubkey: ' + this.identity.getPubkeyHex().substring(0, 16) + '...)');
        }

        this.peerManager = new PeerManager(this.p2pConfig, this.db);

        if(this.identity){
            this.peerManager.setIdentity(this.identity);
        }

        // MUST succeed before the P2P listener opens: a null registry makes
        // _verifySignature accept any signed envelope from any sender.
        await this._loadValidatorPubkeys();

        // An empty (non-null) registry is fine: it rejects every unknown sender, the
        // correct pre-bootstrap state while validators are still registering.
        if(!this.peerManager.validatorPubkeys){
            throw new Error('Validator registry not loaded; refusing to start the P2P listener (database unavailable?)');
        }

        await this.peerManager.start();

        // Option A transport auth: best-effort immediate refresh plus a periodic poll,
        // inert on a hub with no chain validator set. Rationale at _refreshTransportSignerSet.
        let refreshMs = (this.p2pConfig && this.p2pConfig.P2P_SIGNER_SET_REFRESH_MS) || 30000;
        this._refreshTransportSignerSet().catch(e => console.error('Initial transport signer-set refresh failed:', e));
        this._transportSetTimer = setInterval(() => {
            this._refreshTransportSignerSet().catch(e => console.error('Transport signer-set refresh failed:', e));
        }, refreshMs);
    }

    // Refresh the chain-effective signer set from the on-chain validator snapshot. The
    // set is ADDITIVE to the registry, so transport auth follows key rotation; it is
    // NEVER cleared on an upstream failure, since the registry stays the auth floor.
    // In-flight guard, the same one _pollOwnStake and _runOwnCapabilityCheck carry: the
    // two awaits below are unbounded round trips, so a slow indexer lets the bare
    // setInterval stack passes. Each pass resolves the BTC tip at its own START, so an
    // older slow pass finishing last would write the OLDER block's validator snapshot
    // over a newer one and drop a just-rotated key from transport auth. Serializing the
    // passes orders the writes; a skipped tick costs at most one refresh interval of
    // staleness, which the registry auth floor already covers.
    async _refreshTransportSignerSet(){
        if(!this.peerManager) return;
        if(this._transportSetRefreshRunning) return;
        this._transportSetRefreshRunning = true;
        try {
            let block = await this._resolveBtcLatestBlock();
            if(block == null){ this._warnTransportStale('BTC tip unresolved'); return; }
            let snap = await this.capabilitySnapshot.getActiveValidatorSnapshot(block);
            if(!snap || !Array.isArray(snap.validators)){ this._warnTransportStale('validator snapshot unavailable'); return; }
            let set = new Set(snap.validators.map(v => String(v.pubkey).toLowerCase()));
            this._transportSignerSet   = set;
            this._transportSignerSetAt = Date.now();
            this.peerManager.setEffectiveSignerSet(set);
        } finally {
            this._transportSetRefreshRunning = false;
        }
    }

    // Warn once the last good refresh ages past a threshold. Never clears the set (the
    // no-fail-open invariant above), and stays silent before the first refresh.
    _warnTransportStale(why){
        let maxAgeMs = (this.p2pConfig && this.p2pConfig.P2P_SIGNER_SET_MAX_AGE_MS) || 600000;
        if(this._transportSignerSetAt && (Date.now() - this._transportSignerSetAt) > maxAgeMs){
            console.warn('XChainHub: transport signer set STALE (' + why + '); retaining last-known-good set of ' +
                this._transportSignerSet.size + ' pubkey(s); registry remains the auth floor');
        }
    }

    async startConsensus(){
        if(!this.peerManager) return;
        this.consensus = new Consensus(this);

        let validators = await this._loadValidatorSet();
        this.consensus.setValidatorSet(validators);

        await this.consensus.start();
    }

    getPeerManager(){
        return this.peerManager;
    }

    getConsensus(){
        return this.consensus;
    }

    async startOracle(){
        if(!this.peerManager) return;

        this.oracle = new OracleRound(this);

        this.oracleConsensus = new OracleConsensus(this, this.oracle);
        let validators = await this._loadValidatorSet();
        this.oracleConsensus.setValidatorSet(validators);

        this.oracle.setConsensus(this.oracleConsensus);

        this.rewardTracker = new RewardTracker(this);
        this.slashDetector = new SlashDetector(this);

        this.oracleConsensus.on('round:finalized', async (event) => {
            // A rejection out of an EventEmitter listener is an unhandled rejection.
            try {
                let participantPubkeys = [];
                if(this.peerManager.validatorPubkeys){
                    for(let addr of event.participants){
                        let pk = this.peerManager.validatorPubkeys.get(addr);
                        if(pk) participantPubkeys.push(pk);
                    }
                }

                await this.rewardTracker.distributeRewards(event.round, participantPubkeys, event.btcBlockHeight);

                // Re-loaded per round: the set captured at startOracle() goes stale, so
                // rotated-in validators escaped slashing and removed ones kept accruing
                // misses. On a transient load failure keep the last-known-good set.
                let currentValidators = await this._loadValidatorSet();
                if(currentValidators.length > 0){
                    validators = currentValidators;
                }

                await this.slashDetector.checkRound(
                    event.round, event.submissions, event.prices,
                    participantPubkeys, validators
                );
            } catch (e){
                console.error('round:finalized reward/slash handling failed for round %s:', (event && event.round), e && e.message ? e.message : e);
            }
        });

        await this.oracleConsensus.start();
        await this.oracle.start();

        // Queues finalized rounds for DOGE publishing; inert until a transport is wired.
        this.oraclePublisher = new OraclePublisher(this);
        // The single wiring point for ALL on-chain DOGE publishing: StateAnchorPublisher
        // borrows these hooks via _resolveSigner(). Throws on a broken module.
        let signerHooks = loadSignerHooks();
        if(signerHooks){
            applySignerHooks(this.oraclePublisher, signerHooks);
            console.log('OraclePublisher: operator signer wired (' + signerHooks.source + ')');
        }
        await this.oraclePublisher.start();
    }

    getIdentity(){
        return this.identity;
    }

    getOracle(){
        return this.oracle;
    }

    // Must run after startGovernance: the hot-reload wiring below attaches to
    // this.governance, and silently attaches nothing when it is still null.
    async startAttestation(){
        if(!this.peerManager) return;

        this.providerRegistry = new ProviderRegistry(this);
        await this.providerRegistry.load();
        // Rebuild the block-anchored provider-config history so a freshly-started hub
        // resolves the same fetch/judge model per block as a long-running one.
        await this.providerRegistry.loadGovernanceHistory();

        this.attestationConsensus = new AttestationConsensus(this, this.providerRegistry);
        this.attestationRound     = new AttestationRound(this, this.providerRegistry);
        this.attestationRound.setConsensus(this.attestationConsensus);

        this.attestationPublisher  = new AttestationPublisher(this);
        // Mirrors startOracle's signer wiring: without it a validator finalizes ATTEST
        // responses but never broadcasts them and the queue grows forever.
        let attestationSignerHooks = loadSignerHooks();
        if(attestationSignerHooks){
            applySignerHooks(this.attestationPublisher, attestationSignerHooks);
            console.log('AttestationPublisher: operator signer wired (' + attestationSignerHooks.source + ')');
        }
        this.attestationSpotChecker = new AttestationSpotChecker(this, this.providerRegistry);

        // Cross-chain relay driver, opt-in via ATTEST_RELAY_ENABLED=1. Its v3 request leg
        // broadcasts on BTC and takes the publisher's signer; its v4 response leg
        // broadcasts on the ORIGIN chain, so it is wired separately per chain.
        this.attestationRelay = new AttestationRelay(this);
        if(attestationSignerHooks){
            applySignerHooks(this.attestationRelay, attestationSignerHooks);
        }

        await this.attestationConsensus.start();
        await this.attestationRound.start();
        await this.attestationPublisher.start();
        await this.attestationSpotChecker.start();
        await this.attestationRelay.start();

        if(this.governance && typeof this.governance.on === 'function'){
            this.governance.on('proposal:finalized', () => {
                this.providerRegistry.hotReload().then(() => {
                    // A proposal may widen deadline_window_blocks, the horizon the fixed
                    // nonOkPublished ring cap must clear; re-check the floor on change.
                    if(this.attestationConsensus && typeof this.attestationConsensus.checkNonOkSizingFloor === 'function')
                        this.attestationConsensus.checkNonOkSizingFloor();
                }).catch(e =>
                    console.error('ProviderRegistry hot-reload failed:', e));
            });

            // A passed MIN_STAKE proposal updates the in-memory capConfig and re-evaluates
            // this node's qualification, so long-running and freshly-started hubs converge
            // on the same qualified set without a restart. No-op for non-capability params.
            this.governance.on('proposal:finalized', (ev) => {
                this._applyCapabilityGovernanceChange(ev).catch(e =>
                    console.error('Capability config hot-reload failed:', e));
            });

            // Append block-anchored ATTESTATION_PROVIDER changes so the fetch/judge model
            // resolves deterministically at the request's block. No-op otherwise.
            this.governance.on('proposal:finalized', (ev) => {
                this._applyProviderGovernanceChange(ev).catch(e =>
                    console.error('Provider config history update failed:', e));
            });
        }

        console.log('Attestation framework started (providers: ' + this.providerRegistry.listProviderIds().join(', ') + ')');

        // Full-node challenge round (verified-validator tier). Without a broadcast hook
        // the elected leader assembles verdicts it cannot post, so it stays observe-only.
        // A hub running this tier without startOracle still needs a SlashDetector.
        if(!this.slashDetector) this.slashDetector = new SlashDetector(this);
        this.fullNodeChallenge = new FullNodeChallengeRound(this);
        let fnSignerHooks = loadSignerHooks();
        if(fnSignerHooks){
            applySignerHooks(this.fullNodeChallenge, fnSignerHooks);
            console.log('FullNodeChallengeRound: operator signer wired (' + fnSignerHooks.source + ')');
        }
        await this.fullNodeChallenge.start();
    }

    getFullNodeChallenge(){      return this.fullNodeChallenge; }
    getAttestationRound(){       return this.attestationRound; }
    getAttestationConsensus(){   return this.attestationConsensus; }
    getAttestationPublisher(){   return this.attestationPublisher; }
    getAttestationSpotChecker(){ return this.attestationSpotChecker; }
    getAttestationRelay(){       return this.attestationRelay; }
    getProviderRegistry(){       return this.providerRegistry; }

    async startCrossChain(){
        if(!this.peerManager) return;
        this.crossChain = new CrossChainEngine(this);
        let validators = await this._loadValidatorSet();
        this.crossChain.setValidatorSet(validators);

        let chainPairMap = await this._loadChainPairValidators();
        this.crossChain.setChainPairValidators(chainPairMap);

        this.swapTracker = new SwapTracker(this);
        this.swapTracker.start(this.crossChain);

        await this.crossChain.start();

        // Matches cross-chain ORDER/SWAP offers and settles them over XSETTLE. Idles
        // unless at least one chain's indexer URL is configured.
        this.crossChainDex = new CrossChainDexEngine(this);
        await this.crossChainDex.start();

        // XCALL: confirmation-gates contract-emitted call requests, PBFTs the dispatch
        // and result rows, and mirrors them to indexers. Idles without indexer URLs.
        this.crossChainCalls = new CrossChainCallEngine(this);
        await this.crossChainCalls.start();

        // Quorum-signed per-chain ledger/actions/contract hash commitments, written
        // off-chain and streamed over the hub-DB mirror so consumers can verify state.
        this.stateCheckpoints = new StateCheckpointEngine(this);
        await this.stateCheckpoints.start();

        // Collects 2f+1 co-signatures over quorum-class reorg-retraction broadcasts
        // before they reach the mirror stream. Below the flag-day or without an
        // identity, engines fall through to the legacy unsigned broadcast.
        this.retractionConsensus = new RetractionConsensus(this);

        // Commits checkpoints (v0) and the cross-chain match archive (v1/v2) on DOGE so
        // federation state is recoverable from chain parse alone. No-op when unconfigured.
        this.stateAnchorPublisher = new StateAnchorPublisher(this);
        await this.stateAnchorPublisher.start();
    }

    getCrossChain(){
        return this.crossChain;
    }

    getCrossChainDex(){
        return this.crossChainDex;
    }

    async startReorgHandler(){
        if(!this.peerManager) return;
        this.reorgHandler = new ReorgHandler(this);
        let validators = await this._loadValidatorSet();
        this.reorgHandler.setValidatorSet(validators);
        await this.reorgHandler.start();
    }

    async reportReorg(chain, reorgHeight, timestamp, oldHash, newHash){
        if(!this.reorgHandler) throw new Error('Reorg handler not active');
        return await this.reorgHandler.reportReorg(chain, reorgHeight, timestamp, oldHash, newHash);
    }

    async getReorgHistory(limit){
        if(!this.reorgHandler) return [];
        return await this.reorgHandler.getReorgHistory(limit);
    }

    async startGovernance(){
        if(!this.peerManager) return;
        this.governance = new Governance(this);
        let validators = await this._loadValidatorSet();
        this.governance.setValidatorSet(validators);
        await this.governance.start();

        // 'proposal:finalized' fires on the tally leader AND every follower's local
        // re-tally, so a passed SLASH_PENALTY executes federation-wide with no new message.
        this.slashGovernance = new SlashGovernance(this);
        this.governance.on('proposal:finalized', (ev) => {
            this.slashGovernance.applyFinalized(ev).catch(e =>
                console.error('SlashGovernance: penalty execution failed for %s:',
                    (ev && ev.proposalId), e && e.message ? e.message : e));
        });
    }

    // penalty: 'suspend' | 'dismiss'; the evidence is the validator's pending slash_proposals.
    async proposeSlashPenalty(validatorPubkey, penalty, rationale){
        if(!this.slashGovernance) throw new Error('Governance not active');
        return await this.slashGovernance.proposeSlashPenalty(validatorPubkey, penalty, rationale);
    }

    async propose(parameter, currentValue, proposedValue, rationale){
        if(!this.governance) throw new Error('Governance not active');
        return await this.governance.propose(parameter, currentValue, proposedValue, rationale);
    }

    async vote(proposalId, voteChoice){
        if(!this.governance) throw new Error('Governance not active');
        return await this.governance.vote(proposalId, voteChoice);
    }

    async getProposals(status, parameter, limit){
        if(!this.governance) return [];
        return await this.governance.getProposals(status, parameter, limit);
    }

    async getProposal(proposalId){
        if(!this.governance) return null;
        return await this.governance.getProposal(proposalId);
    }

    async getVotes({proposalId, voterPubkey, limit} = {}){
        if(!this.governance) return [];
        return await this.governance.getVotes({proposalId, voterPubkey, limit});
    }

    async getValidatorCapabilities({signingPubkey, capability, limit} = {}){
        if(!this.capabilityRegistry) return [];
        return await this.capabilityRegistry.listState({signingPubkey, capability, limit});
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

    // Read-only views of the hub's own cross_chain_calls table; a call_id resolves
    // to both XCALL phases of one call's lifecycle.
    async getCrossChainCall(callId){
        if(!this.crossChainCalls) return null;
        return await this.crossChainCalls.getCall(callId);
    }

    async listCrossChainCalls(filters){
        if(!this.crossChainCalls) return [];
        return await this.crossChainCalls.listCalls(filters);
    }

    async addParametersFromJson(json){
        if(this.consensus){
            await this.consensus.propose(json);
            return true;
        }
        await this.applyConfig(json);
        return true;
    }

    async applyConfig(json){
        if (!json || typeof json !== 'object' || Array.isArray(json))
            throw new Error('Config must be a non-null object');

        let rows = [];
        for(let nextCoin in json){
            if(nextCoin === '') continue;
            let coinLevel = json[nextCoin];
            if (!coinLevel || typeof coinLevel !== 'object') continue;

            for(let nextNetwork in coinLevel){
                let networkLevel = coinLevel[nextNetwork];
                if (!networkLevel || typeof networkLevel !== 'object') continue;

                for(let nextModule in networkLevel){
                    let moduleLevel = networkLevel[nextModule];
                    if (!moduleLevel || typeof moduleLevel !== 'object') continue;

                    for(let nextParam of PARAMETER_LIST){
                        let nextValue = moduleLevel[nextParam];
                        if(nextValue === null || nextValue === undefined) continue;

                        if (typeof nextValue !== 'string') {
                            console.warn('XChainHub.applyConfig: non-string value for ' + nextParam + ': coercing');
                            nextValue = String(nextValue);
                        }
                        if (nextValue.length > 1024) {
                            throw new Error('Config value for ' + nextParam + ' exceeds max length of 1024 chars');
                        }

                        rows.push({
                            coin:       nextCoin,
                            network:    nextNetwork,
                            module:     nextModule,
                            paramName:  nextParam,
                            paramValue: nextValue
                        });
                    }

                    for(let nextParam of OPERATIONAL_PARAMS){
                        let nextValue = moduleLevel[nextParam];
                        if(nextValue === null || nextValue === undefined) continue;

                        if (typeof nextValue !== 'string') {
                            console.warn('XChainHub.applyConfig: non-string value for ' + nextParam + ': coercing');
                            nextValue = String(nextValue);
                        }
                        if (nextValue.length > 1024) {
                            throw new Error('Config value for ' + nextParam + ' exceeds max length of 1024 chars');
                        }

                        rows.push({
                            coin:       nextCoin,
                            network:    nextNetwork,
                            module:     nextModule,
                            paramName:  nextParam,
                            paramValue: nextValue
                        });
                    }

                    // Serialized to a JSON string before storage.
                    for(let nextParam of JSON_BLOB_PARAMS){
                        let nextValue = moduleLevel[nextParam];
                        if(nextValue === null || nextValue === undefined) continue;

                        if (typeof nextValue === 'object') {
                            nextValue = JSON.stringify(nextValue);
                        } else if (typeof nextValue !== 'string') {
                            nextValue = String(nextValue);
                        }
                        if (nextValue.length > 1024) {
                            throw new Error('Config value for ' + nextParam + ' exceeds max length of 1024 chars');
                        }

                        rows.push({
                            coin:       nextCoin,
                            network:    nextNetwork,
                            module:     nextModule,
                            paramName:  nextParam,
                            paramValue: nextValue
                        });
                    }
                }
            }
        }

        if(rows.length > 0){
            await this.db.setParams(rows);
        }
    }

    // sinceUpdatedAt (optional): epoch-seconds cursor; omit it for the full tree.
    async getAllConfigs(sinceUpdatedAt){
        return await this.db.getAllConfigs(sinceUpdatedAt);
    }

    // High-water mark (epoch seconds) consumers thread back as the cursor above.
    async getConfigWatermark(){
        return await this.db.getConfigWatermark();
    }

    // Last committed PBFT sequence (0 on a fresh node), so consumers can detect a
    // committed config change between polls.
    async getLastSeq(){
        return await this.db.getLastSeq();
    }

    async registerValidator(signingPubkey, addr){
        if(!signingPubkey || !/^[0-9a-fA-F]{64}$/.test(signingPubkey))
            throw new Error('Invalid signing pubkey (must be 64 hex chars)');
        if(!addr)
            throw new Error('Validator addr is required');

        // Addr-keyed: each addr has exactly ONE active pubkey, so retire any other
        // active row for this addr BEFORE the upsert. Without it _loadValidatorPubkeys'
        // Map<addr, pubkey> resolves the collision by signing_pubkey sort order.
        await this.db.doQuery(
            "UPDATE validators SET status = 'removed', updated_at = NOW() " +
            "WHERE addr = ? AND signing_pubkey <> ? AND status = 'active'",
            [addr, signingPubkey]
        );

        await this.db.doQuery(
            `INSERT INTO validators (signing_pubkey, addr, status)
             VALUES (?, ?, 'active')
             ON DUPLICATE KEY UPDATE addr = ?, status = 'active', updated_at = NOW()`,
            [signingPubkey, addr, addr]
        );

        // The new set must reach EVERY consensus engine, not just config-PBFT: a
        // runtime registration has to enter oracle leader rotation too, or hubs hold
        // divergent leader views and silently miss rounds.
        await this._loadValidatorPubkeys();
        await this._propagateValidatorSet();

        console.log('Validator registered: ' + addr + ' (pubkey: ' + signingPubkey.substring(0, 16) + '...)');
        return true;
    }

    // Rotate the signing key at `addr`: retire the current active key, activate the new
    // one, reload and propagate. The manual transport-registry equivalent of the
    // on-chain DELEGATE path. Rejects an addr with no active validator.
    async rotateValidator(addr, newSigningPubkey){
        if(!newSigningPubkey || !/^[0-9a-fA-F]{64}$/.test(newSigningPubkey))
            throw new Error('Invalid signing pubkey (must be 64 hex chars)');
        if(!addr)
            throw new Error('Validator addr is required');

        let current = await this.db.doQuery(
            "SELECT signing_pubkey FROM validators WHERE addr = ? AND status = 'active'", [addr]);
        if(!current || current.length === 0)
            throw new Error('No active validator at addr ' + addr + ' to rotate');

        await this.db.doQuery(
            "UPDATE validators SET status = 'removed', updated_at = NOW() " +
            "WHERE addr = ? AND signing_pubkey <> ? AND status = 'active'",
            [addr, newSigningPubkey]);
        await this.db.doQuery(
            `INSERT INTO validators (signing_pubkey, addr, status)
             VALUES (?, ?, 'active')
             ON DUPLICATE KEY UPDATE addr = ?, status = 'active', updated_at = NOW()`,
            [newSigningPubkey, addr, addr]);

        await this._loadValidatorPubkeys();
        await this._propagateValidatorSet();

        console.log('Validator rotated at ' + addr + ' → ' + newSigningPubkey.substring(0, 16) + '...');
        return true;
    }

    // Deregister by signing_pubkey OR addr: mark the active row(s) 'removed', then reload.
    async deregisterValidator({ signingPubkey, addr }){
        if(!signingPubkey && !addr)
            throw new Error('signing_pubkey or addr is required');
        let where, args;
        if(signingPubkey){
            if(!/^[0-9a-fA-F]{64}$/.test(signingPubkey))
                throw new Error('Invalid signing pubkey (must be 64 hex chars)');
            where = 'signing_pubkey = ?'; args = [signingPubkey];
        } else {
            where = 'addr = ?'; args = [addr];
        }
        let res = await this.db.doQuery(
            "UPDATE validators SET status = 'removed', updated_at = NOW() WHERE " + where + " AND status = 'active'",
            args);
        await this._loadValidatorPubkeys();
        await this._propagateValidatorSet();

        let n = (res && res.affectedRows != null) ? res.affectedRows : '?';
        console.log('Validator deregistered (' +
            (signingPubkey ? 'pubkey ' + signingPubkey.substring(0, 16) + '...' : 'addr ' + addr) + '), rows=' + n);
        return true;
    }

    // Load the active set once and push it into every running consensus engine, so
    // runtime membership changes reach ALL PBFT subsystems.
    async _propagateValidatorSet(){
        let validators = await this._loadValidatorSet();
        if (this.consensus)       this.consensus.setValidatorSet(validators);
        if (this.oracleConsensus) this.oracleConsensus.setValidatorSet(validators);
        if (this.crossChain) {
            this.crossChain.setValidatorSet(validators);
            this.crossChain.setChainPairValidators(await this._loadChainPairValidators());
        }
        if (this.reorgHandler)    this.reorgHandler.setValidatorSet(validators);
        if (this.governance)      this.governance.setValidatorSet(validators);
        return validators;
    }

    async _loadValidatorPubkeys(){
        if(!this.peerManager) return;
        try {
            let rows = await this.db.doQuery(
                "SELECT signing_pubkey, addr FROM validators WHERE status = 'active' ORDER BY signing_pubkey"
            );
            let pubkeyMap = new Map();
            for(let row of rows){
                pubkeyMap.set(row.addr, row.signing_pubkey);
            }
            this.peerManager.setValidatorPubkeys(pubkeyMap);
        } catch(e){
            console.error('Error loading validator pubkeys:', e);
            // Fail closed: propagate so startP2P never opens the listener with a null
            // registry, which would make _verifySignature accept any signed message.
            // Reload callers already hold a non-null registry, so they just see an error.
            throw e;
        }
    }

    async _loadValidatorSet(){
        try {
            let rows = await this.db.doQuery(
                "SELECT signing_pubkey, addr FROM validators WHERE status = 'active' ORDER BY signing_pubkey"
            );
            return rows.map(r => ({ pubkey: r.signing_pubkey, addr: r.addr }));
        } catch(e){
            console.error('Error loading validator set:', e);
            return [];
        }
    }

    // Per-chain-pair validator subsets for cross-chain quorum. A validator's
    // comma-separated 'chains' column filters it; NULL/empty means all chains.
    async _loadChainPairValidators(){
        let chainPairMap = new Map();
        try {
            // db.js verifyTables reconciles 'chains' onto the table at startup.
            let rows = await this.db.doQuery(
                "SELECT signing_pubkey, addr, chains FROM validators WHERE status = 'active' ORDER BY signing_pubkey"
            );

            let allChains = [...coins.ALLOWED_COINS];
            let chainPairs = ['BTC-LTC', 'BTC-DOGE', 'LTC-DOGE'];

            for (let pair of chainPairs) {
                let [chainA, chainB] = pair.split('-');
                let pairValidators = [];
                for (let row of rows) {
                    let supportedChains = row.chains ? row.chains.split(',').map(c => c.trim()) : allChains;
                    if (supportedChains.includes(chainA) && supportedChains.includes(chainB)) {
                        pairValidators.push({ pubkey: row.signing_pubkey, addr: row.addr });
                    }
                }
                if (pairValidators.length > 0) {
                    chainPairMap.set(pair, pairValidators);
                }
            }
        } catch(e) {
            console.error('Error loading chain-pair validators:', e);
        }
        return chainPairMap;
    }

    // status: optional. Default 'finalized' (the historical contract; fee and price
    // consumers must never see skipped/disputed rows). 'all' adds skipped and disputed
    // rows so health consumers see failure states instead of an older finalized round.
    async getPriceSnapshots(limit, status) {
        if (status === 'all') {
            let query = "SELECT * FROM price_snapshots ORDER BY round_number DESC, coin_pair ASC LIMIT ?";
            return await this.db.doQuery(query, [limit || 50]);
        }
        let query = "SELECT * FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC, coin_pair ASC LIMIT ?";
        return await this.db.doQuery(query, [limit || 50]);
    }

    // Oracle price staleness bound in seconds, mirroring the indexer's
    // ORACLE_MAX_PRICE_AGE_SECONDS so advisory quotes reject the rounds the fee gate does.
    // 0 disables it. Precedence: p2pConfig/env override, else the pinned registry value.
    _oracleMaxAgeSeconds(coinPair) {
        let raw = (this.p2pConfig && this.p2pConfig.ORACLE_MAX_PRICE_AGE_SECONDS != null)
            ? this.p2pConfig.ORACLE_MAX_PRICE_AGE_SECONDS
            : process.env.ORACLE_MAX_PRICE_AGE_SECONDS;
        let v = parseInt(raw, 10);
        if (Number.isFinite(v)) return v;
        return this._registryOracleMaxAge(coinPair);
    }

    // The consensus-pinned ORACLE_MAX_PRICE_AGE_SECONDS for the pair, from the canonical
    // coin registry. The pair's base tick selects the coin; an unknown pair or network
    // falls back to BTC so no literal copy of the pinned constant lives here.
    _registryOracleMaxAge(coinPair) {
        let network = this.network || 'mainnet';
        let baseTick = String(coinPair || '').split('/')[0];
        let candidates = [[baseTick, network], ['BTC', network], ['BTC', 'mainnet']];
        for (let [tick, net] of candidates) {
            try {
                let cfg = coins.getCoinConfig(tick, net);
                let age = Number(cfg && cfg.ORACLE_MAX_PRICE_AGE_SECONDS);
                if (Number.isFinite(age)) return age;
            } catch (e) { /* non-registry pair or unknown network; try the next candidate */ }
        }
        // Registry unavailable (the bundle is vendored, so this should not happen). null
        // makes the caller's `maxAge > 0` guard fail open rather than hardcode the constant.
        return null;
    }

    // Latest finalized snapshot for a pair plus a staleness verdict:
    // { row, fresh, stale, missing, ageSeconds, maxAgeSeconds }. A snapshot with no
    // usable block_timestamp is never aged out, since its age is unknown.
    async getPriceStatus(coinPair) {
        let query = "SELECT * FROM price_snapshots WHERE coin_pair = ? AND status = 'finalized' ORDER BY round_number DESC LIMIT 1";
        let rows = await this.db.doQuery(query, [coinPair]);
        let maxAge = this._oracleMaxAgeSeconds(coinPair);
        if (rows.length === 0)
            return { row: null, fresh: false, stale: false, missing: true, ageSeconds: null, maxAgeSeconds: maxAge };
        let row = rows[0];
        let snapTs = Number(row.block_timestamp);
        let nowS = Math.floor(Date.now() / 1000);
        let age = (Number.isFinite(snapTs) && snapTs > 0) ? (nowS - snapTs) : null;
        let stale = (maxAge > 0 && age !== null && age > maxAge);
        return { row: row, fresh: !stale, stale: stale, missing: false, ageSeconds: age, maxAgeSeconds: maxAge };
    }

    // Freshest finalized price, or null when missing OR stale, so getFeeQuote fails closed
    // rather than quoting an outdated round. Use getPriceStatus to tell the two apart.
    async getPrice(coinPair) {
        let s = await this.getPriceStatus(coinPair);
        return s.fresh ? s.row : null;
    }

    // validators: [{ signing_pubkey, addr }] from an external source. Upsert-only: this
    // never retires a row, so it cannot drain the set to empty.
    async syncValidators(validators) {
        if (!Array.isArray(validators)) throw new Error('validators must be an array');

        for (let v of validators) {
            if (!v.signing_pubkey || !/^[0-9a-fA-F]{64}$/.test(v.signing_pubkey)) continue;
            if (!v.addr) continue;

            await this.db.doQuery(
                `INSERT INTO validators (signing_pubkey, addr, status)
                 VALUES (?, ?, 'active')
                 ON DUPLICATE KEY UPDATE addr = ?, status = 'active', updated_at = NOW()`,
                [v.signing_pubkey, v.addr, v.addr]
            );
        }

        // Reloads every subsystem, including reorg and governance, which otherwise
        // keep serving the boot-time set.
        await this._loadValidatorPubkeys();
        await this._propagateValidatorSet();

        console.log('Validators synced: ' + validators.length + ' entries');
        return true;
    }

    // `chains` rides along with addr/status: the documented getvalidators response has
    // always carried it, and omitting it left the explorer's chains column blank.
    async getValidators() {
        let query = "SELECT signing_pubkey, addr, chains, status, created_at, updated_at FROM validators WHERE status = 'active' ORDER BY signing_pubkey";
        return await this.db.doQuery(query);
    }

    async getValidatorStatus(signingPubkey) {
        let vRows = await this.db.doQuery(
            "SELECT * FROM validators WHERE signing_pubkey = ?", [signingPubkey]
        );
        if (vRows.length === 0) return null;

        let unclaimed = this.rewardTracker ? await this.rewardTracker.getUnclaimedRewards(signingPubkey) : '0';
        let rewards = this.rewardTracker ? await this.rewardTracker.getRewardHistory(signingPubkey, 20) : [];
        let slashes = this.slashDetector ? await this.slashDetector.getProposalsForValidator(signingPubkey) : [];

        return {
            validator:       vRows[0],
            unclaimedRewards: unclaimed,
            recentRewards:   rewards,
            slashProposals:  slashes
        };
    }

    async getFeeQuote(action, chain) {
        // The hub's own network, so a testnet or regtest hub reads its own config rows.
        let network = this.network || 'mainnet';

        // Defaults come from the canonical per-chain bundle, never an inline literal, so
        // a repin cannot diverge from what the indexer meters. The prior inline copy had
        // already drifted. GAS_SCHEDULE / GAS_PRICE config rows still override per hub.
        let gasSchedule = {};
        let gasPrice    = '0.00001';
        try {
            let bundle = coins.getCoinConfig(chain, network);
            if (bundle && bundle.GAS_SCHEDULE) gasSchedule = Object.assign({}, bundle.GAS_SCHEDULE);
            if (bundle && bundle.GAS_PRICE)    gasPrice    = String(bundle.GAS_PRICE);
        } catch (_) { /* unknown chain (the public path is gated by validateChain); serve no schedule */ }

        // Operator override layer. The configs tree keys coins by FULL name and
        // db.getConfig does not normalize, so the ticker must be mapped or nothing matches.
        let overrideKey = coins.COIN_FULL_NAME[chain] || chain;
        try {
            let chainCfg = await this.db.getConfig(overrideKey, network, 'chain');
            if (chainCfg && chainCfg.GAS_PRICE) {
                let parsed = parseFloat(chainCfg.GAS_PRICE);
                if (parsed > 0) gasPrice = chainCfg.GAS_PRICE;
            }
            if (chainCfg && chainCfg.GAS_SCHEDULE) {
                try {
                    let sched = JSON.parse(chainCfg.GAS_SCHEDULE);
                    if (sched && typeof sched === 'object') gasSchedule = Object.assign(gasSchedule, sched);
                } catch (_) { /* malformed blob; keep defaults */ }
            }
        } catch (_) { /* config store unavailable; keep protocol defaults */ }

        if (!Object.prototype.hasOwnProperty.call(gasSchedule, action)) return { error: 'unknown action: ' + action };
        let gasCost = gasSchedule[action];

        // Use bignumber multiply (8 decimal places) to match indexer fee charging.
        let xchainAmount = bcmul(gasCost, gasPrice, 8);

        let xchainPriceRow = await this.getPrice('XCHAIN/USD');
        let coinPrice      = await this.getPrice(chain + '/USD');

        if (!xchainPriceRow || !xchainPriceRow.price) {
            throw new Error('XCHAIN/USD oracle price unavailable; cannot compute fee quote');
        }
        let xchainUsdStr = xchainPriceRow.price;
        if (parseFloat(xchainUsdStr) <= 0) {
            throw new Error('XCHAIN/USD oracle price is zero or negative; cannot compute fee quote');
        }

        // Exactly 8 decimals, trailing zeros preserved, matching indexer fee charging.
        const fmt8 = (v) => mathjs.format(mathjs.bignumber(String(v)), {notation: 'fixed', precision: 8});

        let result = {
            action:       action,
            chain:        chain,
            gasCost:      gasCost,
            gasPrice:     fmt8(gasPrice),
            xchainAmount: fmt8(xchainAmount),
            xchainUsd:    fmt8(xchainUsdStr)
        };

        if (coinPrice && coinPrice.price) {
            let coinUsdStr = coinPrice.price;
            if (parseFloat(coinUsdStr) > 0) {
                let feeUsd           = bcmul(xchainAmount, xchainUsdStr, 8);
                let nativeCoinAmount = bcdiv(feeUsd, coinUsdStr, 8);

                result.feeUsd           = fmt8(feeUsd);
                result.coinUsd          = fmt8(coinUsdStr);
                result.nativeCoinAmount = fmt8(nativeCoinAmount);
                result.nativeCoin       = chain;
            }
        }

        return result;
    }

    // Merge the capability config JSON into p2pConfig so the self-test modules and
    // CapabilityRegistry see operator MIN_STAKE thresholds and per-capability blocks.
    // Used at startup and on hot-reload; throws on read/parse errors.
    _loadCapabilityConfigFile(configFilePath){
        let parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
        if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('capability config must be a JSON object');
        // Validate BEFORE merging so a divergent file is refused whole and a hot-reload
        // leaves the running hub on its previous validated config.
        if('CAPABILITIES' in parsed) this._assertCanonicalMinStakes(parsed.CAPABILITIES);
        // Same for a FULLNODE override: its consensus knobs must come from the pinned
        // coin bundle every service ships, or this hub runs a challenge schedule and
        // reward split its peers reject.
        this._assertCanonicalFullnode(parsed.FULLNODE || parsed.full_node);
        if(!this.p2pConfig) this.p2pConfig = {};
        const KEYS = ['CAPABILITIES', 'DISABLED_CAPABILITIES', 'price', 'cross_chain',
                      'oracle_publish', 'attestation', 'CAPABILITY_RECHECK_MS', 'STAKE_POLL_MS',
                      'FULLNODE', 'full_node'];
        for(let k of KEYS){
            if(k in parsed) this.p2pConfig[k] = parsed[k];
        }
        // Consumers read cfg.FULLNODE.BTC_RPC; accept the README's 'full_node' spelling
        // as an alias so the documented override is not dropped by the whitelist.
        if(this.p2pConfig.full_node && !this.p2pConfig.FULLNODE){
            this.p2pConfig.FULLNODE = this.p2pConfig.full_node;
        }
        this._seedCanonicalFullnode();
        // Keep a live registry's view in sync so hot-reload applies without a restart.
        if(this.capabilityRegistry){
            this.capabilityRegistry.capConfig = this.p2pConfig.CAPABILITIES || {};
            // Re-seed the block-0 genesis threshold; appended activations are preserved.
            this.capabilityRegistry._seedGenesisHistory();
            this.capabilityRegistry.disabled  = new Set(this.p2pConfig.DISABLED_CAPABILITIES || []);
        }
        console.log('Loaded capability config from ' + configFilePath +
            ' (thresholds: ' + Object.keys(this.p2pConfig.CAPABILITIES || {}).join(', ') + ')');
    }

    // Assert operator MIN_STAKE thresholds against the canonical coins registry
    // (src/coins/BTC.js STAKING.CAPABILITIES). This is the qualifying floor every
    // CapabilitySnapshot sends the indexer, so a divergent capabilities.json forks the
    // qualified set and quorum N. mainnet/testnet throw MIN_STAKE_MISMATCH and boot
    // halts; regtest/standalone warn. A missing MIN_STAKE key counts as a mismatch.
    _assertCanonicalMinStakes(caps){
        if(!caps || typeof caps !== 'object' || Array.isArray(caps)) return;
        if(process.env.XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT === '1'){
            console.warn('XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1: skipping canonical MIN_STAKE ' +
                'assertion. Divergent thresholds fork the qualified validator set; ' +
                'only bypass on a venue where every hub runs the SAME override.');
            return;
        }
        // STAKING is network-independent but resolves through the same getCoinConfig path
        // consumers use. Staking is BTC-anchored, so only BTC's floors gate quorum.
        let network = this.network || 'mainnet';
        let canonicalCaps;
        try {
            let cfg = coins.getCoinConfig('BTC', network);
            canonicalCaps = (cfg.STAKING && cfg.STAKING.CAPABILITIES) ? cfg.STAKING.CAPABILITIES : null;
        } catch(e){
            console.warn('Canonical MIN_STAKE assertion skipped: could not resolve BTC coin config for network "' +
                network + '": ' + e.message);
            return;
        }
        if(!canonicalCaps) return;
        let mismatches = [];
        for(let [cap, entry] of Object.entries(caps)){
            let canonical = canonicalCaps[cap];
            if(!canonical){
                // Unknown to the canonical registry: nothing to assert against.
                console.warn('Capability "' + cap + '" is not in the canonical coins registry; ' +
                    'MIN_STAKE not asserted.');
                continue;
            }
            let configured = Number((entry && entry.MIN_STAKE !== undefined) ? entry.MIN_STAKE : 0);
            let expected   = Number(canonical.MIN_STAKE);
            if(!Number.isFinite(configured) || configured !== expected){
                mismatches.push(cap + ': configured ' +
                    ((entry && entry.MIN_STAKE !== undefined) ? entry.MIN_STAKE : '(missing -> 0)') +
                    ' vs canonical ' + canonical.MIN_STAKE);
            }
        }
        if(mismatches.length === 0) return;
        let detail = 'capability MIN_STAKE diverges from the canonical coins registry ' +
            '(src/coins/BTC.js STAKING.CAPABILITIES): ' + mismatches.join('; ') +
            '. Every hub must query the indexer with the SAME floor or the qualified ' +
            'validator set / quorum N forks across the federation. Fix capabilities.json ' +
            'to the canonical values (XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1 to bypass on a ' +
            'coordinated test venue).';
        // Strict only on a declared consensus network; standalone and regtest warn.
        if(this.network === 'mainnet' || this.network === 'testnet'){
            let err = new Error(detail);
            err.code = 'MIN_STAKE_MISMATCH';
            throw err;
        }
        console.warn('MIN_STAKE mismatch (non-strict on ' + (this.network || 'standalone') + '): ' + detail);
    }

    // Canonical FULLNODE block for this hub's network, or null when unresolvable. The
    // full-node tier is BTC-anchored, so BTC is the only bundle that matters.
    _canonicalFullnode(){
        let network = this.network || 'mainnet';
        try {
            let cfg = coins.getCoinConfig('BTC', network);
            return cfg.FULLNODE || null;
        } catch(e){
            console.warn('Canonical FULLNODE resolution skipped: could not resolve BTC coin config for network "' +
                network + '": ' + e.message);
            return null;
        }
    }

    // Assert an operator FULLNODE override against the canonical registry and check the
    // effective block for activation coherence. Activating the inert NODEPROOF tier moves
    // the challenge schedule, the verifier quorum and the oracle reward split: fleet-wide
    // consensus, so it belongs in the pinned bundle. Throws FULLNODE_CONFIG_MISMATCH.
    _assertCanonicalFullnode(fn){
        if(!fn || typeof fn !== 'object' || Array.isArray(fn)) return;
        if(process.env.XCHAIN_HUB_SKIP_FULLNODE_ASSERT === '1'){
            console.warn('XCHAIN_HUB_SKIP_FULLNODE_ASSERT=1: skipping canonical FULLNODE ' +
                'assertion. Divergent NODEPROOF knobs fork the challenge schedule, the ' +
                'verifier quorum and the oracle reward split; only bypass on a venue where every ' +
                'hub runs the SAME override.');
            return;
        }
        let canonical = this._canonicalFullnode();
        if(!canonical) return;

        let problems = fullnodeActivation.diffCanonical(fn, canonical)
            .concat(fullnodeActivation.validateActivation(
                fullnodeActivation.mergeWithCanonical(canonical, fn)));
        if(problems.length === 0) return;

        let detail = 'FULLNODE config is unsafe to run: ' + problems.join('; ') +
            '. NODEPROOF activation is a fleet-wide consensus change: set it in the pinned ' +
            'coin bundle (src/coins/BTC.js FULLNODE) across hub, indexer and sync together, ' +
            'never in a single operator capabilities.json ' +
            '(XCHAIN_HUB_SKIP_FULLNODE_ASSERT=1 to bypass on a coordinated test venue).';

        if(this.network === 'mainnet' || this.network === 'testnet'){
            let err = new Error(detail);
            err.code = 'FULLNODE_CONFIG_MISMATCH';
            throw err;
        }
        console.warn('FULLNODE config problem (non-strict on ' + (this.network || 'standalone') + '): ' + detail);
    }

    // Seed p2pConfig.FULLNODE from the canonical coin bundle, operator keys on top.
    // Without it FullNodeChallengeRound read only the operator file and fell back to
    // hardcoded literals, so activating the tier the documented way changed the indexer
    // while every hub kept the inert defaults. Idempotent, so hot-reload can re-run it.
    _seedCanonicalFullnode(){
        if(!this.p2pConfig) return;
        let canonical = this._canonicalFullnode();
        if(!canonical) return;
        this.p2pConfig.FULLNODE = fullnodeActivation.mergeWithCanonical(canonical, this.p2pConfig.FULLNODE);
    }

    async startCapabilities(configFilePath){
        // Load the operator capability config BEFORE constructing the registry, which
        // snapshots p2pConfig.CAPABILITIES. Without it the self-tests read an empty
        // config and every config-bearing capability fails with "config missing".
        if(configFilePath){
            try {
                this._loadCapabilityConfigFile(configFilePath);
            } catch(e){
                // A canonical MIN_STAKE or FULLNODE mismatch is a consensus-fork
                // misconfig, so halt boot. Read/parse problems keep the legacy
                // warn-and-degrade path, where self-tests fail "config missing".
                if(e && (e.code === 'MIN_STAKE_MISMATCH' || e.code === 'FULLNODE_CONFIG_MISMATCH')) throw e;
                console.warn('Could not load capability config from ' + configFilePath + ': ', e);
            }
        }
        // Seed even with no operator config file, then report the tier's activation state
        // once at boot so an operator can see whether this hub thinks it is on.
        this._seedCanonicalFullnode();
        console.log('NODEPROOF full-node tier: ' +
            fullnodeActivation.describeActivation(this.p2pConfig && this.p2pConfig.FULLNODE));
        this.capabilityRegistry = new CapabilityRegistry(this);
        // Rebuild block-anchored MIN_STAKE history so a restart resolves the same
        // per-block thresholds as long-running peers.
        await this.capabilityRegistry.loadGovernanceHistory();

        if(this.peerManager){
            this.peerManager.on('capability', (envelope) => {
                this._handleCapabilityMessage(envelope).catch(e => {
                    console.error('Capability message handler error:', e);
                });
            });
        }

        if(this.identity){
            let pubkey = this.identity.getPubkeyHex();
            await this._runOwnCapabilityCheck(pubkey);

            let intervalMs = (this.p2pConfig && this.p2pConfig.CAPABILITY_RECHECK_MS) ? this.p2pConfig.CAPABILITY_RECHECK_MS : 60000;
            this._capabilityRecheckTimer = setInterval(() => {
                this._runOwnCapabilityCheck(pubkey).catch(e => {
                    console.error('Capability re-check failed:', e);
                });
            }, intervalMs);

            if(configFilePath && fs.existsSync(configFilePath)){
                try {
                    this._capabilityConfigWatcher = fs.watch(configFilePath, { persistent: false }, () => {
                        if(this._capabilityConfigDebounce) clearTimeout(this._capabilityConfigDebounce);
                        this._capabilityConfigDebounce = setTimeout(() => {
                            // Re-read the file into p2pConfig and the live registry: the
                            // watcher used to re-run self-tests against stale config.
                            try { this._loadCapabilityConfigFile(configFilePath); }
                            catch(e){ console.warn('Capability config reload failed: ', e); }
                            this._runOwnCapabilityCheck(pubkey).catch(e => {
                                console.error('Capability config-watch re-check failed:', e);
                            });
                        }, 500);
                    });
                    console.log('Capability config watcher attached to ' + configFilePath);
                } catch(e){
                    console.warn('Could not attach capability config watcher to ' + configFilePath + ':', e);
                }
            }

            // Poll the BTC indexer for own on-chain stake and feed refreshOwnQualification
            // so qualification tracks STAKE/UNSTAKE. URL from env first, then the configs
            // table; no timer is attached when no URL resolves.
            let initialUrl = await this._resolveBtcIndexerUrl();
            if(initialUrl){
                this._pollOwnStake(pubkey).catch(e => {
                    console.error('Initial stake poll failed:', e);
                });
                let stakePollMs = (this.p2pConfig && this.p2pConfig.STAKE_POLL_MS) ? this.p2pConfig.STAKE_POLL_MS : 60000;
                this._stakePollTimer = setInterval(() => {
                    this._pollOwnStake(pubkey).catch(e => {
                        console.error('Stake poll failed:', e);
                    });
                }, stakePollMs);
                console.log('Stake-amount poll attached to ' + initialUrl + ' (every ' + stakePollMs + 'ms)');
            } else {
                console.log('Stake-amount poll disabled (no BTC indexer URL: set BTC_INDEXER_API_URL or push via updateconfig)');
            }
        }

        console.log('Capability registry initialized' + (this.identity ? ' (identity: ' + this.identity.getPubkeyHex().substring(0,16) + '...)' : ' (no identity; peer-receive only)'));

        // Surface the genesis MIN_STAKE per capability so an operator can check it against
        // the indexer's frozen configs/<COIN>.js constants; a mismatch would fork.
        try {
            let genesis = this.capabilityRegistry.getCapabilities()
                .map(cap => cap + '=' + String(this.capabilityRegistry.getMinStake(cap)))
                .join(', ');
            console.log('Capability MIN_STAKE (genesis, pinned #4352): ' + genesis +
                ' (must equal the indexer configs/<COIN>.js constants)');
        } catch (e) { /* best-effort operator log */ }
    }

    // In-flight guard: _stakePollTimer fires on a bare setInterval while the pass awaits
    // an unbounded indexer round-trip, so a slow indexer would stack passes. Skipping is
    // safe because the next tick re-reads fresh truth.
    async _pollOwnStake(pubkey){
        if(this._stakePollRunning) return;
        this._stakePollRunning = true;
        try {
            await this._pollOwnStakePass(pubkey);
        } finally {
            this._stakePollRunning = false;
        }
    }

    // Query the BTC indexer for own active stake plus latest block, then feed both into
    // refreshOwnQualification. Best-effort: failures are logged and change no state.
    async _pollOwnStakePass(pubkey){
        let url = await this._resolveBtcIndexerUrl();
        if(!url) return;
        let body = {
            jsonrpc: '2.0',
            id:      Date.now(),
            method:  'getownstake',
            params:  { pubkey: pubkey }
        };
        let res;
        try {
            res = await axios.post(url, body, { headers: this._btcIndexerHeaders(), timeout: 5000 });
        } catch(err) {
            let status = err && err.response && err.response.status;
            if(status === 401 || status === 403){
                // Auth failure is distinct from the indexer being down; name it so the
                // operator fixes the key mismatch instead of chasing a network issue.
                console.error('_pollOwnStake: HTTP ' + status + ' from BTC indexer at ' + url +
                    ': check that BTC_INDEXER_API_KEY on this hub matches INDEXER_API_KEY on the indexer');
            } else {
                console.error('Stake poll failed:', err && err.message ? err.message : err);
            }
            return;
        }
        let result = res && res.data && res.data.result;
        if(!result || result.error){
            // Indexer either not ready or returned a structured error. Don't change state.
            return;
        }
        await this.refreshOwnQualification(result.amount, result.block_index);
    }

    // Resolve the latest BTC block index: first hub.db.getChainTip (populated by the
    // indexer's pushChainTip on the network _resolveBtcIndexerUrl picks), then a direct
    // getlatestblock call for stacks with no tip push. Null when both paths fail.
    async _resolveBtcLatestBlock(){
        // A cross-network configs tree makes this throw. Degrade to the documented null
        // rather than crashing the scheduler tick that called it.
        let network;
        try { network = await this._resolveBtcNetwork(); }
        catch (err) { console.error('XChainHub: cannot resolve BTC latest block:', err.message); return null; }
        try {
            let tip = await this.db.getChainTip('BTC', network);
            // Freshness bound on the pushed tip. If the co-located indexer halts,
            // getChainTip serves the same frozen row forever, so rounds would anchor to a
            // stale height. Fall through when the tip is stale or unverifiable.
            if(tip && tip.blockHeight && this._btcPushedTipFresh(tip)) return tip.blockHeight;
        } catch (_) { /* hub db down? fall through */ }
        let url = await this._resolveBtcIndexerUrl();
        if(!url) return null;
        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method: 'getlatestblock', params: {}
            }, { timeout: 5000 });
            let result = res && res.data && res.data.result;
            if(!result || result.error) return null;
            // Guard against anchoring on a stale tip. `lag` is how far the indexer's
            // committed tip trails the decoder's; past a configurable gap the tip no
            // longer reflects recent chain state, so degrade rather than lock a stale
            // validator set into the round.
            let maxLag = Number(process.env.MAX_INDEXER_LAG_BLOCKS);
            if(!Number.isFinite(maxLag) || maxLag < 0) maxLag = 200;
            if(result.lag != null && Number(result.lag) > maxLag){
                console.warn('XChainHub: BTC indexer lag ' + result.lag +
                    ' exceeds MAX_INDEXER_LAG_BLOCKS (' + maxLag + '); ignoring stale tip');
                return null;
            }
            return Number(result.block_index) || null;
        } catch (err) {
            console.error('XChainHub: failed to resolve BTC latest block from indexer:', err);
            return null;
        }
    }

    // Freshness gate for the pushed BTC tip used by path 1 above. setChainTip stores
    // block_time alongside the height, so the age check costs no round-trip. Returns
    // false when the tip is older than MAX_TIP_AGE_S or its block_time is missing.
    // Default bound mirrors OracleRound: 2x the oracle round interval.
    _btcPushedTipFresh(tip){
        let maxAge = Number(process.env.MAX_TIP_AGE_S);
        if(!Number.isFinite(maxAge) || maxAge <= 0){
            let roundIntervalMs = (this.p2pConfig && Number(this.p2pConfig.ORACLE_ROUND_INTERVAL)) || DEFAULT_ORACLE_ROUND_INTERVAL_MS;
            maxAge = Math.floor((2 * roundIntervalMs) / 1000);
        }
        let blockTime = Number(tip.blockTime);
        if(!Number.isFinite(blockTime) || blockTime <= 0){
            console.warn('XChainHub: pushed BTC tip (height ' + tip.blockHeight +
                ') has no stored block_time; treating as unverifiable and falling through to the direct indexer path');
            return false;
        }
        let ageS = Math.floor(Date.now() / 1000) - blockTime;
        if(ageS > maxAge){
            console.warn('XChainHub: pushed BTC tip (height ' + tip.blockHeight + ') is ' + ageS +
                's old, exceeds MAX_TIP_AGE_S (' + maxAge + '); falling through to the direct indexer path');
            return false;
        }
        return true;
    }

    // Which BTC network this hub talks to. In validator mode the answer is this.network
    // and nothing else; the configs table only confirms that network has an indexer, and
    // a tree carrying only OTHER networks throws. The old first-found order let a mainnet
    // validator anchor to the REGTEST tip. Standalone hubs keep the order for dev loops.
    async _resolveBtcNetwork(){
        // A hub told which network it is never guesses: with no configs, its own is the answer.
        if(!this.db) return this.network || 'mainnet';
        let configs;
        try { configs = await this.db.getAllConfigs(); }
        catch (err) {
            console.error('XChainHub: failed to resolve BTC network from configs:', err);
            return this.network || 'mainnet';
        }
        let btc = configs && configs['bitcoin'];
        if(this.network){
            if(btc && btc[this.network] && btc[this.network]['xchain-indexer']) return this.network;
            // Nothing configured is not a cross-network hazard; a tree with other
            // networks but not ours is, so refuse rather than resolve one.
            if(!btc || Object.keys(btc).length === 0) return this.network;
            throw new Error('XChainHub: HUB_NETWORK=' + this.network + ' has no bitcoin xchain-indexer in the ' +
                'configs table (present: ' + Object.keys(btc).join(', ') + '); refusing to anchor consensus to ' +
                'another network. Set BTC_INDEXER_API_URL, or push the ' + this.network + ' indexer via updateconfig.');
        }
        if(!btc) return 'mainnet';
        for(let net of ['regtest', 'testnet', 'mainnet']){
            if(btc[net] && btc[net]['xchain-indexer']) return net;
        }
        return 'mainnet';
    }

    // Attaches x-api-key when BTC_INDEXER_API_KEY is set; one shared key for all
    // hub-to-indexer traffic (the same var RewardTracker uses).
    _btcIndexerHeaders(){
        let headers = { 'Content-Type': 'application/json' };
        let key = process.env.BTC_INDEXER_API_KEY || '';
        if(key) headers['x-api-key'] = key;
        return headers;
    }

    // Resolution order is _resolveIndexerUrl's, below; the BTC_INDEXER_URL alias matters
    // most here, since a hub setting only that name falls back to seed-local snapshots and
    // self-signs at quorum 0. The URL is then VERIFIED to be a BTC indexer, because on a
    // venue with no BTC leg the lookup returns the DOGE indexer's foreign heights and stake.
    async _resolveBtcIndexerUrl(){
        let url = await this._resolveIndexerUrl('BTC');
        if(!url) return null;
        if(await this._indexerCoinMismatch(url, 'BTC')) return null;
        return url;
    }

    // True only when the indexer at `url` positively reports another coin. Unknown,
    // unreachable or no coin field means false. Verdicts cache per URL: 'ok' is permanent,
    // a mismatch is re-probed on the TTL so a repointed hub recovers on its own.
    async _indexerCoinMismatch(url, want){
        if(process.env.INDEXER_COIN_CHECK === '0') return false;
        if(!this._indexerCoinVerdicts) this._indexerCoinVerdicts = new Map();
        const RECHECK_MS = 60000;
        let key    = want + '@' + url;
        let cached = this._indexerCoinVerdicts.get(key);
        if(cached && (cached.verdict === 'ok' || (Date.now() - cached.at) < RECHECK_MS))
            return cached.verdict === 'mismatch';

        let coin = null;
        try {
            // getblockhashes is the one federation read that names the chain it answers for.
            let res = await axios.post(url, {
                jsonrpc: '2.0', id: Date.now(), method: 'getblockhashes', params: {}
            }, { headers: this._btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if(result && !result.error && result.coin) coin = String(result.coin).toUpperCase();
        } catch(_){ /* unreachable: unverifiable, not a mismatch */ }

        if(!coin){
            this._indexerCoinVerdicts.set(key, { verdict: 'unknown', at: Date.now() });
            return false;
        }
        if(coin === String(want).toUpperCase()){
            this._indexerCoinVerdicts.set(key, { verdict: 'ok', at: Date.now() });
            return false;
        }
        this._indexerCoinVerdicts.set(key, { verdict: 'mismatch', at: Date.now() });
        console.error('XChainHub: the resolved ' + want + ' indexer at ' + url + ' is a ' + coin +
            ' indexer, not ' + want + '. ' + want + '-anchored reads (capability snapshots, the ' +
            'publisher election, snapshot_block) would silently use another chain\'s state, so ' +
            'they are DISABLED until this is fixed. Set ' + want + '_INDEXER_API_URL to a real ' +
            want + ' indexer (or push the right config via updateconfig).');
        return true;
    }

    // Per-coin indexer JSON-RPC URL: env <COIN>_INDEXER_API_URL, then <COIN>_INDEXER_URL,
    // then the hub's configs table (xchain-node's updateconfig push), so a configs-only
    // hub still reaches its indexers. Returns null when nothing is configured.
    async _resolveIndexerUrl(coin){
        coin = String(coin || '').toUpperCase();
        if(process.env[coin + '_INDEXER_API_URL']) return process.env[coin + '_INDEXER_API_URL'];
        if(process.env[coin + '_INDEXER_URL']) return process.env[coin + '_INDEXER_URL'];
        if(!this.db) return null;
        let configs;
        try { configs = await this.db.getAllConfigs(); }
        catch (err) { console.error('XChainHub: failed to resolve ' + coin + ' indexer URL from configs:', err); return null; }
        const COIN_CONFIG_KEY = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' };
        let cc = configs && configs[COIN_CONFIG_KEY[coin] || coin.toLowerCase()];
        if(!cc) return null;
        // xchain-node's updateconfig push uses nested {host, port, ...} under the module key
        let urlFor = (netConfig) => {
            if(!netConfig) return null;
            let nested = netConfig['xchain-indexer'];
            let host = (nested && nested['host']) || netConfig['INDEXER_URL'];
            let port = (nested && nested['port']) || netConfig['INDEXER_API_PORT'];
            return (host && port) ? ('http://' + host + ':' + port) : null;
        };
        // A validator hub reads ONLY its own network's indexer. The preference order
        // below is a dev-loop convenience that, on a multi-network tree, silently handed
        // a mainnet-gated hub the regtest indexer.
        if(this.network) return urlFor(cc[this.network]);
        // Standalone/dev: prefer regtest > testnet > mainnet so dev loops Just Work.
        // Production should set <COIN>_INDEXER_API_URL explicitly.
        for(let net of ['regtest', 'testnet', 'mainnet']){
            let url = urlFor(cc[net]);
            if(url) return url;
        }
        return null;
    }

    // Entry point for an integration that observed this hub's on-chain stake change;
    // gossips activation only when the active state actually moves.
    async refreshOwnQualification(stakeAmount, blockIndex){
        if(!this.identity || !this.capabilityRegistry) return;
        let pubkey = this.identity.getPubkeyHex();
        this._latestBlockIndex = blockIndex || this._latestBlockIndex;
        let amount = String(stakeAmount || '0');
        this._latestStakeAmount = amount;
        for(let cap of this.capabilityRegistry.getCapabilities()){
            // Resolve the threshold AT this block, the value the federation locks against.
            let minStake = this.capabilityRegistry.getMinStake(cap, blockIndex);
            let qualified;
            if(minStake === null || minStake === undefined){
                // Fail CLOSED. Defaulting to '0' would qualify an unstaked node for
                // everything and diverge from the indexer's authoritative threshold,
                // which is a frozen configs/<COIN>.js constant, not a governance value.
                // A capability with no configured threshold stays inactive.
                qualified = false;
                if(!this._warnedMissingMinStake) this._warnedMissingMinStake = new Set();
                if(!this._warnedMissingMinStake.has(cap)){
                    console.warn('Capability "' + cap + '": no MIN_STAKE configured ' +
                        '(set CAPABILITIES.' + cap + '.MIN_STAKE in HUB_CAPABILITY_CONFIG); ' +
                        'treating as NOT qualified until a threshold is provided.');
                    this._warnedMissingMinStake.add(cap);
                }
            } else {
                qualified = this._compareDecimal(amount, minStake) >= 0;
            }
            await this.capabilityRegistry.setQualification(pubkey, cap, qualified, blockIndex);
        }
        await this._broadcastOwnCapabilityState(pubkey);
    }

    // Map a finalized governance proposal onto the in-memory capability config and
    // re-evaluate own qualification. Recognizes CAPABILITY_<CAP>_MIN_STAKE parameters;
    // anything else belongs to a different subsystem.
    async _applyCapabilityGovernanceChange(ev){
        if(!ev || !ev.parameter || !this.capabilityRegistry) return;
        let parsed = this._parseCapabilityParameter(ev.parameter);
        if(!parsed) return;
        // Block-anchored apply: append the new threshold keyed by the proposer-declared
        // activation_block instead of overwriting a live scalar, so hubs that finalize at
        // different wall-clock moments still agree on the threshold for every block. A
        // finalized MIN_STAKE proposal with no activation_block is ignored, not applied.
        if(parsed.parameterKey === 'MIN_STAKE'){
            // Pre-launch pin. Even if a MIN_STAKE proposal:finalized fires, do NOT move
            // the threshold: the indexer accepts against a frozen constant, so a hub-side
            // move forks the federation. Lift with MIN_STAKE_GOVERNANCE_DISABLED.
            if(CapabilityRegistry.MIN_STAKE_GOVERNANCE_DISABLED){
                console.warn('Governance MIN_STAKE change for ' + parsed.capability +
                    ' ignored: hub governance MIN_STAKE changes are disabled pre-launch (#4352)');
                return;
            }
            if(ev.activationBlock === undefined || ev.activationBlock === null || !Number.isInteger(Number(ev.activationBlock))){
                console.warn('Governance MIN_STAKE change for ' + parsed.capability +
                    ' has no activation_block; not applying (would be unanchored, risking cross-hub divergence)');
                return;
            }
            this.capabilityRegistry.applyMinStakeActivation(parsed.capability, Number(ev.activationBlock), String(ev.newValue));
        } else {
            this.capabilityRegistry._applyGovernanceChange(parsed.capability, parsed.parameterKey, String(ev.newValue));
        }
        // Drop cached snapshots for this capability so the next consensus read re-queries
        // under the new threshold. The cache key already folds in min_stake, so this only
        // reclaims the unreachable entries early.
        if(this.capabilitySnapshot && typeof this.capabilitySnapshot.flushCapability === 'function'){
            this.capabilitySnapshot.flushCapability(parsed.capability);
        }
        // Re-evaluate own qualification now against the latest observed stake; the
        // periodic poll reconciles with fresh on-chain truth on its next tick.
        await this.refreshOwnQualification(this._latestStakeAmount, this._latestBlockIndex);
    }

    // Applies a finalized ATTESTATION_PROVIDER change to the block-anchored provider
    // history, on the anchoring rationale at _applyCapabilityGovernanceChange above.
    async _applyProviderGovernanceChange(ev){
        if(!ev || !ev.parameter || !this.providerRegistry) return;
        let providerId = ProviderRegistry.parseAttestationProviderParam(ev.parameter);
        if(!providerId) return;
        if(ev.activationBlock === undefined || ev.activationBlock === null || !Number.isInteger(Number(ev.activationBlock))){
            console.warn('Governance ATTESTATION_PROVIDER change for ' + providerId +
                ' has no activation_block; not applying (would be unanchored, risking cross-hub divergence)');
            return;
        }
        let ac, ms, cs;
        try {
            let parsed = JSON.parse(String(ev.newValue));
            ac = (parsed && parsed.additional_config) ? parsed.additional_config : parsed;
            // The provider stake floor rides the same entry. Read here as well as in
            // loadGovernanceHistory: this is the LIVE path and that is the RESTART replay,
            // and a floor seen by only one would diverge restarted hubs from long-running ones.
            ms = (parsed && parsed.min_stake_xchain !== undefined) ? parsed.min_stake_xchain : undefined;
            // The PBFT consensus_strategy rides it too, on the same both-paths rule.
            cs = (parsed && parsed.consensus_strategy !== undefined) ? parsed.consensus_strategy : undefined;
        } catch (e) {
            console.warn('Governance ATTESTATION_PROVIDER change for ' + providerId +
                ' has unparseable proposed_value; not applying:', e && e.message ? e.message : e);
            return;
        }
        this.providerRegistry.applyProviderConfigActivation(providerId, Number(ev.activationBlock), ac, ms, cs);
    }

    // Parse CAPABILITY_<CAP>_MIN_STAKE into { capability, parameterKey }, where <CAP> is
    // the uppercased capability name. Null for anything else.
    _parseCapabilityParameter(parameter){
        let m = /^CAPABILITY_(.+)_MIN_STAKE$/.exec(String(parameter || ''));
        if(!m) return null;
        let capability = m[1].toLowerCase();
        if(!this.capabilityRegistry || this.capabilityRegistry.getCapabilities().indexOf(capability) === -1) return null;
        return { capability: capability, parameterKey: 'MIN_STAKE' };
    }

    // In-flight guard: _capabilityRecheckTimer fires on a bare setInterval while
    // runAllSelfTests fans out to every module's slow healthCheck, so passes would stack
    // and emit duplicate CAPABILITY_ACTIVATED/DEACTIVATED broadcasts. The config-watch
    // re-check is skipped while a pass runs; the next scheduled tick applies the reload.
    async _runOwnCapabilityCheck(pubkey){
        if(!this.capabilityRegistry) return;
        if(this._capabilityCheckRunning) return;
        this._capabilityCheckRunning = true;
        try {
            await this.capabilityRegistry.runAllSelfTests(pubkey);
            await this._broadcastOwnCapabilityState(pubkey);
        } finally {
            this._capabilityCheckRunning = false;
        }
    }

    async _broadcastOwnCapabilityState(pubkey){
        if(!this.peerManager || !this.identity || !this.capabilityRegistry) return;
        for(let cap of this.capabilityRegistry.getCapabilities()){
            let active = await this.capabilityRegistry.isActive(pubkey, cap);
            let data = {
                pubkey:     pubkey,
                capability: cap,
                block_at:   this._latestBlockIndex
            };
            if(!active){
                let state = await this.capabilityRegistry.getState(pubkey, cap);
                if(state && state.self_test_msg) data.reason = state.self_test_msg;
            }
            this.peerManager.broadcast(active ? 'CAPABILITY_ACTIVATED' : 'CAPABILITY_DEACTIVATED', data);
        }
    }

    // PeerManager has already sig-verified the envelope, so the only extra requirement
    // is that data.pubkey match the sender's, or operator A could claim B's capabilities.
    async _handleCapabilityMessage(envelope){
        if(!this.capabilityRegistry) return;
        let data = envelope.data || {};
        if(!data.pubkey || !data.capability) return;
        let senderPubkey = this.peerManager && this.peerManager.validatorPubkeys
            ? this.peerManager.validatorPubkeys.get(envelope.sender) : null;
        if(senderPubkey && String(data.pubkey).toLowerCase() !== String(senderPubkey).toLowerCase()){
            console.warn('Capability message from ' + envelope.sender + ' claims pubkey ' + data.pubkey + ' but sender is registered as ' + senderPubkey + '; dropping');
            return;
        }
        if(envelope.type === 'CAPABILITY_SELF_TEST'){
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, !!data.ok, data.reason || null);
        } else if(envelope.type === 'CAPABILITY_ACTIVATED'){
            // The self-test is a local-readiness claim, accepted as-is. The qualification
            // claim is stake-backed, so verify it against the indexer's snapshot at the
            // claimed block; a peer must not advertise a capability it is not staked for.
            // When the indexer cannot be consulted, accept for liveness (slashing backstops).
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, true, null);
            let qualified = true;
            try {
                let snap = (this.capabilitySnapshot && data.block_at !== undefined && data.block_at !== null)
                    ? await this.capabilitySnapshot.getSnapshot(data.capability, data.block_at)
                    : null;
                if(snap && !this.capabilitySnapshot.isInSnapshot(snap, data.pubkey)){
                    console.warn('Capability activation from ' + envelope.sender + ' for "' + data.capability +
                        '" rejected: pubkey ' + data.pubkey + ' is not in the indexer stake snapshot at block ' +
                        data.block_at + ' (claimed qualification it is not staked for).');
                    qualified = false;
                }
            } catch(e){ /* indexer hiccup; fall back to accepting (liveness) */ }
            await this.capabilityRegistry.setQualification(data.pubkey, data.capability, qualified, data.block_at || null);
            await this.capabilityRegistry.setEnabled(data.pubkey, data.capability, true);
        } else if(envelope.type === 'CAPABILITY_DEACTIVATED'){
            // Failing the peer's self-test is what routes work away from it.
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, false, data.reason || 'peer reported deactivation');
        }
    }

    // Exact decimal string comparison. Aggregated stake can exceed float64's safe-integer
    // range (DECIMAL(30,8) sums), so parseFloat would round two distinct amounts together
    // and mis-qualify an underweight validator. Returns -1, 0 or 1; 0 if unparseable.
    _compareDecimal(a, b){
        let pa = this._parseDecimalParts(a);
        let pb = this._parseDecimalParts(b);
        if(!pa || !pb) return 0;
        if(pa.neg !== pb.neg) return pa.neg ? -1 : 1;
        let scale = Math.max(pa.frac.length, pb.frac.length);
        let ai = BigInt(pa.int + pa.frac.padEnd(scale, '0'));
        let bi = BigInt(pb.int + pb.frac.padEnd(scale, '0'));
        let cmp = ai < bi ? -1 : (ai > bi ? 1 : 0);
        return pa.neg ? -cmp : cmp;
    }

    // Parse a decimal string into { neg, int, frac }, or null when not a finite decimal.
    _parseDecimalParts(v){
        let s = String(v == null ? '' : v).trim();
        if(!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
        let neg = s[0] === '-';
        if(s[0] === '+' || s[0] === '-') s = s.slice(1);
        let dot = s.indexOf('.');
        let int  = (dot === -1 ? s : s.slice(0, dot)) || '0';
        let frac = dot === -1 ? '' : s.slice(dot + 1);
        if(/^0*$/.test(int) && /^0*$/.test(frac)) neg = false;
        return { neg: neg, int: int, frac: frac };
    }

    async close(){
        if(this._capabilityRecheckTimer){ clearInterval(this._capabilityRecheckTimer); this._capabilityRecheckTimer = null; }
        if(this._stakePollTimer){ clearInterval(this._stakePollTimer); this._stakePollTimer = null; }
        if(this._transportSetTimer){ clearInterval(this._transportSetTimer); this._transportSetTimer = null; }
        if(this._capabilityConfigDebounce){ clearTimeout(this._capabilityConfigDebounce); this._capabilityConfigDebounce = null; }
        if(this._capabilityConfigWatcher){ try { this._capabilityConfigWatcher.close(); } catch(e){} this._capabilityConfigWatcher = null; }
        if(this.governance)       await this.governance.stop();
        if(this.reorgHandler)     await this.reorgHandler.stop();
        if(this.stateAnchorPublisher) await this.stateAnchorPublisher.stop();
        if(this.retractionConsensus) this.retractionConsensus.stop();
        if(this.stateCheckpoints) await this.stateCheckpoints.stop();
        if(this.crossChainCalls)  await this.crossChainCalls.stop();
        if(this.crossChainDex)    await this.crossChainDex.stop();
        if(this.crossChain)       await this.crossChain.stop();
        if(this.oracle)           await this.oracle.stop();
        if(this.oracleConsensus)  await this.oracleConsensus.stop();
        if(this.consensus)        await this.consensus.stop();
        if(this.peerManager)      await this.peerManager.stop();
        if(this.db)               await this.db.close();
    }
}

module.exports = XChainHub;
