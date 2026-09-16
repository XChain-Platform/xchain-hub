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
 * XChain Hub - Attestation Provider Registry
 *
 * Hub-authoritative registry of governance-approved attestation providers.
 * Loaded from the `configs` table under module='ATTESTATION_PROVIDER'; each
 * row is a JSON-encoded provider definition (spec §6) keyed by provider_id.
 *
 * Falls back to a built-in DEFAULTS map (currently { http_get }) so a freshly
 * deployed hub works without any prior governance proposal. Governance writes
 * to the configs table override the defaults; hotReload() picks them up
 * without a hub restart.
 *
 ********************************************************************/

const path = require('path');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

// The built-in provider definitions and their canonicalisers live in
// provider_registry/defaults.js; the block-anchored config history methods live in
// provider_registry/config_history.js and are installed on the prototype below.
const { DEFAULTS, parseAttestationProviderParam, normalizeMinStakeXchain } = require('./provider_registry/defaults.js');
const configHistoryMethods = require('./provider_registry/config_history.js');

// Group configs rows by provider_id, skipping any row that carries no id or no value.
function groupRowsByProvider(rows) {
    let byProvider = new Map();
    for (let row of (rows || [])) {
        let providerId = row && row.param_name;
        if (!providerId || !row.param_value) continue;
        if (!byProvider.has(providerId)) byProvider.set(providerId, []);
        byProvider.get(providerId).push(row);
    }
    return byProvider;
}

class ProviderRegistry {

    constructor(hub){
        this.hub = hub;
        this.db  = hub.db;

        // Loaded provider definitions: providerId -> def object
        this.providers = new Map();

        // Lazy-loaded provider modules: providerId -> the module at src/providers/<id>.js
        this.modules = new Map();

        // Block-anchored provider-config history: providerId -> array of
        // { activation_block, additional_config, min_stake_xchain } ordered ascending by
        // activation_block. Seeded from the static DEFAULTS as a genesis entry
        // (activation_block 0), then APPENDED (never overwritten) when a governance
        // ATTESTATION_PROVIDER change finalizes, each entry carrying the
        // proposer-declared activation_block. Resolving the model identity for a
        // request's block (getAdditionalConfig(providerId, blockIndex)) is then a
        // deterministic function of block height, identical on every hub regardless
        // of when each one applied the change. This is what makes the LLM fetch/judge
        // model federation-deterministic (mirror of CapabilityRegistry.minStakeHistory).
        //
        // The same entries also anchor min_stake_xchain, the PROVIDER stake floor:
        // a higher, per-provider bar layered on top of the capability-wide
        // MIN_STAKE (serving an `llm` attestation costs more stake than an `http_get`
        // one). It is anchored for exactly the reason additional_config is: any
        // responsible-set or serve decision keyed on a LIVE, non-anchored value would
        // let two hubs whose governance change finalized at different wall-clock
        // moments resolve different floors for the same request block, and disagree on
        // who may serve it. A given entry carries min_stake_xchain: null when its
        // governance change did not touch the floor, so resolution walks back to the
        // last entry that did (see getMinStake).
        //
        // consensus_strategy rides the same entry, for a stronger version of the same
        // reason. It is not a parameter of the outcome, it SELECTS the PBFT state
        // machine: judge_model runs leader-only agree() with follower PREPARE-adoption,
        // byte_equality runs every-hub-agrees with first-verified-PREPARE-wins. Read
        // live off `this.providers` it was the one round-shaping field that could differ
        // between two hubs mid-round, because load() re-parses every provider def out of
        // the local configs table and hotReload() re-runs load() on EVERY
        // proposal:finalized event whatever that proposal was about, so no
        // governance-side validation could reach it. Anchored here, two hubs resolve the
        // same strategy for the same request block however their local reloads raced.
        // Same null-is-transparent walk-back as min_stake_xchain (getConsensusStrategy).
        this.providerConfigHistory = new Map();

        // Pre-seed with defaults so even a fresh deploy is operational
        for (let [id, def] of Object.entries(DEFAULTS)) {
            this.providers.set(id, def);
        }
    }

