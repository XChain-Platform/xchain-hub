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
const PriceAggregator    = require('./PriceAggregator.js');
const OraclePublisher    = require('./OraclePublisher.js');
const { loadSignerHooks, applySignerHooks } = require('./lib/signer-loader.js');
const HubDbBroadcaster   = require('./HubDbBroadcaster.js');
const CapabilityRegistry = require('./CapabilityRegistry.js');
const CapabilitySnapshot = require('./CapabilitySnapshot.js');
const ProviderRegistry      = require('./ProviderRegistry.js');
const AttestationRound       = require('./AttestationRound.js');
const AttestationConsensus   = require('./AttestationConsensus.js');
const AttestationPublisher   = require('./AttestationPublisher.js');
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
        // Deployment network (mainnet|testnet|regtest) for consensus activation gating,
        // notably STAKE_WEIGHTED_QUORUM. Set in validator mode (validated in api.js);
        // '' in standalone (no consensus runs there).
        this.network   = (this.p2pConfig && this.p2pConfig.HUB_NETWORK) ? String(this.p2pConfig.HUB_NETWORK) : '';
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
        this._capabilityRecheckTimer = null;
        this._capabilityConfigWatcher = null;
        this._stakePollTimer          = null;
        this._transportSetTimer       = null;   // Option A: chain-effective signer-set refresh timer
        this._transportSignerSet      = new Set();  // last-known-good effective signer set (lowercased pubkey hex)
        this._transportSignerSetAt    = 0;       // ms timestamp of last successful refresh (0 = never)
        this._latestBlockIndex        = null;  // most recent observed BTC block index (for capability gossip block_at)
        this._latestStakeAmount       = null;  // most recent observed own on-chain stake amount (for threshold re-evaluation)
    }

    async start(){
        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN before
        // any DB or serving work (mirrors xchain-indexer's boot check). The hub is the
        // platform's config oracle: it acts on this config (PBFT/oracle/attestation)
        // and serves consensusHashes to every consumer, so a drifted/corrupted bundle
        // must halt boot rather than propagate federation-wide. A null pin (mainnet,
        // pre-arm) skips; a mismatch on an armed network throws (fail-closed).
        for(const net of coins.NETWORKS) coins.verifyConsensusPin(net);

        this.db = new Database(this.dbHost, this.dbPort, this.dbName, this.dbUser, this.dbPass);
        await this.db.createDatabase();
        await this.db.verifyTables();
        await this.db.runMigrations();

        // PriceAggregator doesn't require P2P/PBFT (always available for receiving on-chain PRICE actions
        this.priceAggregator = new PriceAggregator(this);
        // HubDbBroadcaster forwards row inserts from the aggregator to WebSocket subscribers
        // for the cross-chain hub DB sync channel (used by indexers running in distributed mode)
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

        // Load validator pubkey registry for verification. This MUST succeed
        // before the P2P listener opens: a null registry makes _verifySignature
        // accept any signed envelope from any sender (see PeerManager). On a DB
        // failure _loadValidatorPubkeys throws, so we never reach start() below.
        await this._loadValidatorPubkeys();

        // Fail closed: refuse to open the P2P listener with a null validator
        // registry. An empty (non-null) registry is fine; it rejects every
        // unknown sender, which is the correct pre-bootstrap state while
        // validators are still being registered via the registervalidator RPC.
        if(!this.peerManager.validatorPubkeys){
            throw new Error('Validator registry not loaded; refusing to start the P2P listener (database unavailable?)');
        }

        await this.peerManager.start();

        // Option A transport auth: begin following the on-chain effective signer
        // set so transport auth tracks validator key rotation without manual
        // registry edits. Best-effort immediate refresh + periodic poll. Inert
        // where there is no chain validator set (empty snapshot → the registry
        // remains the auth floor), e.g. a prod single-validator hub.
        let refreshMs = (this.p2pConfig && this.p2pConfig.P2P_SIGNER_SET_REFRESH_MS) || 30000;
        this._refreshTransportSignerSet().catch(e => console.error('Initial transport signer-set refresh failed:', e));
        this._transportSetTimer = setInterval(() => {
            this._refreshTransportSignerSet().catch(e => console.error('Transport signer-set refresh failed:', e));
        }, refreshMs);
    }

    // Option A transport auth: refresh the chain-effective signer set from the
    // on-chain validator snapshot and push it into the PeerManager. The effective
    // set is ADDITIVE to the validator registry (a pubkey in either is admitted),
    // so transport auth follows on-chain key rotation. NEVER clears the set to
    // empty on an upstream failure (no fail-open): the last-known-good set is
    // retained and the registry remains the authorization floor.
    async _refreshTransportSignerSet(){
        if(!this.peerManager) return;
        let block = await this._resolveBtcLatestBlock();
        if(block == null){ this._warnTransportStale('BTC tip unresolved'); return; }
        let snap = await this.capabilitySnapshot.getActiveValidatorSnapshot(block);
        if(!snap || !Array.isArray(snap.validators)){ this._warnTransportStale('validator snapshot unavailable'); return; }
        let set = new Set(snap.validators.map(v => String(v.pubkey).toLowerCase()));
        this._transportSignerSet   = set;
        this._transportSignerSetAt = Date.now();
        this.peerManager.setEffectiveSignerSet(set);
    }

    // Warn loudly (once the last good refresh ages past a threshold) when the
    // transport signer set can't be refreshed. Does NOT clear the existing set;
    // retaining last-known-good is the no-fail-open invariant; the registry
    // remains the floor. Silent before the first successful refresh (the inert
    // no-chain-validator-set state needs no alarm).
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
            // Guarded: db.doQuery now throws on query errors, and a rejection out
            // of an EventEmitter listener is an unhandled rejection (process exit).
            try {
                // Resolve participant addrs to pubkeys for rewards
                let participantPubkeys = [];
                if(this.peerManager.validatorPubkeys){
                    for(let addr of event.participants){
                        let pk = this.peerManager.validatorPubkeys.get(addr);
                        if(pk) participantPubkeys.push(pk);
                    }
                }

                await this.rewardTracker.distributeRewards(event.round, participantPubkeys, event.btcBlockHeight);

                await this.slashDetector.checkRound(
                    event.round, event.submissions, event.prices,
                    participantPubkeys, validators
                );
            } catch (e){
                console.error('round:finalized reward/slash handling failed for round ' + (event && event.round) + ':', e && e.message ? e.message : e);
            }
        });

        await this.oracleConsensus.start();
        await this.oracle.start();

        // Start the oracle_publish capability publisher (no-op if no broadcast hook is wired up)
        // The publisher subscribes to round:finalized events and queues finalized rounds
        // for publishing to the DOGE chain. The actual broadcast transport is wired
        // by the operator via setBroadcastHook() / setBalanceHook().
        this.oraclePublisher = new OraclePublisher(this);
        // Wire the operator-supplied signer (HUB_SIGNER_MODULE) into the DOGE
        // pipeline. This is the single wiring point for ALL on-chain DOGE
        // publishing: StateAnchorPublisher borrows these hooks via
        // _resolveSigner(). Throws on a configured-but-broken module.
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

    // Start the External Attestation Framework subsystems (no-op if P2P is not active).
    // ProviderRegistry → AttestationConsensus → AttestationRound → AttestationPublisher.
    // Mirrors startOracle()'s shape; intended to be called after startGovernance.
    async startAttestation(){
        if(!this.peerManager) return;

        this.providerRegistry = new ProviderRegistry(this);
        await this.providerRegistry.load();
        // Rebuild the block-anchored provider-config history from finalized governance
        // proposals so a freshly-started hub resolves the same fetch/judge model for every
        // block as a long-running one (mirror of capabilityRegistry.loadGovernanceHistory).
        await this.providerRegistry.loadGovernanceHistory();

        this.attestationConsensus = new AttestationConsensus(this, this.providerRegistry);
        this.attestationRound     = new AttestationRound(this, this.providerRegistry);
        this.attestationRound.setConsensus(this.attestationConsensus);

        this.attestationPublisher  = new AttestationPublisher(this);
        // Wire the operator-supplied signer (HUB_SIGNER_MODULE) into the
        // attestation publish pipeline, mirroring startOracle(). Without this
        // a validator with only HUB_SIGNER_MODULE configured finalizes ATTEST
        // responses but never broadcasts them; the queue grows forever.
        let attestationSignerHooks = loadSignerHooks();
        if(attestationSignerHooks){
            applySignerHooks(this.attestationPublisher, attestationSignerHooks);
            console.log('AttestationPublisher: operator signer wired (' + attestationSignerHooks.source + ')');
        }
        this.attestationSpotChecker = new AttestationSpotChecker(this, this.providerRegistry);

        await this.attestationConsensus.start();
        await this.attestationRound.start();
        await this.attestationPublisher.start();
        await this.attestationSpotChecker.start();

        // Hot-reload provider registry on governance proposal finalization.
        // No-op if governance isn't started or doesn't emit this event.
        if(this.governance && typeof this.governance.on === 'function'){
            this.governance.on('proposal:finalized', () => {
                this.providerRegistry.hotReload().catch(e =>
                    console.error('ProviderRegistry hot-reload failed:', e));
            });

            // Hot-reload capability thresholds on governance proposal finalization.
            // A passed proposal that changes a capability's MIN_STAKE updates the
            // in-memory capConfig and re-evaluates this node's own qualification, so
            // long-running nodes converge on the new threshold with freshly-started
            // peers, keeping the qualified validator set deterministic across the
            // federation without a hub restart. No-op for non-capability params.
            this.governance.on('proposal:finalized', (ev) => {
                this._applyCapabilityGovernanceChange(ev).catch(e =>
                    console.error('Capability config hot-reload failed:', e));
            });

            // Append block-anchored ATTESTATION_PROVIDER config changes to the provider
            // config history so the LLM fetch/judge model resolves deterministically at the
            // request's block on every hub. No-op for non-provider params.
            this.governance.on('proposal:finalized', (ev) => {
                this._applyProviderGovernanceChange(ev).catch(e =>
                    console.error('Provider config history update failed:', e));
            });
        }

        console.log('Attestation framework started (providers: ' + this.providerRegistry.listProviderIds().join(', ') + ')');

        // Full-node challenge round (verified-validator tier). Shares the same
        // operator signer wiring as the attestation/oracle publishers; without a
        // broadcast hook (or encoder + wallet-sign) the elected leader assembles
        // verdicts but can't post them, so the engine stays observe-only.
        // The slash detector is otherwise created by startOracle(); a hub that runs
        // the full-node tier without the price-oracle subsystem still needs it to
        // record failed-challenge slash proposals, so ensure one exists here.
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
    getProviderRegistry(){       return this.providerRegistry; }

    async startCrossChain(){
        if(!this.peerManager) return;
        this.crossChain = new CrossChainEngine(this);
        let validators = await this._loadValidatorSet();
        this.crossChain.setValidatorSet(validators);

        // Load per-chain-pair validator sets for cross_chain capability filtering
        let chainPairMap = await this._loadChainPairValidators();
        this.crossChain.setChainPairValidators(chainPairMap);

        this.swapTracker = new SwapTracker(this);
        this.swapTracker.start(this.crossChain);

        await this.crossChain.start();

        // Cross-chain DEX engine: matches cross-chain ORDER/SWAP offers across chains
        // and drives their settlement via the validator-broadcast XSETTLE rail. Only
        // active when at least one chain's indexer URL is configured (XDEX_*/per-coin
        // INDEXER_URL); otherwise it idles harmlessly.
        this.crossChainDex = new CrossChainDexEngine(this);
        await this.crossChainDex.start();

        // Cross-chain contract call relay (XCALL): confirmation-gates contract-
        // emitted cross-chain call requests, PBFTs the dispatch + result rows, and
        // mirrors them to indexers (zero per-call chain writes; same transport as
        // cross_chain_matches). Idles harmlessly without indexer URLs.
        this.crossChainCalls = new CrossChainCallEngine(this);
        await this.crossChainCalls.start();

        // State checkpoints: quorum-signed per-chain ledger/actions/contract hash
        // commitments, written off-chain to state_checkpoints and streamed over the
        // hub-DB mirror so explorers/wallets can verify indexer state.
        this.stateCheckpoints = new StateCheckpointEngine(this);
        await this.stateCheckpoints.start();

        // Signed retractions ( full fix): collects 2f+1 cross_chain
        // co-signatures over quorum-class reorg-retraction broadcasts before they
        // reach the mirror stream. The engines route their retract-path deletions
        // through it; below the flag-day / without an identity it falls through
        // to the legacy unsigned broadcast.
        this.retractionConsensus = new RetractionConsensus(this);

        // ANCHOR publisher: commits the latest checkpoints (v0) and the
        // cross-chain match archive (v1/v2) on DOGE, making all federation state
        // recoverable from chain parse alone. A clean no-op when DOGE publishing
        // isn't configured (mirrors the oracle/anchor publishers).
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

    // Update config: routes through consensus if active, otherwise writes directly
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

                    // Service-location params (original 8-key allowlist, preserved unchanged)
                    for(let nextParam of PARAMETER_LIST){
                        let nextValue = moduleLevel[nextParam];
                        if(nextValue === null || nextValue === undefined) continue;

                        // Enforce string type and length
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

                    // Flat scalar operational params (GAS_PRICE, ACTIVATION_DELAY_BLOCKS, etc.)
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

                    // JSON blob params (GAS_SCHEDULE, STAKING), serialized to a JSON string
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

    // sinceUpdatedAt (optional) is an epoch-seconds cursor; when supplied only
    // rows changed after that instant are returned. Omit it for the full tree.
    async getAllConfigs(sinceUpdatedAt){
        return await this.db.getAllConfigs(sinceUpdatedAt);
    }

    // High-water mark (epoch seconds) consumers thread back as the cursor above.
    async getConfigWatermark(){
        return await this.db.getConfigWatermark();
    }

    // Last committed PBFT sequence number (0 on a fresh node). Surfaced alongside
    // getAllConfigs so consumers can detect a committed config change between polls.
    async getLastSeq(){
        return await this.db.getLastSeq();
    }

    // Register a validator (for Phase 2C bootstrap)
    async registerValidator(signingPubkey, addr){
        if(!signingPubkey || !/^[0-9a-fA-F]{64}$/.test(signingPubkey))
            throw new Error('Invalid signing pubkey (must be 64 hex chars)');
        if(!addr)
            throw new Error('Validator addr is required');

        // Addr-keyed: each addr has exactly ONE active pubkey. Retire any other
        // active row for this addr (a different signing key) BEFORE the upsert,
        // so registering a new key for an existing addr replaces the old one
        // (the rotation path). Without this, _loadValidatorPubkeys' Map<addr,
        // pubkey> resolves a two-active-rows-per-addr collision non-
        // deterministically by signing_pubkey sort order (the F8-drill bug).
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

        // Reload pubkey registry and propagate the new set to EVERY running
        // consensus engine; a validator registered at runtime must enter
        // oracle leader rotation etc., not just config-PBFT. Previously only
        // this.consensus was updated; the resulting per-hub divergent leader
        // views made a hub silently miss every round whose expected leader
        // never proposes (standing-federation Phase 1, finding F1).
        await this._loadValidatorPubkeys();
        await this._propagateValidatorSet();

        console.log('Validator registered: ' + addr + ' (pubkey: ' + signingPubkey.substring(0, 16) + '...)');
        return true;
    }

    // Rotate the signing key of the validator at `addr` to `newSigningPubkey`:
    // retire the addr's current active key, activate the new one, reload +
    // propagate. The on-chain capability layer follows key rotation
    // automatically (DELEGATE v0/v2 → effective set); this is the manual
    // transport-registry equivalent until Option A makes transport auth
    // chain-following. Rejects an addr with no current active validator (use
    // registerValidator for a fresh addr).
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

    // Deregister a validator by signing_pubkey OR addr: mark active row(s)
    // status='removed' and reload + propagate. The first-class replacement for
    // the raw `UPDATE ... SET status='removed'` SQL the F8 drill needed.
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

    // Load the active validator set once and push it into every running
    // consensus engine. registerValidator and syncValidators both route here
    // so runtime membership changes reach ALL PBFT subsystems.
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

    // Load validator pubkeys from DB into PeerManager for signature verification
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
            // Fail closed: propagate so the startup path (startP2P) does not open
            // the P2P listener with a null registry. Swallowing here previously
            // left validatorPubkeys === null on a transient DB failure, which
            // makes _verifySignature accept any signed message. Reload callers
            // (registerValidator / syncValidators) already hold a non-null
            // registry, so a failed reload there surfaces as an error without
            // reopening the null-registry window.
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

    // Load per-chain-pair validator subsets for cross-chain quorum
    // Validators with a 'chains' column (comma-separated) are filtered by chain-pair
    // Validators with NULL/empty chains support all chains (backward compat)
    async _loadChainPairValidators(){
        let chainPairMap = new Map();
        try {
            // The 'chains' column is declared in validators.sql and reconciled on
            // startup by the schema-drift check in db.js (verifyTables →
            // alterTableForDrift), so it is guaranteed present here.
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

    // status: optional filter. Default 'finalized' (the historical contract; fee
    // and price consumers must never see skipped/disputed rows here). 'all'
    // additionally returns skipped (round produced no usable price for the pair)
    // and disputed (reorg-retracted) rows so health/monitoring consumers can see
    // the failure states instead of silently falling back to an older finalized
    // round. Additive: existing callers are unchanged.
    async getPriceSnapshots(limit, status) {
        if (status === 'all') {
            let query = "SELECT * FROM price_snapshots ORDER BY round_number DESC, coin_pair ASC LIMIT ?";
            return await this.db.doQuery(query, [limit || 50]);
        }
        let query = "SELECT * FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC, coin_pair ASC LIMIT ?";
        return await this.db.doQuery(query, [limit || 50]);
    }

    // Oracle price staleness bound in seconds (deepdive L-5). Mirrors the indexer's
    // ORACLE_MAX_PRICE_AGE_SECONDS (getFeeOraclePrices / db.getLatestPrice), so the
    // hub's advisory getprice/getfeequote reject the same stale rounds the indexer's
    // fee gate rejects instead of serving an arbitrarily old price. 0 disables the
    // bound. block_timestamp is stored in Unix SECONDS (OracleConsensus). Precedence:
    // p2pConfig / env override, else the consensus-pinned value from the canonical
    // coin registry (never a hardcoded literal, so a coordinated release that changes
    // the pinned ORACLE_MAX_PRICE_AGE_SECONDS can't silently diverge the hub advisory
    // from the indexer gate).
    _oracleMaxAgeSeconds(coinPair) {
        let raw = (this.p2pConfig && this.p2pConfig.ORACLE_MAX_PRICE_AGE_SECONDS != null)
            ? this.p2pConfig.ORACLE_MAX_PRICE_AGE_SECONDS
            : process.env.ORACLE_MAX_PRICE_AGE_SECONDS;
        let v = parseInt(raw, 10);
        if (Number.isFinite(v)) return v;
        return this._registryOracleMaxAge(coinPair);
    }

    // The consensus-pinned ORACLE_MAX_PRICE_AGE_SECONDS for the coin pair, read from
    // the canonical coin registry (the same source the consensus hash covers). The
    // pair's base tick selects the coin; a pair with no registry coin (e.g. the
    // XCHAIN/USD advisory pair) or an unknown network falls back to a known registry
    // coin (BTC) so no literal copy of the pinned constant lives in this file.
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
        // Registry unavailable (should never happen: the coin bundle is vendored in).
        // Return null so the caller's `maxAge > 0` guard fails open on staleness rather
        // than reintroducing a hardcoded copy of the consensus-pinned constant.
        return null;
    }

    // Latest finalized snapshot for a coin pair plus a staleness verdict (L-5).
    // { row, fresh, stale, missing, ageSeconds, maxAgeSeconds }. A snapshot whose
    // reference-block timestamp is older than the oracle max age is flagged stale so
    // callers can refuse it rather than serve it. A snapshot with no usable
    // block_timestamp (0/absent, e.g. legacy rows) is never aged out (age unknown).
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

    // Freshest finalized price for a coin pair, or null when missing OR stale. Returning
    // null on stale makes getFeeQuote fail closed (it treats an unavailable price as an
    // error) instead of quoting off an outdated oracle round (L-5). Callers that need to
    // distinguish stale from missing use getPriceStatus.
    async getPrice(coinPair) {
        let s = await this.getPriceStatus(coinPair);
        return s.fresh ? s.row : null;
    }

    // Sync validators from external data (e.g., indexer staking data)
    // validators: [{ signing_pubkey, addr, tier, chains }]
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

        // Reload validator set across all subsystems (now also reorg +
        // governance, which previously only got the boot-time set)
        await this._loadValidatorPubkeys();
        await this._propagateValidatorSet();

        console.log('Validators synced: ' + validators.length + ' entries');
        return true;
    }

    async getValidators() {
        let query = "SELECT signing_pubkey, addr, status, created_at, updated_at FROM validators WHERE status = 'active' ORDER BY signing_pubkey";
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
        // Default gas schedule: mirrors the canonical per-chain fee schedule. BTC
        // carries the full set; the VM_ATTEST_REQUEST entry is only metered on
        // chains where the attestation framework is active. Every other entry
        // shares identical gas values across chains. Overridden by the GAS_SCHEDULE
        // config blob when present, so the schedule stays in sync with the indexer.
        let gasSchedule = {
            ISSUE:                  100000,
            ISSUE_SUBTOKEN:         50000,
            EXPIRATION_PER_DAY:     550,
            OWNERSHIP_ESCROW:       50000,
            AIRDROP_PER_RECIPIENT:  100,
            DIVIDEND_PER_RECIPIENT: 100,
            VM_EXECUTE_BASE:        1000,
            VM_DEPLOY_BASE:         100000,
            VM_DEPLOY_PER_BYTE:     10,
            VM_STATE_READ:          100,
            VM_STATE_WRITE:         200,
            VM_STATE_DELETE:        100,
            VM_ORACLE_READ:         100,
            VM_CROSSCHAIN_READ:     100,
            VM_ATTEST_REQUEST:      5000,
            VM_EMISSION:            500,
            VM_COMPUTATION:         1
        };

        // Use the hub's deployment network (mainnet|testnet|regtest) so a testnet
        // or regtest hub reads the right config rows instead of always reading mainnet.
        let network = this.network || 'mainnet';

        // Gas price (XCHAIN per gas unit). Read from the hub's own network config
        // so testnet/regtest hubs pick up their own overrides, not mainnet values.
        // GAS_SCHEDULE blob, when present, overrides the hardcoded schedule above.
        let gasPrice = '0.00001';
        try {
            let chainCfg = await this.db.getConfig(chain, network, 'chain');
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

        // Formats a bignumber to exactly 8 decimal places (trailing zeros preserved),
        // matching the .toFixed(8) format the consumer tests and indexer charging expect.
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

    // Read + merge the capability config JSON into p2pConfig so the self-test
    // modules and CapabilityRegistry see operator-supplied MIN_STAKE thresholds
    // (CAPABILITIES) and per-capability config blocks (price.sources,
    // cross_chain.chains, oracle_publish.doge_*). Used both at startup and on
    // hot-reload. Throws on read/parse errors (callers decide how loud to be).
    _loadCapabilityConfigFile(configFilePath){
        let parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
        if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('capability config must be a JSON object');
        if(!this.p2pConfig) this.p2pConfig = {};
        const KEYS = ['CAPABILITIES', 'DISABLED_CAPABILITIES', 'price', 'cross_chain',
                      'oracle_publish', 'attestation', 'CAPABILITY_RECHECK_MS', 'STAKE_POLL_MS'];
        for(let k of KEYS){
            if(k in parsed) this.p2pConfig[k] = parsed[k];
        }
        // Keep a live registry's view in sync so hot-reload applies without a restart.
        if(this.capabilityRegistry){
            this.capabilityRegistry.capConfig = this.p2pConfig.CAPABILITIES || {};
            // Re-seed the block-0 genesis threshold from the reloaded config (#3703). Preserves
            // any already-appended governance activation entries; only the genesis entry is reset.
            this.capabilityRegistry._seedGenesisHistory();
            this.capabilityRegistry.disabled  = new Set(this.p2pConfig.DISABLED_CAPABILITIES || []);
        }
        console.log('Loaded capability config from ' + configFilePath +
            ' (thresholds: ' + Object.keys(this.p2pConfig.CAPABILITIES || {}).join(', ') + ')');
    }

    async startCapabilities(configFilePath){
        // Load operator-supplied capability config (MIN_STAKE thresholds + the
        // per-capability self-test config blocks) BEFORE constructing the registry,
        // which snapshots p2pConfig.CAPABILITIES at construction time. Without this,
        // the self-tests read an empty config and every config-bearing capability
        // (price/cross_chain/oracle_publish) fails with "config missing".
        if(configFilePath){
            try {
                this._loadCapabilityConfigFile(configFilePath);
            } catch(e){
                console.warn('Could not load capability config from ' + configFilePath + ': ', e);
            }
        }
        this.capabilityRegistry = new CapabilityRegistry(this);
        // Rebuild block-anchored MIN_STAKE history from finalized governance proposals so a
        // restarted hub resolves the same per-block thresholds as long-running peers (#3703).
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
                            // Re-read the file contents into p2pConfig + the live
                            // registry so an edit actually changes thresholds/config;
                            // previously the watcher only re-ran self-tests against the
                            // stale in-memory config, so file edits had no effect.
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

            // Poll the BTC indexer for own on-chain stake amount and feed it
            // into refreshOwnQualification so qualification flags track on-chain
            // STAKE/UNSTAKE without manual intervention. URL resolves from env
            // first, then the hub's own configs table (populated by xchain-node).
            // No-op + no timer attached when no URL can be resolved.
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

        // Surface the genesis MIN_STAKE per capability so an operator can verify it matches
        // the indexer's frozen configs/<COIN>.js constants. Governance MIN_STAKE changes are
        // disabled pre-launch (#4352), so these genesis values are the thresholds the hub
        // locks quorum against for every block; a mismatch with the indexer would fork.
        try {
            let genesis = this.capabilityRegistry.getCapabilities()
                .map(cap => cap + '=' + String(this.capabilityRegistry.getMinStake(cap)))
                .join(', ');
            console.log('Capability MIN_STAKE (genesis, pinned #4352): ' + genesis +
                ' (must equal the indexer configs/<COIN>.js constants)');
        } catch (e) { /* best-effort operator log */ }
    }

    // Query the BTC indexer for own pubkey's current active stake amount + latest
    // block index, then feed both into refreshOwnQualification. Best-effort:
    // network/indexer failures are logged but do not change state.
    async _pollOwnStake(pubkey){
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
                // Auth failure is distinct from the indexer being down: the operator
                // has a key mismatch between the indexer and this hub. Log clearly so
                // they can identify the misconfiguration instead of seeing a generic
                // "unreachable" message and chasing a network issue.
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

    // Resolve the latest BTC block index. Priority:
    //   1. hub.db.getChainTip('BTC', <network>): populated by indexer
    //      pushChainTip when the indexer is configured with HUB_API_URL.
    //      Network is the same one _resolveBtcIndexerUrl picks (so we
    //      consult the matching tip).
    //   2. Direct getlatestblock JSON-RPC call to the BTC indexer; covers
    //      stacks where the chain-tip-push isn't wired (e.g. local regtest
    //      development) so block-boundary snapshotting Just Works.
    // Returns null when both paths fail.
    async _resolveBtcLatestBlock(){
        let network = await this._resolveBtcNetwork();
        try {
            let tip = await this.db.getChainTip('BTC', network);
            // Freshness bound on the indexer-pushed tip (path 1). If the co-located
            // indexer halts, pushChainTip stops arriving and getChainTip keeps
            // serving the SAME frozen row forever; without this check path 1 keeps
            // succeeding and the lag-guarded direct path (path 2) below is never
            // reached, so consensus snapshot locking / oracle rounds would anchor
            // to an arbitrarily stale height indefinitely. Fall through to the
            // lag-guarded path (which may return null so callers degrade) when the
            // pushed tip is stale or its age is unverifiable.
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
            // Guard against anchoring a snapshot on a stale tip. The indexer
            // reports `lag` = how many blocks its committed tip trails the
            // decoder's current tip. When the indexer is processing far behind
            // (e.g. repeated contract watchdog timeouts), its tip no longer
            // reflects recent on-chain state. Past a configurable gap, treat the
            // tip as untrustworthy and fall back to graceful degradation rather
            // than locking a stale validator set into the consensus round.
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

    // Freshness gate for the indexer-pushed BTC tip consumed by path 1 of
    // _resolveBtcLatestBlock. setChainTip stores block_time alongside the height
    // (db.js), so an age check is available without an extra round-trip. Returns
    // false (fall through to the lag-guarded direct path) when the tip is older
    // than MAX_TIP_AGE_S, or when its block_time is missing/zero (unverifiable,
    // so not trusted blindly). Default bound mirrors OracleRound's
    // chainTipStalenessThresholdS: 2x the oracle round interval.
    _btcPushedTipFresh(tip){
        let maxAge = Number(process.env.MAX_TIP_AGE_S);
        if(!Number.isFinite(maxAge) || maxAge <= 0){
            let roundIntervalMs = (this.p2pConfig && Number(this.p2pConfig.ORACLE_ROUND_INTERVAL)) || 600000;
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

    // Which BTC network does this hub talk to? Looks at the hub's own
    // configs table for an installed BTC indexer. Single-network hubs
    // (the common case) return whichever network is installed.
    // Multi-network hubs (rare) get the first match per the preference
    // order, matching _resolveBtcIndexerUrl.
    // Defaults to 'mainnet' for safety when no configs are loaded yet.
    async _resolveBtcNetwork(){
        if(!this.db) return 'mainnet';
        let configs;
        try { configs = await this.db.getAllConfigs(); }
        catch (err) { console.error('XChainHub: failed to resolve BTC network from configs:', err); return 'mainnet'; }
        let btc = configs && configs['bitcoin'];
        if(!btc) return 'mainnet';
        for(let net of ['regtest', 'testnet', 'mainnet']){
            if(btc[net] && btc[net]['xchain-indexer']) return net;
        }
        return 'mainnet';
    }

    // Build request headers for BTC indexer JSON-RPC calls. Attaches the
    // x-api-key header when BTC_INDEXER_API_KEY is configured so federation
    // read/write calls authenticate against the indexer's API-key gate. The
    // same env var RewardTracker uses for reward pushes; one shared key for
    // all hub→indexer traffic.
    _btcIndexerHeaders(){
        let headers = { 'Content-Type': 'application/json' };
        let key = process.env.BTC_INDEXER_API_KEY || '';
        if(key) headers['x-api-key'] = key;
        return headers;
    }

    // Resolve the BTC indexer JSON-RPC URL. Priority:
    //   1. BTC_INDEXER_API_URL env var (explicit operator override)
    //   2. BTC_INDEXER_URL env var (commonly-set alias; without this fallback a
    //      hub configured with only BTC_INDEXER_URL silently falls to seed-local
    //      capability snapshots and self-signs at quorum 0)
    //   3. Hub's own configs table (populated by xchain-node's updateconfig push)
    // Returns null when none yields a usable URL.
    async _resolveBtcIndexerUrl(){
        return this._resolveIndexerUrl('BTC');
    }

    // Per-coin indexer JSON-RPC URL resolution: env <COIN>_INDEXER_API_URL ->
    // env <COIN>_INDEXER_URL -> the hub's own configs table (xchain-node's
    // updateconfig push). Generalizes the former BTC-only resolver so the hub
    // engines can reach the indexer on a configs-table-provisioned hub (no env
    // vars), instead of silently skipping every chain. Returns null when nothing
    // is configured.
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
        // Prefer regtest > testnet > mainnet so dev loops Just Work. Production
        // deployments should set <COIN>_INDEXER_API_URL explicitly.
        for(let net of ['regtest', 'testnet', 'mainnet']){
            let netConfig = cc[net];
            if(!netConfig) continue;
            // xchain-node's updateconfig push uses nested {host, port, ...} under the module key
            let nested = netConfig['xchain-indexer'];
            let host = (nested && nested['host']) || netConfig['INDEXER_URL'];
            let port = (nested && nested['port']) || netConfig['INDEXER_API_PORT'];
            if(host && port) return 'http://' + host + ':' + port;
        }
        return null;
    }

    // Called by external integration when this hub's on-chain stake amount changes.
    // Triggers qualification recompute + activation gossip if active state changes.
    async refreshOwnQualification(stakeAmount, blockIndex){
        if(!this.identity || !this.capabilityRegistry) return;
        let pubkey = this.identity.getPubkeyHex();
        this._latestBlockIndex = blockIndex || this._latestBlockIndex;
        let amount = String(stakeAmount || '0');
        this._latestStakeAmount = amount;
        for(let cap of this.capabilityRegistry.getCapabilities()){
            // Resolve the threshold AT this block so own-qualification tracks the same
            // block-anchored value the federation locks quorum against (#3703).
            let minStake = this.capabilityRegistry.getMinStake(cap, blockIndex);
            let qualified;
            if(minStake === null || minStake === undefined){
                // No MIN_STAKE configured for this capability. Fail CLOSED: do not
                // default the threshold to '0', which would qualify an unstaked node
                // for everything and diverge from the indexer's authoritative
                // threshold. That threshold is a FROZEN configs/<COIN>.js consensus
                // constant, NOT a governance value (hub governance MIN_STAKE changes
                // are disabled pre-launch, #4352); the hub's genesis MIN_STAKE from
                // HUB_CAPABILITY_CONFIG must equal it. A capability with no configured
                // threshold simply stays inactive until one is supplied.
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

    // Map a finalized governance proposal onto the in-memory capability config
    // and re-evaluate this node's own qualification against the new threshold.
    // Recognizes parameters named CAPABILITY_<CAP>_MIN_STAKE (e.g.
    // CAPABILITY_PRICE_MIN_STAKE, CAPABILITY_CROSS_CHAIN_MIN_STAKE). Any other
    // parameter is ignored here; it's owned by a different subsystem.
    async _applyCapabilityGovernanceChange(ev){
        if(!ev || !ev.parameter || !this.capabilityRegistry) return;
        let parsed = this._parseCapabilityParameter(ev.parameter);
        if(!parsed) return;
        // Block-anchored apply (#3703): append the new threshold to the capability's history keyed
        // by the proposer-declared activation_block rather than overwriting a live scalar. The
        // change does not take effect until the chain reaches activation_block; getMinStake(cap, N)
        // resolves the value effective at N, so all hubs agree on the threshold for every block
        // even though they finalize at different wall-clock moments. A finalized MIN_STAKE proposal
        // with no activation_block (e.g. a legacy row) is ignored here rather than applied unanchored.
        if(parsed.parameterKey === 'MIN_STAKE'){
            // Pre-launch pin (#4352): final safety net. Even if a MIN_STAKE proposal:finalized
            // somehow fires (e.g. a mixed-version rollout where an un-pinned hub passed one),
            // do NOT move the threshold: the indexer accepts against a frozen configs/<COIN>.js
            // constant, so any hub-side move forks the federation from the chain. getMinStake
            // stays pinned to the genesis value. Lift with MIN_STAKE_GOVERNANCE_DISABLED when
            // the indexer flag-day (option a) ships.
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
        // Drop cached validator-set snapshots for this capability so the next
        // consensus read re-queries the indexer under the new threshold instead
        // of serving a snapshot computed from the old one. The snapshot cache key
        // already folds in min_stake (so the stale entries are unreachable), but
        // flushing reclaims them at once rather than waiting out the TTL.
        if(this.capabilitySnapshot && typeof this.capabilitySnapshot.flushCapability === 'function'){
            this.capabilitySnapshot.flushCapability(parsed.capability);
        }
        // Re-evaluate own qualification immediately against the new threshold,
        // using the most recent observed on-chain stake amount. The periodic
        // stake poll (_pollOwnStake) reconciles with fresh on-chain truth on its
        // next tick; doing it here too closes the window without waiting for it.
        await this.refreshOwnQualification(this._latestStakeAmount, this._latestBlockIndex);
    }

    // Apply a finalized ATTESTATION_PROVIDER governance change to the block-anchored
    // provider-config history. Mirror of _applyCapabilityGovernanceChange: append the new
    // config keyed by the proposer-declared activation_block rather than overwriting a live
    // value, so every hub resolves the same fetch/judge model for every block even though
    // they finalize at different wall-clock moments. A finalized provider-config proposal
    // with no activation_block is ignored here rather than applied unanchored.
    async _applyProviderGovernanceChange(ev){
        if(!ev || !ev.parameter || !this.providerRegistry) return;
        let providerId = ProviderRegistry.parseAttestationProviderParam(ev.parameter);
        if(!providerId) return;
        if(ev.activationBlock === undefined || ev.activationBlock === null || !Number.isInteger(Number(ev.activationBlock))){
            console.warn('Governance ATTESTATION_PROVIDER change for ' + providerId +
                ' has no activation_block; not applying (would be unanchored, risking cross-hub divergence)');
            return;
        }
        let ac;
        try {
            let parsed = JSON.parse(String(ev.newValue));
            ac = (parsed && parsed.additional_config) ? parsed.additional_config : parsed;
        } catch (e) {
            console.warn('Governance ATTESTATION_PROVIDER change for ' + providerId +
                ' has unparseable proposed_value; not applying:', e && e.message ? e.message : e);
            return;
        }
        this.providerRegistry.applyProviderConfigActivation(providerId, Number(ev.activationBlock), ac);
    }

    // Parse a governance parameter name of the form CAPABILITY_<CAP>_MIN_STAKE
    // into { capability, parameterKey }, where <CAP> is the uppercased capability
    // name (price → PRICE, cross_chain → CROSS_CHAIN). Returns null for any
    // parameter that isn't a known-capability MIN_STAKE field.
    _parseCapabilityParameter(parameter){
        let m = /^CAPABILITY_(.+)_MIN_STAKE$/.exec(String(parameter || ''));
        if(!m) return null;
        let capability = m[1].toLowerCase();
        if(!this.capabilityRegistry || this.capabilityRegistry.getCapabilities().indexOf(capability) === -1) return null;
        return { capability: capability, parameterKey: 'MIN_STAKE' };
    }

    // Combined own-state update: self-test + qualification (qualification reuses cached amount if available) + broadcast
    async _runOwnCapabilityCheck(pubkey){
        if(!this.capabilityRegistry) return;
        await this.capabilityRegistry.runAllSelfTests(pubkey);
        await this._broadcastOwnCapabilityState(pubkey);
    }

    // Broadcast current activation state for every capability owned by this pubkey
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

    // Apply an inbound peer capability message to the local registry.
    // Trust model: the gossip envelope is already sig-verified by PeerManager.
    // We additionally require the data.pubkey to match the sender's known pubkey
    // (operator A cannot claim capabilities for operator B's pubkey).
    async _handleCapabilityMessage(envelope){
        if(!this.capabilityRegistry) return;
        let data = envelope.data || {};
        if(!data.pubkey || !data.capability) return;
        // Verify the claimed pubkey matches the sender's registered pubkey
        let senderPubkey = this.peerManager && this.peerManager.validatorPubkeys
            ? this.peerManager.validatorPubkeys.get(envelope.sender) : null;
        if(senderPubkey && String(data.pubkey).toLowerCase() !== String(senderPubkey).toLowerCase()){
            console.warn('Capability message from ' + envelope.sender + ' claims pubkey ' + data.pubkey + ' but sender is registered as ' + senderPubkey + '; dropping');
            return;
        }
        if(envelope.type === 'CAPABILITY_SELF_TEST'){
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, !!data.ok, data.reason || null);
        } else if(envelope.type === 'CAPABILITY_ACTIVATED'){
            // Peer claims activation. The self-test is a local-readiness claim and only
            // matters alongside qualification, so we accept it as-is. The qualification
            // claim is stake-backed, so verify it against the indexer's authoritative
            // stake snapshot at the claimed block before trusting it; a peer must not be
            // able to advertise a capability it isn't actually staked for. If the indexer
            // can't be consulted (no block in the message, or indexer unreachable) we fall
            // back to accepting the claim to preserve liveness; slashing-for-failure stays
            // the backstop.
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
            // Peer reports deactivation. Mark self_test as failed with reason so we route away.
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, false, data.reason || 'peer reported deactivation');
        }
    }

    // Exact decimal string comparison. Aggregated stake amounts can exceed the
    // float64 safe-integer range (the indexer returns DECIMAL(30,8) sums), so
    // parseFloat would silently round two distinct amounts to the same value and
    // mis-qualify an underweight validator. We compare the decimal digits directly
    // instead. Returns -1, 0, or 1 (0 for any unparseable operand).
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

    // Parse a decimal string into { neg, int, frac } digit strings, or null if the
    // value is not a finite decimal number.
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
