'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const express           = require('express');
const helmet            = require('helmet');
const cors              = require('cors');
const jsonRouter        = require('express-json-rpc-router');
const XChainHub         = require('../../../src/XChainHub');
const ValidatorIdentity = require('../../../src/ValidatorIdentity');
const testDb            = require('../../helpers/testDb');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_NAME = process.env.TEST_DB_NAME || 'xchain_hub_test';
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';

const ALLOWED_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);
function validateChain(chain) {
    if (!ALLOWED_CHAINS.has(chain))
        return { error: 'chain must be one of: BTC, LTC, DOGE' };
    return null;
}

/**
 * Build the JSON-RPC controller for a hub instance.
 * Mirrors the controller in src/api.js.
 */
function buildController(hub) {
    return {
        async ping() { return { status: 'success' }; },

        async getallconfigs() {
            try { return { configs: await hub.getAllConfigs(), seq: await hub.getLastSeq() }; }
            catch (err) { return { error: 'error getting configs' }; }
        },

        async updateconfig({ config }) {
            try { await hub.addParametersFromJson(config); return { status: 'success' }; }
            catch (err) { return { error: err.message || 'error updating config' }; }
        },

        async getoraclesubmissions() {
            let oracle = hub.getOracle();
            // Mirrors src/api.js: an absent oracle ROLE is {active:false}, never an error.
            if (!oracle) return { active: false };
            return { active: true, ...(await oracle.getSubmissionsInfo()) };
        },

        async getpricesnapshots({ limit }) {
            try { return await hub.getPriceSnapshots(limit || 50); }
            catch (err) { return { error: 'error fetching snapshots' }; }
        },

        async getprice({ coin_pair }) {
            if (!coin_pair) return { error: 'coin_pair is required' };
            try {
                let price = await hub.getPrice(coin_pair);
                return price || { error: 'no price data for ' + coin_pair };
            } catch (err) { return { error: 'error fetching price' }; }
        },

        async registervalidator({ signing_pubkey, addr }) {
            try { await hub.registerValidator(signing_pubkey, addr); return { status: 'success' }; }
            catch (err) { return { error: err.message || 'error registering validator' }; }
        },

        async syncvalidators({ validators }) {
            try { await hub.syncValidators(validators); return { status: 'success' }; }
            catch (err) { return { error: err.message || 'error syncing validators' }; }
        },

        async getvalidators() {
            try { return await hub.getValidators(); }
            catch (err) { return { error: 'error fetching validators' }; }
        },

        async getvalidatorstatus({ signing_pubkey }) {
            if (!signing_pubkey) return { error: 'signing_pubkey is required' };
            try {
                let status = await hub.getValidatorStatus(signing_pubkey);
                return status || { error: 'validator not found' };
            } catch (err) { return { error: 'error fetching validator status' }; }
        },

        async getfeequote({ action, chain }) {
            if (!action) return { error: 'action is required' };
            if (!chain) return { error: 'chain is required' };
            let chainErr = validateChain(chain);
            if (chainErr) return chainErr;
            try { return await hub.getFeeQuote(action, chain); }
            catch (err) { return { error: 'error calculating fee quote' }; }
        },

        async pushxcallreorg({ source_chain, from_action_index, to_action_index, retraction_generation }) {
            if (!source_chain) return { error: 'source_chain is required' };
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if (from_action_index === undefined || from_action_index === null)
                return { error: 'from_action_index is required' };
            if (!hub.crossChainCalls) return { error: 'cross-chain call engine not active' };
            try {
                await hub.crossChainCalls.retractCallsForReorg(source_chain, from_action_index, to_action_index, retraction_generation);
                return { status: 'ok', source_chain, from_action_index };
            } catch (err) { return { error: err.message || 'error retracting cross-chain calls' }; }
        },

        async pushdexreorg({ source_chain, from_action_index, to_action_index, retraction_generation }) {
            if (!source_chain) return { error: 'source_chain is required' };
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if (from_action_index === undefined || from_action_index === null)
                return { error: 'from_action_index is required' };
            if (!hub.crossChainDex) return { error: 'cross-chain dex engine not active' };
            try {
                await hub.crossChainDex.retractMatchesForReorg(source_chain, from_action_index, to_action_index, retraction_generation);
                return { status: 'ok', source_chain, from_action_index };
            } catch (err) { return { error: err.message || 'error retracting cross-chain matches' }; }
        },

        async propose({ parameter, current_value, proposed_value, rationale }) {
            if (!parameter || !proposed_value) return { error: 'parameter and proposed_value are required' };
            try { return await hub.propose(parameter, current_value || '', proposed_value, rationale); }
            catch (err) { return { error: err.message || 'error creating proposal' }; }
        },

        async vote({ proposal_id, vote }) {
            if (!proposal_id || !vote) return { error: 'proposal_id and vote are required' };
            try { return await hub.vote(proposal_id, vote); }
            catch (err) { return { error: err.message || 'error casting vote' }; }
        },

        async getproposals({ status }) {
            try { return await hub.getProposals(status); }
            catch (err) { return { error: 'error fetching proposals' }; }
        },

        async getproposal({ proposal_id }) {
            if (!proposal_id) return { error: 'proposal_id is required' };
            try {
                let result = await hub.getProposal(proposal_id);
                return result || { error: 'proposal not found' };
            } catch (err) { return { error: 'error fetching proposal' }; }
        },

        async requestattestation({ source_chain, source_action_index, dest_chain }) {
            if (!source_chain || !source_action_index || !dest_chain)
                return { error: 'source_chain, source_action_index, and dest_chain are required' };
            try { return await hub.requestAttestation(source_chain, source_action_index, dest_chain); }
            catch (err) { return { error: err.message || 'error requesting attestation' }; }
        },

        async getattestations({ status, limit }) {
            try {
                let cc = hub.getCrossChain();
                if (!cc) return { error: 'cross-chain engine not active' };
                return await cc.getAttestations(status, limit);
            } catch (err) { return { error: 'error fetching attestations' }; }
        },

        async getattestation({ source_chain, source_action_index }) {
            if (!source_chain || !source_action_index)
                return { error: 'source_chain and source_action_index are required' };
            try {
                let cc = hub.getCrossChain();
                if (!cc) return { error: 'cross-chain engine not active' };
                let att = await cc.getAttestation(source_chain, source_action_index);
                return att || { error: 'attestation not found' };
            } catch (err) { return { error: 'error fetching attestation' }; }
        },

        async reportreorg({ chain, reorg_height, timestamp, old_hash, new_hash }) {
            if (!chain || !reorg_height || !timestamp)
                return { error: 'chain, reorg_height, and timestamp are required' };
            try {
                await hub.reportReorg(chain, parseInt(reorg_height), parseInt(timestamp),
                    old_hash ? String(old_hash) : old_hash, new_hash ? String(new_hash) : new_hash);
                return { status: 'success' };
            } catch (err) { return { error: err.message || 'error reporting reorg' }; }
        },

        async getreorghistory({ limit }) {
            try { return await hub.getReorgHistory(limit); }
            catch (err) { return { error: 'error fetching reorg history' }; }
        },

        async initiateswap({ source_chain, source_action_index, dest_chain, dest_action_index }) {
            if (!source_chain || !source_action_index || !dest_chain)
                return { error: 'source_chain, source_action_index, and dest_chain are required' };
            try {
                await hub.initiateSwap(source_chain, parseInt(source_action_index), dest_chain, dest_action_index ? parseInt(dest_action_index) : null);
                return { status: 'success' };
            } catch (err) { return { error: err.message || 'error initiating swap' }; }
        },

        async getswap({ source_chain, source_action_index }) {
            if (!source_chain || !source_action_index)
                return { error: 'source_chain and source_action_index are required' };
            try {
                let swap = await hub.getSwap(source_chain, parseInt(source_action_index));
                return swap || { error: 'swap not found' };
            } catch (err) { return { error: 'error fetching swap' }; }
        },

        async getswaps({ status, limit }) {
            try { return await hub.getSwaps(status, limit); }
            catch (err) { return { error: 'error fetching swaps' }; }
        }
    };
}

