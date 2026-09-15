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
 * XChain Hub - Capability Bring-Up
 *
 * The operator capability config and the registry built from it, the
 * self-test re-check and config watch a hub with an identity arms, and the
 * stake poll that keeps its own qualification current.
 *
 ********************************************************************/

const fs = require('fs');
const { axiosFor } = require('./indexer_http.js');
const fullnodeActivation = require('../lib/fullnode_activation.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

// Everything a hub with an identity arms for ITSELF: the first self-test, the
// periodic re-check, the config watch, and the stake poll behind them.
async function armOwnCapabilityChecks(hub, configFilePath) {
    let pubkey = hub.identity.getPubkeyHex();
    await hub.runOwnCapabilityCheck(pubkey);

    let intervalMs = (hub.p2pConfig && hub.p2pConfig.CAPABILITY_RECHECK_MS) ? hub.p2pConfig.CAPABILITY_RECHECK_MS : 60000;
    hub._capabilityRecheckTimer = setInterval(() => {
        hub.runOwnCapabilityCheck(pubkey).catch(e => {
            logger.error(nodeUtil.format('Capability re-check failed:', e));
        });
    }, intervalMs);

    if(configFilePath && fs.existsSync(configFilePath)){
        try {
            hub._capabilityConfigWatcher = fs.watch(configFilePath, { persistent: false }, () => {
                if(hub._capabilityConfigDebounce) clearTimeout(hub._capabilityConfigDebounce);
                hub._capabilityConfigDebounce = setTimeout(() => {
                    // Re-read the file into p2pConfig and the live registry first, so
                    // the self-tests below run against the config just written.
                    try { hub.loadCapabilityConfigFile(configFilePath); }
                    catch(e){ logger.warn(nodeUtil.format('Capability config reload failed: ', e)); }
                    hub.runOwnCapabilityCheck(pubkey).catch(e => {
                        logger.error(nodeUtil.format('Capability config-watch re-check failed:', e));
                    });
                }, 500);
            });
            logger.info('Capability config watcher attached to ' + configFilePath);
        } catch(e){
            logger.warn(nodeUtil.format('Could not attach capability config watcher to ' + configFilePath + ':', e));
        }
    }

    // Poll the BTC indexer for own on-chain stake and feed refreshOwnQualification so
    // qualification tracks STAKE/UNSTAKE without manual intervention. URL from env
    // first, then the hub's own configs table (populated by xchain-node); no timer is
    // attached when no URL resolves.
    let initialUrl = await hub.resolveBtcIndexerUrl();
    if(initialUrl){
        hub.pollOwnStake(pubkey).catch(e => {
            logger.error(nodeUtil.format('Initial stake poll failed:', e));
        });
        let stakePollMs = (hub.p2pConfig && hub.p2pConfig.STAKE_POLL_MS) ? hub.p2pConfig.STAKE_POLL_MS : 60000;
        hub._stakePollTimer = setInterval(() => {
            hub.pollOwnStake(pubkey).catch(e => {
                logger.error(nodeUtil.format('Stake poll failed:', e));
            });
        }, stakePollMs);
        logger.info('Stake-amount poll attached to ' + initialUrl + ' (every ' + stakePollMs + 'ms)');
    } else {
        logger.info('Stake-amount poll disabled (no BTC indexer URL: set BTC_INDEXER_API_URL or push via updateconfig)');
    }
}

// The genesis MIN_STAKE per capability, so an operator can check it against the
// indexer's frozen constants.
function logGenesisMinStakes(hub) {
    // Surface the genesis MIN_STAKE per capability so an operator can check it against
    // the indexer's frozen configs/<COIN>.js constants. Governance MIN_STAKE changes are
    // disabled pre-launch, so these genesis values are the thresholds the hub locks
    // quorum against for every block, and a mismatch with the indexer would fork.
    try {
        let genesis = hub.capabilityRegistry.getCapabilities()
            .map(cap => cap + '=' + String(hub.capabilityRegistry.getMinStake(cap)))
            .join(', ');
        logger.info('Capability MIN_STAKE (genesis, pinned #4352): ' + genesis +
            ' (must equal the indexer configs/<COIN>.js constants)');
    } catch (e) { /* best-effort operator log */ }
}

class Capabilities {

    // Merge the capability config JSON into p2pConfig so the self-test modules and
    // CapabilityRegistry see operator MIN_STAKE thresholds and per-capability blocks.
    // Used at startup and on hot-reload; throws on read/parse errors.
    loadCapabilityConfigFile(configFilePath){
        let parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
        if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('capability config must be a JSON object');
        // Validate BEFORE merging so a divergent file is refused whole and a hot-reload
        // leaves the running hub on its previous validated config.
        if('CAPABILITIES' in parsed) this.assertCanonicalMinStakes(parsed.CAPABILITIES);
        // Same for a FULLNODE override: its consensus knobs must come from the pinned
        // coin bundle every service ships, or this hub runs a challenge schedule and
        // reward split its peers reject.
        this.assertCanonicalFullnode(parsed.FULLNODE || parsed.full_node);
        if(!this.p2pConfig) this.p2pConfig = {};
        const KEYS = ['CAPABILITIES', 'DISABLED_CAPABILITIES', 'price', 'cross_chain',
                      'oracle_publish', 'attestation', 'CAPABILITY_RECHECK_MS', 'STAKE_POLL_MS',
                      'FULLNODE', 'full_node'];
        for(let k of KEYS){
            if(k in parsed) this.p2pConfig[k] = parsed[k];
        }
        // Consumers read cfg.FULLNODE.BTC_RPC; accept the README's 'full_node' spelling as
        // an alias so the documented HUB_CAPABILITY_CONFIG override reaches selfTest
        // instead of being dropped by the whitelist.
        if(this.p2pConfig.full_node && !this.p2pConfig.FULLNODE){
            this.p2pConfig.FULLNODE = this.p2pConfig.full_node;
        }
        this.seedCanonicalFullnode();
        // Keep a live registry's view in sync so hot-reload applies without a restart.
        if(this.capabilityRegistry){
            this.capabilityRegistry.capConfig = this.p2pConfig.CAPABILITIES || {};
            // Re-seed the block-0 genesis threshold; appended activations are preserved.
            this.capabilityRegistry.seedGenesisHistory();
            this.capabilityRegistry.disabled  = new Set(this.p2pConfig.DISABLED_CAPABILITIES || []);
        }
        logger.info('Loaded capability config from ' + configFilePath +
            ' (thresholds: ' + Object.keys(this.p2pConfig.CAPABILITIES || {}).join(', ') + ')');
    }

    async startCapabilities(configFilePath){
        const { CapabilityRegistry, StakeShareWatcher } = this.constructor.modules;
        // Load the operator capability config (MIN_STAKE thresholds plus the per-capability
        // self-test blocks) BEFORE constructing the registry, which snapshots
        // p2pConfig.CAPABILITIES at construction time. Without it the self-tests read an
        // empty config and every config-bearing capability fails with "config missing".
        if(configFilePath){
            try {
                this.loadCapabilityConfigFile(configFilePath);
            } catch(e){
                // A canonical MIN_STAKE or FULLNODE mismatch is a consensus-fork
                // misconfig, and an unconfigured capability fails every consensus
                // round for it, so halt boot. Read/parse problems keep the legacy
                // warn-and-degrade path, where self-tests fail "config missing".
                if(e && (e.code === 'MIN_STAKE_MISMATCH' || e.code === 'FULLNODE_CONFIG_MISMATCH' ||
                         e.code === 'CAPABILITY_UNCONFIGURED')) throw e;
                logger.warn(nodeUtil.format('Could not load capability config from ' + configFilePath + ': ', e));
            }
        }
        // Seed even with no operator config file, then report the tier's activation state
        // once at boot so an operator can see whether this hub thinks it is on.
        this.seedCanonicalFullnode();
        logger.info('NODEPROOF full-node tier: ' +
            fullnodeActivation.describeActivation(this.p2pConfig && this.p2pConfig.FULLNODE));
        this.capabilityRegistry = new CapabilityRegistry(this);
        // Rebuild block-anchored MIN_STAKE history from finalized governance proposals so a
        // restarted hub resolves the same per-block thresholds as long-running peers.
        await this.capabilityRegistry.loadGovernanceHistory();

        if(this.peerManager){
            this.peerManager.on('capability', (envelope) => {
                this.handleCapabilityMessage(envelope).catch(e => {
                    logger.error(nodeUtil.format('Capability message handler error:', e));
                });
            });
        }

        if(this.identity) await armOwnCapabilityChecks(this, configFilePath);

        logger.info('Capability registry initialized' + (this.identity ? ' (identity: ' + this.identity.getPubkeyHex().substring(0,16) + '...)' : ' (no identity; peer-receive only)'));

        logGenesisMinStakes(this);

        // Watch our OWN share of active stake against the STAKE_WEIGHTED_QUORUM
        // two-thirds commit gate. Nothing else does: the gate counts
        // community stake in the denominator whether or not it ever signs, so a
        // share that drifts to 2/3 halts every round the moment one more staker
        // appears, and the previous round gives no warning at all (a prior halt was
        // 18 hours of dead price rounds found by a tester). Started here rather
        // than with the stake poll above because it needs no identity: a
        // read-only hub can watch the federation just as well.
        this.stakeShareWatcher = new StakeShareWatcher(this);
        this.stakeShareWatcher.start();
    }

    // In-flight guard: _stakePollTimer fires on a bare setInterval while the pass awaits
    // an unbounded indexer round-trip, so a slow indexer would stack passes. Skipping is
    // safe because the next tick re-reads fresh truth.
    async pollOwnStake(pubkey){
        if(this._stakePollRunning) return;
        this._stakePollRunning = true;
        try {
            await this.pollOwnStakePass(pubkey);
        } finally {
            this._stakePollRunning = false;
        }
    }

    // Query the BTC indexer for own active stake plus latest block, then feed both into
    // refreshOwnQualification. Best-effort: failures are logged and change no state.
    async pollOwnStakePass(pubkey){
        let url = await this.resolveBtcIndexerUrl();
        if(!url) return;
        let body = {
            jsonrpc: '2.0',
            id:      Date.now(),
            method:  'getownstake',
            params:  { pubkey: pubkey }
        };
        let res;
        try {
            res = await axiosFor(this).post(url, body, { headers: this.btcIndexerHeaders(), timeout: 5000 });
        } catch(err) {
            let status = err && err.response && err.response.status;
            if(status === 401 || status === 403){
                // Auth failure is distinct from the indexer being down; name it so the
                // operator fixes the key mismatch instead of chasing a network issue.
                logger.error('_pollOwnStake: HTTP ' + status + ' from BTC indexer at ' + url +
                    ': check that BTC_INDEXER_API_KEY on this hub matches INDEXER_API_KEY on the indexer');
            } else {
                logger.error(nodeUtil.format('Stake poll failed:', err && err.message ? err.message : err));
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
}

module.exports = Capabilities;