    // Pull provider defs from the configs table and overlay onto defaults.
    // Each configs row under (coin, network, 'ATTESTATION_PROVIDER', <provider_id>)
    // has a JSON-encoded definition as its param_value. The read is coin-agnostic:
    // a hub federates several chains and carries no coin, and a provider definition
    // is one document per provider_id (framework spec §6), not one per chain. Read
    // by the hub's OWN fields: XChainHub sets no `config.COIN/NETWORK`, so a
    // namespace resolved from there matches nothing on a real hub.
    async load(){
        // Re-seed defaults so a removed governance row reverts to default,
        // not stays as the last-known state.
        this.providers.clear();
        for (let [id, def] of Object.entries(DEFAULTS)) {
            this.providers.set(id, def);
        }

        if (!this.db) return;
        // XChainHub derives this from p2pConfig.HUB_NETWORK and leaves it '' in
        // standalone mode. Read both, because a hub-shaped stub may carry only one.
        let net = this.hub.network
            || (this.hub.p2pConfig && this.hub.p2pConfig.HUB_NETWORK)
            || '';
        if (!net) {
            // Say it once. An operator who registered a provider row and got built-in
            // defaults anyway has no other way to see why: the read is skipped, not failed.
            if (!this._warnedNoNetwork) {
                this._warnedNoNetwork = true;
                logger.warn('ProviderRegistry: hub has no network (standalone); '
                    + 'ATTESTATION_PROVIDER rows are not read and built-in defaults apply');
            }
            return;
        }

        try {
            let rows = await this.db.getConfigRowsByModule(net, 'ATTESTATION_PROVIDER');
            // Group by provider_id first. The same definition may legitimately be
            // written under several coins; two DIFFERENT definitions under the same
            // provider_id is an ambiguity, and picking one would make two hubs resolve
            // different provider limits from the same table. Refuse that pair instead,
            // on the anchoring rationale in applyProviderGovernanceChange.
            let byProvider = groupRowsByProvider(rows);

            for (let [providerId, group] of byProvider) {
                let distinct = new Set(group.map((r) => String(r.param_value)));
                if (distinct.size > 1) {
                    logger.warn('ProviderRegistry: ATTESTATION_PROVIDER:' + providerId
                        + ' has conflicting definitions under coins '
                        + group.map((r) => r.coin).join(', ')
                        + '; keeping the built-in default rather than resolving the ambiguity');
                    continue;
                }
                let raw = group[0].param_value;
                try {
                    let def = JSON.parse(raw);
                    if (!def.provider_id) def.provider_id = providerId;
                    this.providers.set(providerId, def);
                } catch (e) {
                    logger.warn(nodeUtil.format('ProviderRegistry: bad JSON for ATTESTATION_PROVIDER:' + providerId, e));
                }
            }
        } catch (e) {
            logger.warn(nodeUtil.format('ProviderRegistry: failed to read configs table:', e));
        }
    }

    async hotReload(){
        await this.load();
        // Re-inject updated config into any already-loaded modules so a
        // governance proposal's effect (e.g. new approved_models for llm)
        // doesn't require a hub restart.
        for (let [providerId, mod] of this.modules){
            if (typeof mod._setConfig === 'function'){
                try { mod._setConfig(this.providers.get(providerId)); }
                catch (e) { logger.warn(nodeUtil.format('ProviderRegistry: _setConfig (reload) failed for ' + providerId, e)); }
            }
        }
    }

    isKnown(providerId){
        return this.providers.has(providerId);
    }

    getDef(providerId){
        return this.providers.get(providerId) || null;
    }

