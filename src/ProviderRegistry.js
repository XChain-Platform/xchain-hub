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
        // Hub-local request-fee floor (E1): requests whose on-chain FEE_AMOUNT
        // is below this are skipped by AttestationRound (they expire + refund).
        // '0' = serve everything, including feeless requests. Governance-synced
        // like every other field in this definition.
        min_fee_xchain:         '0',
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
        min_fee_xchain:         '0',
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

// Parse a governance parameter name of the form ATTESTATION_PROVIDER:<provider_id>
// into the provider_id, or null if it is not a provider-config parameter. Mirrors
// the configs-table key structure (module='ATTESTATION_PROVIDER', param_name=id) and
// parallels parseCapabilityMinStakeParam; used for the block-anchored config history.
function parseAttestationProviderParam(parameter) {
    let m = /^ATTESTATION_PROVIDER:(.+)$/.exec(String(parameter || ''));
    if (!m) return null;
    return m[1];
}

class ProviderRegistry {

    constructor(hub){
        this.hub = hub;
        this.db  = hub.db;

        // Loaded provider definitions: providerId -> def object
        this.providers = new Map();

        // Lazy-loaded provider modules: providerId -> require('./providers/<id>.js')
        this.modules = new Map();

        // Block-anchored provider-config history: providerId -> array of
        // { activation_block, additional_config } ordered ascending by
        // activation_block. Seeded from the static DEFAULTS as a genesis entry
        // (activation_block 0), then APPENDED (never overwritten) when a governance
        // ATTESTATION_PROVIDER change finalizes, each entry carrying the
        // proposer-declared activation_block. Resolving the model identity for a
        // request's block (getAdditionalConfig(providerId, blockIndex)) is then a
        // deterministic function of block height, identical on every hub regardless
        // of when each one applied the change. This is what makes the LLM fetch/judge
        // model federation-deterministic (mirror of CapabilityRegistry.minStakeHistory).
        this.providerConfigHistory = new Map();

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

        // Hub config: coin/network describe which chain's configs to read
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
                    console.warn('ProviderRegistry: bad JSON for ATTESTATION_PROVIDER:' + providerId, e);
                }
            }
        } catch (e) {
            console.warn('ProviderRegistry: failed to read configs table:', e);
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
                catch (e) { console.warn('ProviderRegistry: _setConfig (reload) failed for ' + providerId, e); }
            }
        }
    }

    isKnown(providerId){
        return this.providers.has(providerId);
    }

    getDef(providerId){
        return this.providers.get(providerId) || null;
    }

    // ----- Block-anchored provider-config history (consensus model identity) -----

    // (Re)seed the genesis (block-0) additional_config for every known provider from
    // the static DEFAULTS constant (not the mutable this.providers loaded from configs).
    // This keeps the genesis entry restart-stable: even if the configs table is updated
    // between two hub restarts, block-0 always resolves to the original built-in value,
    // matching how CapabilityRegistry._seedGenesisHistory seeds from p2pConfig.CAPABILITIES
    // rather than from the mutable minStake table. Governance activation entries
    // (activation_block > 0) are what carry the real change.
    // Called from loadGovernanceHistory before layering governance changes. Preserves
    // any already-appended future activation entries (only the block-0 entry is reset),
    // so re-seeding does not wipe finalized history.
    _seedProviderConfigGenesis(){
        for (let [providerId, def] of Object.entries(DEFAULTS)){
            let ac = (def && def.additional_config) || {};
            let hist = this.providerConfigHistory.get(providerId) || [];
            let g = hist.find(e => e.activation_block === 0);
            if (g) g.additional_config = ac;
            else { hist.push({ activation_block: 0, additional_config: ac }); hist.sort((a, b) => a.activation_block - b.activation_block); }
            this.providerConfigHistory.set(providerId, hist);
        }
    }

    // Resolve a provider's additional_config effective AT blockIndex = the entry with
    // the greatest activation_block <= blockIndex. This is the CONSENSUS path: every hub
    // resolves the same config (and therefore the same fetch/judge model) for the same
    // block. With no blockIndex, returns the latest (non-consensus callers). Falls back to
    // the current def's additional_config when no history exists (fresh hub, no genesis seed).
    getAdditionalConfig(providerId, blockIndex){
        let hist = this.providerConfigHistory.get(providerId);
        if (!hist || hist.length === 0){
            let def = this.getDef(providerId);
            return (def && def.additional_config) || null;
        }
        if (blockIndex === undefined || blockIndex === null) return hist[hist.length - 1].additional_config;
        let resolved = null;
        for (let e of hist){
            if (e.activation_block <= blockIndex) resolved = e.additional_config;
            else break; // ascending: no later entry can be in effect at blockIndex
        }
        return resolved !== null ? resolved : hist[0].additional_config;
    }

    // Append a block-anchored governance provider-config change to the history (idempotent
    // by activation_block; kept sorted ascending). Mirror of
    // CapabilityRegistry.applyMinStakeActivation: the change does not take effect until the
    // chain reaches activation_block, so two hubs that append at different wall-clock moments
    // still agree on the config for every block.
    applyProviderConfigActivation(providerId, activationBlock, additionalConfig){
        let ab = Number(activationBlock);
        if (!Number.isInteger(ab) || ab < 0)
            throw new Error('invalid activation_block: ' + activationBlock);
        let hist = this.providerConfigHistory.get(providerId) || [];
        let existing = hist.find(e => e.activation_block === ab);
        if (existing) { existing.additional_config = additionalConfig; }
        else { hist.push({ activation_block: ab, additional_config: additionalConfig }); hist.sort((a, b) => a.activation_block - b.activation_block); }
        this.providerConfigHistory.set(providerId, hist);
        return hist;
    }

    // Reconstruct block-anchored provider-config history from finalized governance
    // proposals after a restart so a long-running hub and a freshly-started one resolve
    // identical model identities for every block. Genesis entries (from the static DEFAULTS)
    // are seeded first; this layers passed ATTESTATION_PROVIDER proposals on top, ordered by
    // activation_block. Idempotent. Best-effort: a hub without governance_proposals just gets
    // the genesis seed. Mirror of CapabilityRegistry.loadGovernanceHistory.
    async loadGovernanceHistory(){
        this._seedProviderConfigGenesis();
        if (!this.db) return;
        let rows;
        try {
            rows = await this.db.doQuery(
                `SELECT parameter, proposed_value, activation_block
                   FROM governance_proposals
                  WHERE status = 'passed' AND activation_block IS NOT NULL
                  ORDER BY activation_block ASC, id ASC`, []);
        } catch (e) {
            // Distinguish transient read failure from the benign "table absent on a
            // fresh hub" case: log so a startup-time DB error is visible in the log
            // and the hub doesn't silently serve pre-governance model config for
            // post-governance blocks.
            console.warn('ProviderRegistry: loadGovernanceHistory failed, hub may use genesis-only provider config:', e && e.message);
            return;
        }
        for (let r of rows){
            let providerId = parseAttestationProviderParam(r.parameter);
            if (!providerId) continue;
            let ac;
            try {
                let parsed = JSON.parse(r.proposed_value);
                // Accept either a full provider def or a bare additional_config object.
                ac = (parsed && parsed.additional_config) ? parsed.additional_config : parsed;
            } catch (e) { continue; }
            this.applyProviderConfigActivation(providerId, r.activation_block, ac);
        }
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
            let mod = require('./providers/' + providerId + '.js');
            if (typeof mod._setConfig === 'function'){
                try { mod._setConfig(this.providers.get(providerId)); }
                catch (e) { console.warn('ProviderRegistry: _setConfig failed for ' + providerId, e); }
            }
            this.modules.set(providerId, mod);
            return mod;
        } catch (e) {
            console.warn('ProviderRegistry: module load failed for ' + providerId, e);
            return null;
        }
    }

    listProviderIds(){
        return [...this.providers.keys()];
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

module.exports = ProviderRegistry;
module.exports.DEFAULTS = DEFAULTS;
module.exports.parseAttestationProviderParam = parseAttestationProviderParam;
