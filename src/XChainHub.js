/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
const AttestationSpotChecker = require('./AttestationSpotChecker.js');
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
        this.db = new Database(this.dbHost, this.dbPort, this.dbName, this.dbUser, this.dbPass);
        await this.db.createDatabase();
        await this.db.verifyTables();
        await this.db.runMigrations();

        // PriceAggregator doesn't require P2P/PBFT — always available for receiving on-chain PRICE actions
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

    // Start the P2P gossip layer (no-op if p2pConfig is null)
    async startP2P(){
        if(!this.p2pConfig) return;

        // Load validator identity if private key is configured
        if(this.p2pConfig.SIGNING_PRIVKEY_HEX){
            this.identity = new ValidatorIdentity(this.p2pConfig.SIGNING_PRIVKEY_HEX);
            console.log('Validator identity loaded (pubkey: ' + this.identity.getPubkeyHex().substring(0, 16) + '...)');
        }

        this.peerManager = new PeerManager(this.p2pConfig, this.db);

        // Attach identity for signing
        if(this.identity){
            this.peerManager.setIdentity(this.identity);
        }

        // Load validator pubkey registry for verification. This MUST succeed
        // before the P2P listener opens: a null registry makes _verifySignature
        // accept any signed envelope from any sender (see PeerManager). On a DB
        // failure _loadValidatorPubkeys throws, so we never reach start() below.
        await this._loadValidatorPubkeys();

        // Fail closed: refuse to open the P2P listener with a null validator
        // registry. An empty (non-null) registry is fine — it rejects every
        // unknown sender, which is the correct pre-bootstrap state while
        // validators are still being registered via the registervalidator RPC.
        if(!this.peerManager.validatorPubkeys){
            throw new Error('Validator registry not loaded — refusing to start the P2P listener (database unavailable?)');
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

    // Option A transport auth — refresh the chain-effective signer set from the
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
    // transport signer set can't be refreshed. Does NOT clear the existing set —
    // retaining last-known-good is the no-fail-open invariant; the registry
    // remains the floor. Silent before the first successful refresh (the inert
    // no-chain-validator-set state needs no alarm).
    _warnTransportStale(why){
        let maxAgeMs = (this.p2pConfig && this.p2pConfig.P2P_SIGNER_SET_MAX_AGE_MS) || 600000;
        if(this._transportSignerSetAt && (Date.now() - this._transportSignerSetAt) > maxAgeMs){
            console.warn('XChainHub: transport signer set STALE (' + why + '); retaining last-known-good set of ' +
                this._transportSignerSet.size + ' pubkey(s) — registry remains the auth floor');
        }
    }

    // Start the PBFT consensus engine (no-op if P2P is not active)
    async startConsensus(){
        if(!this.peerManager) return;
        this.consensus = new Consensus(this);

        // Load validator set for leader rotation
        let validators = await this._loadValidatorSet();
        this.consensus.setValidatorSet(validators);

        await this.consensus.start();
    }

    // Get the PeerManager instance
    getPeerManager(){
        return this.peerManager;
    }

    // Get the Consensus instance
    getConsensus(){
        return this.consensus;
    }

    // Start the oracle round system (no-op if P2P is not active)
    async startOracle(){
        if(!this.peerManager) return;

        // Create oracle round manager
        this.oracle = new OracleRound(this);

        // Create oracle consensus engine
        this.oracleConsensus = new OracleConsensus(this, this.oracle);
        let validators = await this._loadValidatorSet();
        this.oracleConsensus.setValidatorSet(validators);

        // Wire them together
        this.oracle.setConsensus(this.oracleConsensus);

        // Create reward tracker and slash detector
        this.rewardTracker = new RewardTracker(this);
        this.slashDetector = new SlashDetector(this);

        // Subscribe to oracle finalization events
        this.oracleConsensus.on('round:finalized', async (event) => {
            // Resolve participant addrs to pubkeys for rewards
            let participantPubkeys = [];
            if(this.peerManager.validatorPubkeys){
                for(let addr of event.participants){
                    let pk = this.peerManager.validatorPubkeys.get(addr);
                    if(pk) participantPubkeys.push(pk);
                }
            }

            // Distribute rewards (passes BTC block height for indexer-side block_index)
            await this.rewardTracker.distributeRewards(event.round, participantPubkeys, event.btcBlockHeight);

            // Check for slashable offenses
            await this.slashDetector.checkRound(
                event.round, event.submissions, event.prices,
                participantPubkeys, validators
            );
        });

        // Start all oracle subsystems
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

    // Get the ValidatorIdentity instance
    getIdentity(){
        return this.identity;
    }

    // Get the OracleRound instance
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

        this.attestationConsensus = new AttestationConsensus(this, this.providerRegistry);
        this.attestationRound     = new AttestationRound(this, this.providerRegistry);
        this.attestationRound.setConsensus(this.attestationConsensus);

        this.attestationPublisher  = new AttestationPublisher(this);
        // Wire the operator-supplied signer (HUB_SIGNER_MODULE) into the
        // attestation publish pipeline, mirroring startOracle(). Without this
        // a validator with only HUB_SIGNER_MODULE configured finalizes ATTEST
        // responses but never broadcasts them — the queue grows forever.
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
            // peers — keeping the qualified validator set deterministic across the
            // federation without a hub restart. No-op for non-capability params.
            this.governance.on('proposal:finalized', (ev) => {
                this._applyCapabilityGovernanceChange(ev).catch(e =>
                    console.error('Capability config hot-reload failed:', e));
            });
        }

        console.log('Attestation framework started (providers: ' + this.providerRegistry.listProviderIds().join(', ') + ')');
    }

    // Accessors
    getAttestationRound(){       return this.attestationRound; }
    getAttestationConsensus(){   return this.attestationConsensus; }
    getAttestationPublisher(){   return this.attestationPublisher; }
    getAttestationSpotChecker(){ return this.attestationSpotChecker; }
    getProviderRegistry(){       return this.providerRegistry; }

    // Start the cross-chain attestation engine (no-op if P2P is not active)
    async startCrossChain(){
        if(!this.peerManager) return;
        this.crossChain = new CrossChainEngine(this);
        let validators = await this._loadValidatorSet();
        this.crossChain.setValidatorSet(validators);

        // Load per-chain-pair validator sets for cross_chain capability filtering
        let chainPairMap = await this._loadChainPairValidators();
        this.crossChain.setChainPairValidators(chainPairMap);

        // Create and wire SWAP tracker
        this.swapTracker = new SwapTracker(this);
        this.swapTracker.start(this.crossChain);

        await this.crossChain.start();

        // Cross-chain DEX engine — matches cross-chain ORDER/SWAP offers across chains
        // and drives their settlement via the validator-broadcast XSETTLE rail. Only
        // active when at least one chain's indexer URL is configured (XDEX_*/per-coin
        // INDEXER_URL); otherwise it idles harmlessly.
        this.crossChainDex = new CrossChainDexEngine(this);
        await this.crossChainDex.start();

        // Cross-chain contract call relay (XCALL) — confirmation-gates contract-
        // emitted cross-chain call requests, PBFTs the dispatch + result rows, and
        // mirrors them to indexers (zero per-call chain writes; same transport as
        // cross_chain_matches). Idles harmlessly without indexer URLs.
        this.crossChainCalls = new CrossChainCallEngine(this);
        await this.crossChainCalls.start();

        // State checkpoints — quorum-signed per-chain ledger/actions/contract hash
        // commitments, written off-chain to state_checkpoints and streamed over the
        // hub-DB mirror so explorers/wallets can verify indexer state.
        this.stateCheckpoints = new StateCheckpointEngine(this);
        await this.stateCheckpoints.start();

        // ANCHOR publisher — commits the latest checkpoints (v0) and the
        // cross-chain match archive (v1/v2) on DOGE, making all federation state
        // recoverable from chain parse alone. A clean no-op when DOGE publishing
        // isn't configured (mirrors the oracle/anchor publishers).
        this.stateAnchorPublisher = new StateAnchorPublisher(this);
        await this.stateAnchorPublisher.start();
    }

    // Get the CrossChainEngine instance
    getCrossChain(){
        return this.crossChain;
    }

    // Get the CrossChainDexEngine instance
    getCrossChainDex(){
        return this.crossChainDex;
    }

    // Start the reorg handler (no-op if P2P is not active)
    async startReorgHandler(){
        if(!this.peerManager) return;
        this.reorgHandler = new ReorgHandler(this);
        let validators = await this._loadValidatorSet();
        this.reorgHandler.setValidatorSet(validators);
        await this.reorgHandler.start();
    }

    // Report a blockchain reorg
    async reportReorg(chain, reorgHeight, timestamp){
        if(!this.reorgHandler) throw new Error('Reorg handler not active');
        return await this.reorgHandler.reportReorg(chain, reorgHeight, timestamp);
    }

    // Get reorg history
    async getReorgHistory(limit){
        if(!this.reorgHandler) return [];
        return await this.reorgHandler.getReorgHistory(limit);
    }

    // Start the governance engine (no-op if P2P is not active)
    async startGovernance(){
        if(!this.peerManager) return;
        this.governance = new Governance(this);
        let validators = await this._loadValidatorSet();
        this.governance.setValidatorSet(validators);
        await this.governance.start();
    }

    // Submit a governance proposal
    async propose(parameter, currentValue, proposedValue, rationale){
        if(!this.governance) throw new Error('Governance not active');
        return await this.governance.propose(parameter, currentValue, proposedValue, rationale);
    }

    // Cast a governance vote
    async vote(proposalId, voteChoice){
        if(!this.governance) throw new Error('Governance not active');
        return await this.governance.vote(proposalId, voteChoice);
    }

    // Get governance proposals
    async getProposals(status){
        if(!this.governance) return [];
        return await this.governance.getProposals(status);
    }

    // Get a specific proposal with votes
    async getProposal(proposalId){
        if(!this.governance) return null;
        return await this.governance.getProposal(proposalId);
    }

    // Request a cross-chain attestation
    async requestAttestation(sourceChain, sourceActionIndex, destChain){
        if(!this.crossChain) throw new Error('Cross-chain engine not active');
        return await this.crossChain.requestAttestation(sourceChain, sourceActionIndex, destChain);
    }

    // Initiate a cross-chain SWAP
    async initiateSwap(sourceChain, sourceActionIndex, destChain, destActionIndex){
        if(!this.swapTracker) throw new Error('SWAP tracker not active');
        await this.swapTracker.initiateSwap(sourceChain, sourceActionIndex, destChain, destActionIndex);
        return true;
    }

    // Get a specific swap
    async getSwap(sourceChain, sourceActionIndex){
        if(!this.swapTracker) return null;
        return await this.swapTracker.getSwap(sourceChain, sourceActionIndex);
    }

    // Query swaps
    async getSwaps(status, limit){
        if(!this.swapTracker) return [];
        return await this.swapTracker.getSwaps(status, limit);
    }

    // Update config — routes through consensus if active, otherwise writes directly
    async addParametersFromJson(json){
        if(this.consensus){
            await this.consensus.propose(json);
            return true;
        }
        await this.applyConfig(json);
        return true;
    }

    // Apply config directly to the database
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

                    // Service-location params (original 8-key allowlist — preserved unchanged)
                    for(let nextParam of PARAMETER_LIST){
                        let nextValue = moduleLevel[nextParam];
                        if(nextValue === null || nextValue === undefined) continue;

                        // Enforce string type and length
                        if (typeof nextValue !== 'string') {
                            console.warn('XChainHub.applyConfig: non-string value for ' + nextParam + ' — coercing');
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
                            console.warn('XChainHub.applyConfig: non-string value for ' + nextParam + ' — coercing');
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

                    // JSON blob params (GAS_SCHEDULE, STAKING) — serialized to a JSON string
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
        // deterministically by signing_pubkey sort order — the F8-drill bug.
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
        // consensus engine — a validator registered at runtime must enter
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

    // Load sorted validator set for consensus leader rotation
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

            let allChains = ['BTC', 'LTC', 'DOGE'];
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

    // Get price snapshots from DB
    async getPriceSnapshots(limit) {
        let query = "SELECT * FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC, coin_pair ASC LIMIT ?";
        return await this.db.doQuery(query, [limit || 50]);
    }

    // Get latest price for a coin pair
    async getPrice(coinPair) {
        let query = "SELECT * FROM price_snapshots WHERE coin_pair = ? AND status = 'finalized' ORDER BY round_number DESC LIMIT 1";
        let rows = await this.db.doQuery(query, [coinPair]);
        return rows.length > 0 ? rows[0] : null;
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

    // Get the active validator list
    async getValidators() {
        let query = "SELECT signing_pubkey, addr, status, created_at, updated_at FROM validators WHERE status = 'active' ORDER BY signing_pubkey";
        return await this.db.doQuery(query);
    }

    // Get detailed status for a validator
    async getValidatorStatus(signingPubkey) {
        // Get validator info
        let vRows = await this.db.doQuery(
            "SELECT * FROM validators WHERE signing_pubkey = ?", [signingPubkey]
        );
        if (vRows.length === 0) return null;

        // Get unclaimed rewards
        let unclaimed = this.rewardTracker ? await this.rewardTracker.getUnclaimedRewards(signingPubkey) : '0';

        // Get recent rewards
        let rewards = this.rewardTracker ? await this.rewardTracker.getRewardHistory(signingPubkey, 20) : [];

        // Get slash proposals
        let slashes = this.slashDetector ? await this.slashDetector.getProposalsForValidator(signingPubkey) : [];

        return {
            validator:       vRows[0],
            unclaimedRewards: unclaimed,
            recentRewards:   rewards,
            slashProposals:  slashes
        };
    }

    // Calculate a fee quote: gas cost → XCHAIN → native coin
    // action: string (e.g., 'ISSUE'), chain: string (e.g., 'BTC'), params: object
    async getFeeQuote(action, chain) {
        // Gas schedule — mirrors the canonical per-chain fee schedule. BTC
        // carries the full set; the VM_ATTEST_REQUEST entry is only metered on
        // chains where the attestation framework is active. Every other entry
        // shares identical gas values across chains.
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

        // Gas price (XCHAIN per gas unit). Sourced from the config store so it
        // can be tuned per-chain without a code change; falls back to the
        // protocol default when no override is present (or the store is down).
        let gasPrice = 0.00001;
        try {
            let chainCfg = await this.db.getConfig(chain, 'mainnet', 'chain');
            if (chainCfg && chainCfg.GAS_PRICE) {
                let parsed = parseFloat(chainCfg.GAS_PRICE);
                if (parsed > 0) gasPrice = parsed;
            }
        } catch (_) { /* config store unavailable — keep protocol default */ }

        if (!Object.prototype.hasOwnProperty.call(gasSchedule, action)) return { error: 'unknown action: ' + action };
        let gasCost = gasSchedule[action];

        let xchainAmount = gasCost * gasPrice;

        // Get XCHAIN/USD and chain/USD prices from latest snapshots
        let xchainPriceRow = await this.getPrice('XCHAIN/USD');
        let coinPrice      = await this.getPrice(chain + '/USD');

        if (!xchainPriceRow || !xchainPriceRow.price) {
            throw new Error('XCHAIN/USD oracle price unavailable — cannot compute fee quote');
        }
        let xchainUsd = parseFloat(xchainPriceRow.price);
        if (xchainUsd <= 0) {
            throw new Error('XCHAIN/USD oracle price is zero or negative — cannot compute fee quote');
        }

        let result = {
            action:       action,
            chain:        chain,
            gasCost:      gasCost,
            gasPrice:     gasPrice.toFixed(8),
            xchainAmount: xchainAmount.toFixed(8),
            xchainUsd:    xchainUsd.toFixed(8)
        };

        // If we have the coin/USD price, compute the native coin amount
        if (coinPrice && coinPrice.price) {
            let coinUsd = parseFloat(coinPrice.price);
            if (coinUsd > 0) {
                let feeUsd = xchainAmount * xchainUsd;
                let nativeCoinAmount = feeUsd / coinUsd;

                result.feeUsd           = feeUsd.toFixed(8);
                result.coinUsd          = coinUsd.toFixed(8);
                result.nativeCoinAmount = nativeCoinAmount.toFixed(8);
                result.nativeCoin       = chain;
            }
        }

        return result;
    }

    /*****************************************************************
     * Capability tracking
     *
     * Initializes CapabilityRegistry, runs initial self-tests for this
     * hub's identity, schedules periodic re-checks, optionally watches
     * a config file for hot-reload, and wires peer-capability gossip
     * into the local registry.
     *
     * Safe to call without P2P or without an identity — those subsystems
     * just no-op accordingly.
     *
     * Spec: claude/reports/specs/2026-05-24_capability-staking-model.md
     ****************************************************************/
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

        // Subscribe to peer capability messages (only meaningful if P2P is active)
        if(this.peerManager){
            this.peerManager.on('capability', (envelope) => {
                this._handleCapabilityMessage(envelope).catch(e => {
                    console.error('Capability message handler error:', e);
                });
            });
        }

        // Run initial self-tests for this hub's identity
        if(this.identity){
            let pubkey = this.identity.getPubkeyHex();
            await this._runOwnCapabilityCheck(pubkey);

            // Periodic re-check
            let intervalMs = (this.p2pConfig && this.p2pConfig.CAPABILITY_RECHECK_MS) ? this.p2pConfig.CAPABILITY_RECHECK_MS : 60000;
            this._capabilityRecheckTimer = setInterval(() => {
                this._runOwnCapabilityCheck(pubkey).catch(e => {
                    console.error('Capability re-check failed:', e);
                });
            }, intervalMs);

            // Watch config file for hot-reload (optional)
            if(configFilePath && fs.existsSync(configFilePath)){
                try {
                    this._capabilityConfigWatcher = fs.watch(configFilePath, { persistent: false }, () => {
                        // Debounce: fs.watch fires multiple times per change
                        if(this._capabilityConfigDebounce) clearTimeout(this._capabilityConfigDebounce);
                        this._capabilityConfigDebounce = setTimeout(() => {
                            // Re-read the file contents into p2pConfig + the live
                            // registry so an edit actually changes thresholds/config —
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

        console.log('Capability registry initialized' + (this.identity ? ' (identity: ' + this.identity.getPubkeyHex().substring(0,16) + '...)' : ' (no identity — peer-receive only)'));
    }

    // Query the BTC indexer for own pubkey's current active stake amount + latest
    // block index, then feed both into refreshOwnQualification. Best-effort —
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
        let res = await axios.post(url, body, { headers: this._btcIndexerHeaders(), timeout: 5000 });
        let result = res && res.data && res.data.result;
        if(!result || result.error){
            // Indexer either not ready or returned a structured error. Don't change state.
            return;
        }
        await this.refreshOwnQualification(result.amount, result.block_index);
    }

    // Resolve the latest BTC block index. Priority:
    //   1. hub.db.getChainTip('BTC', <network>) — populated by indexer
    //      pushChainTip when the indexer is configured with HUB_API_URL.
    //      Network is the same one _resolveBtcIndexerUrl picks (so we
    //      consult the matching tip).
    //   2. Direct getlatestblock JSON-RPC call to the BTC indexer — covers
    //      stacks where the chain-tip-push isn't wired (e.g. local regtest
    //      development) so block-boundary snapshotting Just Works.
    // Returns null when both paths fail.
    async _resolveBtcLatestBlock(){
        let network = await this._resolveBtcNetwork();
        try {
            let tip = await this.db.getChainTip('BTC', network);
            if(tip && tip.blockHeight) return tip.blockHeight;
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
    // same env var RewardTracker uses for reward pushes — one shared key for
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
        if(process.env.BTC_INDEXER_API_URL) return process.env.BTC_INDEXER_API_URL;
        if(process.env.BTC_INDEXER_URL) return process.env.BTC_INDEXER_URL;
        if(!this.db) return null;
        let configs;
        try { configs = await this.db.getAllConfigs(); }
        catch (err) { console.error('XChainHub: failed to resolve BTC indexer URL from configs:', err); return null; }
        let btc = configs && configs['bitcoin'];
        if(!btc) return null;
        // Prefer regtest > testnet > mainnet so dev loops Just Work. Production
        // deployments should set BTC_INDEXER_API_URL explicitly.
        for(let net of ['regtest', 'testnet', 'mainnet']){
            let netConfig = btc[net];
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
            let minStake = this.capabilityRegistry.getMinStake(cap);
            let qualified;
            if(minStake === null || minStake === undefined){
                // No MIN_STAKE configured for this capability. Fail CLOSED — do not
                // default the threshold to '0', which would qualify an unstaked node
                // for everything and diverge from the indexer's authoritative
                // (governance) threshold used to lock quorum N. A capability with no
                // configured threshold simply stays inactive until one is supplied.
                qualified = false;
                if(!this._warnedMissingMinStake) this._warnedMissingMinStake = new Set();
                if(!this._warnedMissingMinStake.has(cap)){
                    console.warn('Capability "' + cap + '": no MIN_STAKE configured ' +
                        '(set CAPABILITIES.' + cap + '.MIN_STAKE in HUB_CAPABILITY_CONFIG) — ' +
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
    // parameter is ignored here — it's owned by a different subsystem.
    async _applyCapabilityGovernanceChange(ev){
        if(!ev || !ev.parameter || !this.capabilityRegistry) return;
        let parsed = this._parseCapabilityParameter(ev.parameter);
        if(!parsed) return;
        this.capabilityRegistry._applyGovernanceChange(parsed.capability, parsed.parameterKey, String(ev.newValue));
        // Re-evaluate own qualification immediately against the new threshold,
        // using the most recent observed on-chain stake amount. The periodic
        // stake poll (_pollOwnStake) reconciles with fresh on-chain truth on its
        // next tick; doing it here too closes the window without waiting for it.
        await this.refreshOwnQualification(this._latestStakeAmount, this._latestBlockIndex);
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
            console.warn('Capability message from ' + envelope.sender + ' claims pubkey ' + data.pubkey + ' but sender is registered as ' + senderPubkey + ' — dropping');
            return;
        }
        if(envelope.type === 'CAPABILITY_SELF_TEST'){
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, !!data.ok, data.reason || null);
        } else if(envelope.type === 'CAPABILITY_ACTIVATED'){
            // Peer claims activation. The self-test is a local-readiness claim and only
            // matters alongside qualification, so we accept it as-is. The qualification
            // claim is stake-backed, so verify it against the indexer's authoritative
            // stake snapshot at the claimed block before trusting it — a peer must not be
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
            } catch(e){ /* indexer hiccup — fall back to accepting (liveness) */ }
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