    // Lazy-load the provider module (fetch + agree + healthCheck). Returns null
    // if no module exists for the given id (e.g. governance registered a provider
    // whose code isn't deployed on this hub yet; that's an operator config issue).
    //
    // If the module exports a `_setConfig(def)` hook, the loaded def is injected
    // so governance-controlled `additional_config` reaches the module without a
    // hub restart. (LLM uses this for `approved_models`, `judge_model`, etc.)
    getModule(providerId){
        if (!this.providers.has(providerId)) return null;
        if (this.modules.has(providerId)) return this.modules.get(providerId);
        try {
            // The providers stay in src/providers/, one directory above this registry.
            let mod = require(path.join(__dirname, '..', 'providers', providerId + '.js'));
            if (typeof mod._setConfig === 'function'){
                try { mod._setConfig(this.providers.get(providerId)); }
                catch (e) { logger.warn(nodeUtil.format('ProviderRegistry: _setConfig failed for ' + providerId, e)); }
            }
            // Sibling hook for a provider that spends real money OFF-chain (llm bills the
            // operator's own vendor account rather than broadcasting a fee). Hands it this
            // hub's config, and persists its rolling budget across restarts only for a
            // real validator hub - a peerManager is the same "this hub actually serves
            // rounds" test startAttestation() gates on, and it keeps a registry built by a
            // unit test from leaving a spend window in the checkout for the next run.
            if (typeof mod.armSpendGuard === 'function'){
                try { mod.armSpendGuard((this.hub && this.hub.p2pConfig) || {},
                                        !!(this.hub && this.hub.peerManager)); }
                catch (e) { logger.warn(nodeUtil.format('ProviderRegistry: armSpendGuard failed for ' + providerId +
                                         '; its budget still binds this process but resets on restart', e)); }
            }
            this.modules.set(providerId, mod);
            return mod;
        } catch (e) {
            logger.warn(nodeUtil.format('ProviderRegistry: module load failed for ' + providerId, e));
            return null;
        }
    }

    listProviderIds(){
        return [...this.providers.keys()];
    }

    // Widest deadline_window_blocks across the LIVE provider defs, plus the provider
    // that owns it. deadline_window_blocks is governance-controlled JSON read verbatim
    // in load(), so this is the value a caller must re-derive against rather than the
    // 100-block http_get figure baked into any comment (item 3421). Returns
    // { blocks: 0, providerId: null } when no def declares a usable window.
    maxDeadlineWindowBlocks(){
        let blocks = 0, providerId = null;
        for (let [id, def] of this.providers){
            let w = Number(def && def.deadline_window_blocks);
            if (Number.isFinite(w) && w > blocks){ blocks = w; providerId = id; }
        }
        return { blocks, providerId };
    }

    isRedundancyAllowed(providerId, redundancy){
        let p = this.providers.get(providerId);
        if (!p) return false;
        return Array.isArray(p.allowed_redundancy) && p.allowed_redundancy.indexOf(Number(redundancy)) !== -1;
    }

    isPayloadSizeAllowed(providerId, byteLength){
        let p = this.providers.get(providerId);
        if (!p) return false;
        return Number(byteLength) <= Number(p.max_request_bytes);
    }

    isDeadlineAllowed(providerId, currentBlock, deadlineBlock){
        let p = this.providers.get(providerId);
        if (!p) return false;
        let delta = Number(deadlineBlock) - Number(currentBlock);
        return delta > 0 && delta <= Number(p.deadline_window_blocks);
    }
}

// Install each part's methods on the prototype non-enumerably, as src/db/index.js does,
// so a moved method stays indistinguishable from one declared in the class above. A
// name already on the prototype throws rather than one part replacing another's method.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate ProviderRegistry method: ' + name + ' is already on the prototype');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(ProviderRegistry.prototype, [configHistoryMethods]);

module.exports = Object.assign(ProviderRegistry, {
    DEFAULTS,
    parseAttestationProviderParam,
    normalizeMinStakeXchain
});
