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
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md (§6)
 *
 ********************************************************************/

const DEFAULTS = {
    http_get: {
        provider_id:            'http_get',
        version:                1,
        consensus_strategy:     'byte_equality',
        max_request_bytes:      2048,
        max_response_bytes:     32768,
        allowed_redundancy:     [1, 3, 5],
        min_stake_xchain:       '10000',
        per_call_base_fee_xchain: '0.01',
        deadline_window_blocks: 100,
        additional_config:      {}
    },
    // Spec: claude/reports/specs/2026-05-24_llm-attestation-provider.md §3
    llm: {
        provider_id:            'llm',
        version:                1,
        consensus_strategy:     'judge_model',
        max_request_bytes:      8192,
        max_response_bytes:     16384,
        allowed_redundancy:     [1, 3, 5],
        min_stake_xchain:       '25000',
        per_call_base_fee_xchain: '0.50',
        deadline_window_blocks: 20,
        additional_config: {
            approved_models: [
                'claude-sonnet-4-6',
                'claude-opus-4-7'
            ],
            judge_model:                 'claude-haiku-4-5',
            judge_equivalence_threshold: 0.85,
            max_completion_tokens:       1024,
            default_temperature:         0,
            prompt_envelope_version:     1
        }
    }
};

class ProviderRegistry {

    constructor(hub){
        this.hub = hub;
        this.db  = hub.db;

        // Loaded provider definitions: providerId -> def object
        this.providers = new Map();

        // Lazy-loaded provider modules: providerId -> require('./providers/<id>.js')
        this.modules = new Map();

        // Pre-seed with defaults so even a fresh deploy is operational
        for (let [id, def] of Object.entries(DEFAULTS)) {
            this.providers.set(id, def);
        }
    }

    // Pull provider defs from the configs table and overlay onto defaults.
    // Each configs row under (coin, network, 'ATTESTATION_PROVIDER', <provider_id>)
    // has a JSON-encoded definition as its param_value.
    async load(){
        // Re-seed defaults so a removed governance row reverts to default,
        // not stays as the last-known state.
        this.providers.clear();
        for (let [id, def] of Object.entries(DEFAULTS)) {
            this.providers.set(id, def);
        }

        // Hub config — coin/network describe which chain's configs to read
        let coin = this.hub.config && this.hub.config.COIN;
        let net  = this.hub.config && this.hub.config.NETWORK;
        if (!coin || !net || !this.db) return;

        try {
            let rows = await this.db.getConfig(coin, net, 'ATTESTATION_PROVIDER');
            for (let providerId of Object.keys(rows)) {
                let raw = rows[providerId];
                if (!raw) continue;
                try {
                    let def = JSON.parse(raw);
                    if (!def.provider_id) def.provider_id = providerId;
                    this.providers.set(providerId, def);
                } catch (e) {
                    console.warn('ProviderRegistry: bad JSON for ATTESTATION_PROVIDER:' + providerId + ' —', e);
                }
            }
        } catch (e) {
            console.warn('ProviderRegistry: failed to read configs table —', e);
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
                catch (e) { console.warn('ProviderRegistry: _setConfig (reload) failed for ' + providerId + ' —', e); }
            }
        }
    }

    // Whether a provider id is known and active
    isKnown(providerId){
        return this.providers.has(providerId);
    }

    // Full provider definition object, or null
    getDef(providerId){
        return this.providers.get(providerId) || null;
    }

    // Lazy-load the provider module (fetch + agree + healthCheck). Returns null
    // if no module exists for the given id (e.g. governance registered a provider
    // whose code isn't deployed on this hub yet — that's an operator config issue).
    //
    // If the module exports a `_setConfig(def)` hook, the loaded def is injected
    // so governance-controlled `additional_config` reaches the module without a
    // hub restart. (LLM uses this for `approved_models`, `judge_model`, etc.)
    getModule(providerId){
        if (!this.providers.has(providerId)) return null;
        if (this.modules.has(providerId)) return this.modules.get(providerId);
        try {
            let mod = require('./providers/' + providerId + '.js');
            if (typeof mod._setConfig === 'function'){
                try { mod._setConfig(this.providers.get(providerId)); }
                catch (e) { console.warn('ProviderRegistry: _setConfig failed for ' + providerId + ' —', e); }
            }
            this.modules.set(providerId, mod);
            return mod;
        } catch (e) {
            console.warn('ProviderRegistry: module load failed for ' + providerId + ' —', e);
            return null;
        }
    }

    listProviderIds(){
        return [...this.providers.keys()];
    }

    // ----- Validation helpers (parity with indexer-side stub) -----

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

module.exports = ProviderRegistry;
module.exports.DEFAULTS = DEFAULTS;
