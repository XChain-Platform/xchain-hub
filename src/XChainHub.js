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
const ReorgHandler       = require('./ReorgHandler.js');
const SwapTracker        = require('./SwapTracker.js');
const Governance         = require('./Governance.js');
const PriceAggregator    = require('./PriceAggregator.js');
const OraclePublisher    = require('./OraclePublisher.js');
const HubDbBroadcaster   = require('./HubDbBroadcaster.js');
const CapabilityRegistry = require('./CapabilityRegistry.js');
const CapabilitySnapshot = require('./CapabilitySnapshot.js');
const fs                 = require('fs');
const axios              = require('axios');
const PARAMETER_LIST = ["host", "port", "service_port", "db_host", "db_port", "name", "user", "pass"];

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
        this._capabilityRecheckTimer = null;
        this._capabilityConfigWatcher = null;
        this._stakePollTimer          = null;
        this._latestBlockIndex        = null;  // most recent observed BTC block index (for capability gossip block_at)
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
        this.hubDbBroadcaster = new HubDbBroadcaster(this.p2pConfig || {});
        this.priceAggregator.on('row:inserted', (event) => {
            this.hubDbBroadcaster.broadcastRow(event);
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

        // Load validator pubkey registry for verification
        await this._loadValidatorPubkeys();

        await this.peerManager.start();
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

        // Start the Tier 3 publisher (no-op if no broadcast hook is wired up)
        // The publisher subscribes to round:finalized events and queues finalized rounds
        // for publishing to the DOGE chain. The actual broadcast transport is wired
        // by the operator via setBroadcastHook() / setBalanceHook().
        this.oraclePublisher = new OraclePublisher(this);
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

    // Start the cross-chain attestation engine (no-op if P2P is not active)
    async startCrossChain(){
        if(!this.peerManager) return;
        this.crossChain = new CrossChainEngine(this);
        let validators = await this._loadValidatorSet();
        this.crossChain.setValidatorSet(validators);

        // Load per-chain-pair validator sets for Tier 2 filtering
        let chainPairMap = await this._loadChainPairValidators();
        this.crossChain.setChainPairValidators(chainPairMap);

        // Create and wire SWAP tracker
        this.swapTracker = new SwapTracker(this);
        this.swapTracker.start(this.crossChain);

        await this.crossChain.start();
    }

    // Get the CrossChainEngine instance
    getCrossChain(){
        return this.crossChain;
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

                        // Enforce string type and length
                        if (typeof nextValue !== 'string') {
                            console.warn('XChainHub.applyConfig: non-string value for ' + nextParam + ' — coercing');
                            nextValue = String(nextValue);
                        }
                        if (nextValue.length > 1024) {
                            throw new Error('Config value for ' + nextParam + ' exceeds max length of 1024 chars');
                        }

                        await this.db.setParam(nextCoin, nextNetwork, nextModule, nextParam, nextValue);
                    }
                }
            }
        }
    }

    async getAllConfigs(){
        return await this.db.getAllConfigs();
    }

    // Register a validator (for Phase 2C bootstrap)
    async registerValidator(signingPubkey, addr){
        if(!signingPubkey || !/^[0-9a-fA-F]{64}$/.test(signingPubkey))
            throw new Error('Invalid signing pubkey (must be 64 hex chars)');
        if(!addr)
            throw new Error('Validator addr is required');

        await this.db.doQuery(
            `INSERT INTO validators (signing_pubkey, addr, status)
             VALUES (?, ?, 'active')
             ON DUPLICATE KEY UPDATE addr = ?, status = 'active', updated_at = NOW()`,
            [signingPubkey, addr, addr]
        );

        // Reload pubkey registry and validator set
        await this._loadValidatorPubkeys();
        if(this.consensus){
            let validators = await this._loadValidatorSet();
            this.consensus.setValidatorSet(validators);
        }

        console.log('Validator registered: ' + addr + ' (pubkey: ' + signingPubkey.substring(0, 16) + '...)');
        return true;
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
            console.error('Error loading validator pubkeys:', e.message);
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
            console.error('Error loading validator set:', e.message);
            return [];
        }
    }

    // Load per-chain-pair validator subsets for cross-chain quorum
    // Validators with a 'chains' column (comma-separated) are filtered by chain-pair
    // Validators with NULL/empty chains support all chains (backward compat)
    async _loadChainPairValidators(){
        let chainPairMap = new Map();
        try {
            // Ensure the 'chains' column exists. (The 'tier' column was dropped in the
            // capability-staking refactor — 2026-05-24_capability-staking-model.md.)
            await this.db.doQuery("ALTER TABLE validators ADD COLUMN chains VARCHAR(50) DEFAULT NULL").catch(() => {});

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
            console.error('Error loading chain-pair validators:', e.message);
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

        // Reload validator set across all subsystems
        await this._loadValidatorPubkeys();
        let validatorSet = await this._loadValidatorSet();
        if (this.consensus) this.consensus.setValidatorSet(validatorSet);
        if (this.oracleConsensus) this.oracleConsensus.setValidatorSet(validatorSet);

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
        // Gas schedule (same as indexer config)
        let gasSchedule = {
            ISSUE: 100000, ISSUE_SUBTOKEN: 50000,
            EXPIRATION_PER_DAY: 550,
            AIRDROP_PER_RECIPIENT: 100, DIVIDEND_PER_RECIPIENT: 100,
            VM_EXECUTE_BASE: 1000, VM_DEPLOY_BASE: 100000
        };
        let gasPrice = 0.00001;  // XCHAIN per gas unit

        if (!Object.prototype.hasOwnProperty.call(gasSchedule, action)) return { error: 'unknown action: ' + action };
        let gasCost = gasSchedule[action];

        let xchainAmount = gasCost * gasPrice;

        // Get XCHAIN/USD and chain/USD prices from latest snapshots
        let xchainPrice = await this.getPrice('XCHAIN/BTC');
        let coinPrice   = await this.getPrice(chain + '/USD');

        let result = {
            action:       action,
            chain:        chain,
            gasCost:      gasCost,
            gasPrice:     gasPrice.toFixed(8),
            xchainAmount: xchainAmount.toFixed(8)
        };

        // If we have oracle prices, compute the native coin amount
        if (coinPrice && coinPrice.price) {
            let coinUsd = parseFloat(coinPrice.price);
            if (coinUsd > 0) {
                // For now, use a simple XCHAIN = $1 placeholder until XCHAIN/USD oracle is live
                let xchainUsd = 1.0;
                let feeUsd = xchainAmount * xchainUsd;
                let nativeCoinAmount = feeUsd / coinUsd;

                result.xchainUsd        = xchainUsd.toFixed(8);
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
    async startCapabilities(configFilePath){
        this.capabilityRegistry = new CapabilityRegistry(this);

        // Subscribe to peer capability messages (only meaningful if P2P is active)
        if(this.peerManager){
            this.peerManager.on('capability', (envelope) => {
                this._handleCapabilityMessage(envelope).catch(e => {
                    console.error('Capability message handler error:', e && e.message ? e.message : e);
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
                    console.error('Capability re-check failed:', e && e.message ? e.message : e);
                });
            }, intervalMs);

            // Watch config file for hot-reload (optional)
            if(configFilePath && fs.existsSync(configFilePath)){
                try {
                    this._capabilityConfigWatcher = fs.watch(configFilePath, { persistent: false }, () => {
                        // Debounce: fs.watch fires multiple times per change
                        if(this._capabilityConfigDebounce) clearTimeout(this._capabilityConfigDebounce);
                        this._capabilityConfigDebounce = setTimeout(() => {
                            this._runOwnCapabilityCheck(pubkey).catch(e => {
                                console.error('Capability config-watch re-check failed:', e && e.message ? e.message : e);
                            });
                        }, 500);
                    });
                    console.log('Capability config watcher attached to ' + configFilePath);
                } catch(e){
                    console.warn('Could not attach capability config watcher to ' + configFilePath + ': ' + e.message);
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
                    console.error('Initial stake poll failed:', e && e.message ? e.message : e);
                });
                let stakePollMs = (this.p2pConfig && this.p2pConfig.STAKE_POLL_MS) ? this.p2pConfig.STAKE_POLL_MS : 60000;
                this._stakePollTimer = setInterval(() => {
                    this._pollOwnStake(pubkey).catch(e => {
                        console.error('Stake poll failed:', e && e.message ? e.message : e);
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
        let res = await axios.post(url, body, { timeout: 5000 });
        let result = res && res.data && res.data.result;
        if(!result || result.error){
            // Indexer either not ready or returned a structured error. Don't change state.
            return;
        }
        await this.refreshOwnQualification(result.amount, result.block_index);
    }

    // Resolve the latest BTC block index. Priority:
    //   1. hub.db.getChainTip('BTC') — populated by indexer pushChainTip
    //      when the indexer is configured with HUB_API_URL.
    //   2. Direct getlatestblock JSON-RPC call to the BTC indexer — covers
    //      stacks where the chain-tip-push isn't wired (e.g. local regtest
    //      development) so block-boundary snapshotting Just Works.
    // Returns null when both paths fail.
    async _resolveBtcLatestBlock(){
        try {
            let tip = await this.db.getChainTip('BTC');
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
            return Number(result.block_index) || null;
        } catch (_) {
            return null;
        }
    }

    // Resolve the BTC indexer JSON-RPC URL. Priority:
    //   1. BTC_INDEXER_API_URL env var (explicit operator override)
    //   2. Hub's own configs table (populated by xchain-node's updateconfig push)
    // Returns null when neither yields a usable URL.
    async _resolveBtcIndexerUrl(){
        if(process.env.BTC_INDEXER_API_URL) return process.env.BTC_INDEXER_API_URL;
        if(!this.db) return null;
        let configs;
        try { configs = await this.db.getAllConfigs(); }
        catch { return null; }
        let btc = configs && configs['bitcoin'];
        if(!btc) return null;
        // Prefer regtest > testnet > mainnet so dev loops Just Work. Production
        // deployments should set BTC_INDEXER_API_URL explicitly.
        for(let net of ['regtest', 'testnet', 'mainnet']){
            let netConfig = btc[net];
            if(!netConfig) continue;
            // xchain-node's updateconfig push uses nested {host, port, ...} under the module key
            let nested = netConfig['xchain-indexer'];
            let host = (nested && nested['host']) || netConfig['INDEXER_HOST'];
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
        for(let cap of this.capabilityRegistry.getCapabilities()){
            let minStake = this.capabilityRegistry.getMinStake(cap) || '0';
            let qualified = this._compareDecimal(amount, minStake) >= 0;
            await this.capabilityRegistry.setQualification(pubkey, cap, qualified, blockIndex);
        }
        await this._broadcastOwnCapabilityState(pubkey);
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
            // Peer claims activation. We accept their self-test claim and their qualification claim
            // (the on-chain stake amount could be independently verified via indexer query — Phase 0+
            // defers that. Slashing-for-failure is the deterrent against false activation claims.)
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, true, null);
            await this.capabilityRegistry.setQualification(data.pubkey, data.capability, true, data.block_at || null);
            await this.capabilityRegistry.setEnabled(data.pubkey, data.capability, true);
        } else if(envelope.type === 'CAPABILITY_DEACTIVATED'){
            // Peer reports deactivation. Mark self_test as failed with reason so we route away.
            await this.capabilityRegistry.setSelfTestResult(data.pubkey, data.capability, false, data.reason || 'peer reported deactivation');
        }
    }

    // Decimal comparison via parseFloat. Stake amounts are bounded well within the
    // safe integer range for typical staking magnitudes (XCHAIN with 8 decimals).
    _compareDecimal(a, b){
        let aNum = parseFloat(a);
        let bNum = parseFloat(b);
        if(isNaN(aNum) || isNaN(bNum)) return 0;
        if(aNum < bNum) return -1;
        if(aNum > bNum) return 1;
        return 0;
    }

    async close(){
        if(this._capabilityRecheckTimer){ clearInterval(this._capabilityRecheckTimer); this._capabilityRecheckTimer = null; }
        if(this._capabilityConfigDebounce){ clearTimeout(this._capabilityConfigDebounce); this._capabilityConfigDebounce = null; }
        if(this._capabilityConfigWatcher){ try { this._capabilityConfigWatcher.close(); } catch(e){} this._capabilityConfigWatcher = null; }
        if(this.governance)       await this.governance.stop();
        if(this.reorgHandler)     await this.reorgHandler.stop();
        if(this.crossChain)       await this.crossChain.stop();
        if(this.oracle)           await this.oracle.stop();
        if(this.oracleConsensus)  await this.oracleConsensus.stop();
        if(this.consensus)        await this.consensus.stop();
        if(this.peerManager)      await this.peerManager.stop();
        if(this.db)               await this.db.close();
    }
}

module.exports = XChainHub;