/**
 * Create and manage a multi-hub cluster for E2E testing.
 *
 * @param {number} nodeCount - Number of hub instances (1-4)
 * @param {object} overrides - Per-node config overrides
 * @returns {object} Cluster control object
 */
// Counter for unique port allocation across cluster instances
// Use high random base to avoid conflicts; never reuse within a test run
let portCounter = 30000 + Math.floor(Math.random() * 5000);
function nextPort() {
    portCounter++;
    if (portCounter > 50000) portCounter = 30001;
    return portCounter;
}

function createCluster(nodeCount, overrides) {
    nodeCount = nodeCount || 1;
    overrides = overrides || {};

    let nodes   = [];  // { hub, server, apiPort, p2pPort, keypair, addr }
    let started = false;
    // OracleConsensus reads ORACLE_MIN_SUBMISSIONS from process.env at
    // construction with a 2-hub diversity floor; a single-node cluster must
    // set 1 (the same explicit opt-in real single-host deployments use) or
    // every finalization skips. Saved/restored around the cluster lifetime.
    let savedMinSubmissions;

    // R2-C2 stub indexer: every hub verifies a reported reorg against its
    // "own" indexer (getblockhashes) before co-signing, so the cluster serves
    // one shared JSON-RPC stub whose tip/hashes tests can set via
    // cluster.stubIndexer (hashes: { [height]: hash }). CrossChainEngine
    // followers likewise verify a proposed source action via
    // getactionconfirmations before PREPARing; `actions` overrides the
    // default confirmed response per action_index.
    let stubIndexer = { tip: 800100, network: 'regtest', hashes: {}, actions: {} };
    let stubIndexerServer = null;
    let stubIndexerUrl = '';
    function stubHashFor(height) {
        return require('crypto').createHash('sha256').update('stub-block-' + height).digest('hex');
    }

    // Generate deterministic keypairs for each node
    let keypairs = [];
    for (let i = 0; i < nodeCount; i++) {
        keypairs.push(ValidatorIdentity.generate());
    }

    return {
        stubIndexer,

        /**
         * Start the cluster: create hubs, P2P mesh, register validators, start Express servers.
         */
        async start() {
            if (started) return;

            if (nodeCount === 1) {
                savedMinSubmissions = process.env.ORACLE_MIN_SUBMISSIONS;
                process.env.ORACLE_MIN_SUBMISSIONS = '1';
            }

            // Phase 0: start the shared stub indexer (see stubIndexer above).
            let stubApp = express();
            stubApp.use(express.json());
            stubApp.post('/', (req, res) => {
                let { method, params, id } = req.body || {};
                if (method === 'getblockhashes') {
                    let height = params && params.block_index != null ? Number(params.block_index) : stubIndexer.tip;
                    return res.json({ jsonrpc: '2.0', id, result: {
                        block_index: height,
                        block_hash:  stubIndexer.hashes[height] || stubHashFor(height),
                        network:     stubIndexer.network
                    } });
                }
                if (method === 'getactionconfirmations') {
                    let idx = params && params.action_index != null ? Number(params.action_index) : 0;
                    return res.json({ jsonrpc: '2.0', id,
                        result: stubIndexer.actions[idx] || { exists: true, confirmations: 100 } });
                }
                res.json({ jsonrpc: '2.0', id, error: { message: 'unknown method ' + method } });
            });
            await new Promise((resolve) => {
                stubIndexerServer = stubApp.listen(0, '127.0.0.1', () => {
                    stubIndexerUrl = 'http://127.0.0.1:' + stubIndexerServer.address().port;
                    resolve();
                });
            });

            // Pre-allocate unique P2P ports for all nodes
            // (P2P_PORT: 0 is treated as falsy by PeerManager's || operator)
            let p2pPorts = [];
            for (let i = 0; i < nodeCount; i++) {
                p2pPorts.push(nextPort());
            }

            // Phase 1: Create and start hubs with unique P2P ports
            for (let i = 0; i < nodeCount; i++) {
                let baseConfig = {
                    P2P_PORT:                 p2pPorts[i],
                    P2P_HOST:                 '127.0.0.1',
                    P2P_VALIDATOR_ADDR:       'ws://validator-' + i + ':' + p2pPorts[i],
                    SIGNING_PRIVKEY_HEX:      keypairs[i].privkeyHex,
                    REQUIRE_SIGNATURES:       false,
                    SEED_NODES:               [],
                    P2P_HEARTBEAT_INTERVAL:   600000,  // Disable heartbeat in tests
                    P2P_RECONNECT_BASE:       nodeCount > 1 ? 500 : 60000,
                    P2P_RECONNECT_MAX:        nodeCount > 1 ? 2000 : 60000,
                    P2P_MSG_DEDUP_TTL:        60000,
                    P2P_MAX_PAYLOAD:          1048576,
                    ORACLE_EPOCH_START:       1704067200000, // 2024-01-01 UTC, shared across all test hubs
                    ORACLE_ROUND_INTERVAL:    999999999,  // Prevent auto-rounds
                    ORACLE_SUBMISSION_WINDOW:  2000,
                    ORACLE_REWARD_PER_ROUND:  overrides.ORACLE_REWARD_PER_ROUND || '10.00000000',
                    SLASH_DEVIATION_THRESHOLD:  overrides.SLASH_DEVIATION_THRESHOLD || '0.05',
                    SLASH_MISSED_ROUNDS_THRESHOLD: overrides.SLASH_MISSED_ROUNDS_THRESHOLD || '30',
                    COINGECKO_API_KEY:        '',
                    COINMARKETCAP_API_KEY:    overrides.COINMARKETCAP_API_KEY || '',
                    PRICE_FETCH_TIMEOUT:      5000,
                    // Providers are nock-mocked in tests; the NAT-herd jitter sleep
                    // (0-3s per source) only distorts timing assertions here.
                    PRICE_FETCH_JITTER_MS:    (overrides.PRICE_FETCH_JITTER_MS != null) ? overrides.PRICE_FETCH_JITTER_MS : 0,
                    BTC_INDEXER_URL:          stubIndexerUrl,
                    LTC_INDEXER_URL:          stubIndexerUrl,
                    DOGE_INDEXER_URL:         stubIndexerUrl,
                    ...(overrides['node' + i] || {})
                };

                let p2pConfig = baseConfig;

                let hub = new XChainHub(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, p2pConfig);
                await hub.start();

                nodes.push({
                    hub:      hub,
                    server:   null,
                    apiPort:  null,
                    p2pPort:  p2pPorts[i],
                    keypair:  keypairs[i],
                    addr:     baseConfig.P2P_VALIDATOR_ADDR
                });
            }

            // Phase 2: Start P2P on all nodes
            for (let i = 0; i < nodeCount; i++) {
                await nodes[i].hub.startP2P();
                nodes[i].p2pPort = p2pPorts[i];
            }

            // Phase 3: For multi-node, connect peers manually
            if (nodeCount > 1) {
                for (let i = 0; i < nodeCount; i++) {
                    let pm = nodes[i].hub.getPeerManager();
                    if (!pm) continue;
                    for (let j = 0; j < nodeCount; j++) {
                        if (i === j) continue;
                        pm._connectToPeer('127.0.0.1:' + nodes[j].p2pPort);
                    }
                }
                // Wait for connections to establish: poll actual peer
                // WebSocket readiness instead of a fixed sleep, so setup
                // proceeds as soon as the mesh is up. Best-effort: if the
                // poll times out we still proceed, preserving the prior
                // non-fatal behavior (WebSocket.OPEN === 1).
                await (async () => {
                    let elapsed = 0, delay = 25, timeout = 3000;
                    let meshReady = () => nodes.every(n => {
                        let pm = n.hub.getPeerManager();
                        if (!pm || !pm.peers) return false;
                        let open = 0;
                        for (let [, peer] of pm.peers)
                            if (peer.ws && peer.ws.readyState === 1) open++;
                        return open >= (nodeCount - 1);
                    });
                    while (elapsed < timeout) {
                        if (meshReady()) return;
                        await new Promise(r => setTimeout(r, delay));
                        elapsed += delay;
                        delay = Math.min(delay * 2, 250);
                    }
                })();
            }

            // Phase 4: Register validators in the shared DB (once is enough since shared DB)
            for (let i = 0; i < nodeCount; i++) {
                await nodes[0].hub.registerValidator(keypairs[i].pubkeyHex, nodes[i].addr);
            }

            // (No schema patching here: reorg_attestations.updated_at is declared in
            // src/sql/reorg_attestations.sql. The hand-run ALTER that used to sit at
            // this point hid a real product/schema mismatch from every tier except
            // the integration one, which had no such workaround and went red.)

            // Phase 5: Start subsystems
            for (let i = 0; i < nodeCount; i++) {
                await nodes[i].hub.startConsensus();
                await nodes[i].hub.startOracle();
                await nodes[i].hub.startCrossChain();
                await nodes[i].hub.startReorgHandler();
                await nodes[i].hub.startGovernance();
            }

            // Phase 6: Start Express API servers on random ports
            for (let i = 0; i < nodeCount; i++) {
                let app = express();
                app.use(helmet());
                app.use(express.json());
                app.use(cors());
                app.use(jsonRouter({ methods: buildController(nodes[i].hub) }));

                await new Promise((resolve) => {
                    let server = app.listen(0, '127.0.0.1', () => {
                        nodes[i].server  = server;
                        nodes[i].apiPort = server.address().port;
                        resolve();
                    });
                });
            }

            started = true;
        },

        /**
         * Stop all hub instances and HTTP servers.
         * Uses timeouts to avoid hanging on stubborn WebSocket connections.
         */
        async stop() {
            if (nodeCount === 1) {
                if (savedMinSubmissions === undefined) delete process.env.ORACLE_MIN_SUBMISSIONS;
                else process.env.ORACLE_MIN_SUBMISSIONS = savedMinSubmissions;
            }
            if (stubIndexerServer) {
                try { await new Promise(r => { stubIndexerServer.close(r); setTimeout(r, 1000); }); } catch (e) { /* ignore */ }
                stubIndexerServer = null;
            }
            for (let node of nodes) {
                try {
                    if (node.server) {
                        await new Promise(r => { node.server.close(r); setTimeout(r, 2000); });
                        node.server = null;
                    }
                } catch (e) { /* ignore */ }
                try {
                    if (node.hub) {
                        await Promise.race([
                            node.hub.close(),
                            new Promise(r => setTimeout(r, 5000))
                        ]);
                    }
                } catch (e) { /* ignore */ }
            }
            nodes = [];
            started = false;
        },

        /**
         * Get info about a specific node.
         */
        getNode(index) {
            return nodes[index] || null;
        },

        /**
         * Get the hub instance for a node.
         */
        getHub(index) {
            return nodes[index] ? nodes[index].hub : null;
        },

        /**
         * Get the API port for a node.
         */
        getPort(index) {
            return nodes[index] ? nodes[index].apiPort : null;
        },

        /**
         * Get the keypair for a node.
         */
        getKeypair(index) {
            return keypairs[index] || null;
        },

        /**
         * Get the validator addr for a node.
         */
        getAddr(index) {
            return nodes[index] ? nodes[index].addr : null;
        },

        /**
         * Get all API ports.
         */
        getPorts() {
            return nodes.map(n => n.apiPort);
        },

        /**
         * Get the shared database instance.
         */
        getDb() {
            return nodes[0] ? nodes[0].hub.db : null;
        },

        /**
         * Trigger an oracle round on a specific node (bypasses auto-timer).
         */
        async triggerOracleRound(index) {
            let hub = nodes[index] ? nodes[index].hub : null;
            if (!hub || !hub.oracle) throw new Error('No oracle on node ' + index);
            await hub.oracle._executeRound();
        },

        /**
         * Trigger oracle rounds on all nodes simultaneously.
         */
        async triggerAllOracleRounds() {
            let promises = [];
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].hub && nodes[i].hub.oracle) {
                    promises.push(nodes[i].hub.oracle._executeRound());
                }
            }
            await Promise.all(promises);
        },

        /**
         * Manually trigger oracle finalization on a node.
         */
        async triggerOracleFinalization(index, round) {
            let hub = nodes[index] ? nodes[index].hub : null;
            if (!hub || !hub.oracleConsensus) throw new Error('No oracle consensus on node ' + index);
            await hub.oracleConsensus.finalizeRound(round);
        },

        /**
         * Force governance tally check on a node.
         */
        async triggerGovernanceTally(index) {
            let hub = nodes[index] ? nodes[index].hub : null;
            if (!hub || !hub.governance) throw new Error('No governance on node ' + index);
            await hub.governance._checkExpiredProposals();
        },

        /** Number of nodes in the cluster */
        get nodeCount() { return nodes.length; }
    };
}

module.exports = { createCluster };
