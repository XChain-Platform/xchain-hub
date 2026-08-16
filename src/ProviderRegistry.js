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
            // ORDERED fallback chain: index 0 is the primary; later entries
            // serve when the block-height escalation ladder advances (see
            // attestation_escalation.js). Single-vendor by default; adding a
            // second vendor's model here is a GOVERNANCE action (with an
            // activation block) so mixed-version fleets never diverge on the
            // pinned fetch model.
            approved_models: [
                'claude-sonnet-4-6',
                'claude-opus-4-7'
            ],
            judge_model:                 'claude-haiku-4-5',
            // Leader-local judge alternates for vendor outages (providers/llm.js).
            // Empty by default; governance populates alongside approved_models.
            judge_fallback_models:       [],
            // Explicit model-id → vendor overrides for ids the provider's
            // prefix inference can't classify.
            model_vendors:               {},
            // When true, the llm self-test fails unless credentials resolve for
            // every vendor on the chains above (validators skip llm rounds and
            // accrue missed_count until they provision fallback keys).
            require_all_vendors:         false,
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

// Canonicalise a provider min_stake_xchain value to a plain decimal string, or null
// when it is absent/unparseable. Deterministic by construction (a regex, not
// Number()) so every hub in the federation derives the identical string from the
// identical governance payload: this value lands in a block-anchored history whose
// whole purpose is cross-hub agreement, and a float round-trip would reintroduce
// the divergence the anchoring removes. An unparseable value resolves to null,
// which a consensus caller must treat as "no floor configured" and fail closed on
// rather than silently substituting 0.
function normalizeMinStakeXchain(value) {
    if (value === null || value === undefined) return null;
    let s = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return s;
}

// Canonicalise a provider consensus_strategy to a plain string, or null when it is
// absent/blank. Deliberately NOT an allowlist of the strategies this build knows:
// an unrecognised name must travel into the history verbatim so a hub running older
// code resolves the same UNKNOWN value every peer does and declines the round,
// rather than silently walking back to an older strategy and running a different
// PBFT state machine from the rest of the federation for the same block.
function normalizeConsensusStrategy(value) {
    if (value === null || value === undefined) return null;
    let s = String(value).trim();
    return s === '' ? null : s;
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
            let ms = normalizeMinStakeXchain(def && def.min_stake_xchain);
            // From DEFAULTS, never this.providers, for the reason stated above: the
            // block-0 strategy has to be the same on a hub restarted after an operator
            // edited the configs table as on one that was never restarted.
            let cs = normalizeConsensusStrategy(def && def.consensus_strategy);
            let hist = this.providerConfigHistory.get(providerId) || [];
            let g = hist.find(e => e.activation_block === 0);
            if (g) { g.additional_config = ac; g.min_stake_xchain = ms; g.consensus_strategy = cs; }
            else { hist.push({ activation_block: 0, additional_config: ac, min_stake_xchain: ms, consensus_strategy: cs }); hist.sort((a, b) => a.activation_block - b.activation_block); }
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

    // Resolve a provider's min_stake_xchain floor effective AT blockIndex: the greatest
    // activation_block <= blockIndex whose entry actually SET a floor. Entries left null
    // (a governance change that only moved additional_config) are transparent, so the
    // floor persists until a later change replaces it, exactly like a config value that
    // was never touched. With no blockIndex, returns the latest configured floor
    // (non-consensus callers: operator status, diagnostics).
    //
    // Returns null when nothing in the history set a floor AND the live definition
    // carries none. A consensus caller must treat null as fail-closed (refuse the
    // decision) rather than as an implicit floor of 0: substituting 0 would silently
    // widen the serving set, which is the same class of fork
    // CapabilitySnapshot._resolveMinStake fails closed on for the capability threshold.
    //
    // The fallback to the LIVE definition (used only when the history has nothing to
    // say) mirrors getAdditionalConfig: it keeps a fresh hub that never seeded genesis
    // usable, and is safe for non-consensus reads. A consensus caller must therefore
    // ensure loadGovernanceHistory has run, so the value it reads is the anchored one.
    getMinStake(providerId, blockIndex){
        let hist = this.providerConfigHistory.get(providerId);
        let resolved = null;
        if (hist && hist.length > 0){
            if (blockIndex === undefined || blockIndex === null){
                for (let e of hist) if (e.min_stake_xchain !== null && e.min_stake_xchain !== undefined) resolved = e.min_stake_xchain;
            } else {
                for (let e of hist){
                    if (e.activation_block > blockIndex) break; // ascending: nothing later is in effect yet
                    if (e.min_stake_xchain !== null && e.min_stake_xchain !== undefined) resolved = e.min_stake_xchain;
                }
            }
        }
        if (resolved !== null) return resolved;
        let def = this.getDef(providerId);
        return normalizeMinStakeXchain(def && def.min_stake_xchain);
    }

    // Resolve a provider's consensus_strategy effective AT blockIndex: the greatest
    // activation_block <= blockIndex whose entry actually SET a strategy. Entries left
    // null (a governance change that only moved additional_config or the floor) are
    // transparent, exactly as in getMinStake.
    //
    // This is a CONSENSUS read. AttestationConsensus branches its whole PBFT phase
    // transition on the answer, so the value a round runs on is resolved ONCE at
    // _startRound against the request's own block and pinned into roundState; the six
    // decision sites read the pinned value and never the registry. Resolving per
    // message instead let a hotReload land mid-round and flip a hub's state machine
    // between two messages of the same round.
    //
    // The fallback to the LIVE definition when history has nothing to say mirrors
    // getMinStake and keeps a fresh hub (or one whose loadGovernanceHistory could not
    // read governance_proposals) serving instead of stalling. It is strictly no worse
    // than the pre-anchoring behaviour, which read live unconditionally, and it is
    // unreachable for any provider in DEFAULTS because _seedProviderConfigGenesis
    // always gives those a block-0 entry. A consensus caller still treats a null
    // result as fail-closed: a provider whose strategy no hub can anchor cannot be
    // served deterministically.
    getConsensusStrategy(providerId, blockIndex){
        let hist = this.providerConfigHistory.get(providerId);
        let resolved = null;
        if (hist && hist.length > 0){
            if (blockIndex === undefined || blockIndex === null){
                for (let e of hist) if (e.consensus_strategy !== null && e.consensus_strategy !== undefined) resolved = e.consensus_strategy;
            } else {
                for (let e of hist){
                    if (e.activation_block > blockIndex) break; // ascending: nothing later is in effect yet
                    if (e.consensus_strategy !== null && e.consensus_strategy !== undefined) resolved = e.consensus_strategy;
                }
            }
        }
        if (resolved !== null) return resolved;
        let def = this.getDef(providerId);
        return normalizeConsensusStrategy(def && def.consensus_strategy);
    }

    // Append a block-anchored governance provider-config change to the history (idempotent
    // by activation_block; kept sorted ascending). Mirror of
    // CapabilityRegistry.applyMinStakeActivation: the change does not take effect until the
    // chain reaches activation_block, so two hubs that append at different wall-clock moments
    // still agree on the config for every block.
    //
    // `minStakeXchain` and `consensusStrategy` are optional: omit either (or pass an
    // unparseable value) for a change that does not move that field, and the entry stores
    // null so getMinStake / getConsensusStrategy keep resolving the previously-activated
    // value.
    applyProviderConfigActivation(providerId, activationBlock, additionalConfig, minStakeXchain, consensusStrategy){
        let ab = Number(activationBlock);
        if (!Number.isInteger(ab) || ab < 0)
            throw new Error('invalid activation_block: ' + activationBlock);
        let ms = normalizeMinStakeXchain(minStakeXchain);
        let cs = normalizeConsensusStrategy(consensusStrategy);
        let hist = this.providerConfigHistory.get(providerId) || [];
        let existing = hist.find(e => e.activation_block === ab);
        if (existing) { existing.additional_config = additionalConfig; existing.min_stake_xchain = ms; existing.consensus_strategy = cs; }
        else { hist.push({ activation_block: ab, additional_config: additionalConfig, min_stake_xchain: ms, consensus_strategy: cs }); hist.sort((a, b) => a.activation_block - b.activation_block); }
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
            let ac, ms, cs;
            try {
                let parsed = JSON.parse(r.proposed_value);
                // Accept either a full provider def or a bare additional_config object.
                ac = (parsed && parsed.additional_config) ? parsed.additional_config : parsed;
                // Only a FULL provider def can move the stake floor; a bare
                // additional_config payload leaves it undefined, so the entry stays
                // transparent and the previously-activated floor keeps resolving.
                ms = (parsed && parsed.min_stake_xchain !== undefined) ? parsed.min_stake_xchain : undefined;
                // Same for the PBFT strategy. Must be read on BOTH write paths (this
                // restart replay and XChainHub._applyProviderGovernanceChange, the live
                // one) or a restarted hub and a long-running one resolve different state
                // machines for the same block, which is the divergence anchoring removes.
                cs = (parsed && parsed.consensus_strategy !== undefined) ? parsed.consensus_strategy : undefined;
            } catch (e) { continue; }
            this.applyProviderConfigActivation(providerId, r.activation_block, ac, ms, cs);
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

module.exports = ProviderRegistry;
module.exports.DEFAULTS = DEFAULTS;
module.exports.parseAttestationProviderParam = parseAttestationProviderParam;
module.exports.normalizeMinStakeXchain = normalizeMinStakeXchain;
