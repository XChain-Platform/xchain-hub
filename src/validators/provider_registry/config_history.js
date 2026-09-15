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
 * XChain Hub - Attestation provider config history
 *
 * Block-anchored provider-config history (consensus model identity): every hub
 * resolves the same additional_config, stake floor and PBFT strategy for the same
 * request block. src/validators/provider_registry.js installs every method below
 * on ProviderRegistry.prototype, so callers keep writing registry.<method>().
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();
const {
    DEFAULTS, parseAttestationProviderParam, normalizeMinStakeXchain, normalizeConsensusStrategy
} = require('./defaults.js');

module.exports = {

    // (Re)seed the genesis (block-0) additional_config for every known provider from
    // the static DEFAULTS constant (not the mutable this.providers loaded from configs).
    // This keeps the genesis entry restart-stable: even if the configs table is updated
    // between two hub restarts, block-0 always resolves to the original built-in value,
    // matching how CapabilityRegistry.seedGenesisHistory seeds from p2pConfig.CAPABILITIES
    // rather than from the mutable minStake table. Governance activation entries
    // (activation_block > 0) are what carry the real change.
    // Called from loadGovernanceHistory before layering governance changes. Preserves
    // any already-appended future activation entries (only the block-0 entry is reset),
    // so re-seeding does not wipe finalized history.
    seedProviderConfigGenesis(){
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
    },

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
    },

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
    // CapabilitySnapshot.resolveMinStake fails closed on for the capability threshold.
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
    },

    // Resolve a provider's consensus_strategy effective AT blockIndex: the greatest
    // activation_block <= blockIndex whose entry actually SET a strategy. Entries left
    // null (a governance change that only moved additional_config or the floor) are
    // transparent, exactly as in getMinStake.
    //
    // This is a CONSENSUS read. AttestationConsensus branches its whole PBFT phase
    // transition on the answer, so the value a round runs on is resolved ONCE at
    // startRound against the request's own block and pinned into roundState; the six
    // decision sites read the pinned value and never the registry. Resolving per
    // message instead let a hotReload land mid-round and flip a hub's state machine
    // between two messages of the same round.
    //
    // The fallback to the LIVE definition when history has nothing to say mirrors
    // getMinStake and keeps a fresh hub (or one whose loadGovernanceHistory could not
    // read governance_proposals) serving instead of stalling. It is strictly no worse
    // than the pre-anchoring behaviour, which read live unconditionally, and it is
    // unreachable for any provider in DEFAULTS because seedProviderConfigGenesis
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
    },

    // Append a block-anchored governance provider-config change to the history (idempotent
    // by activation_block; kept sorted ascending). Mirror of
    // CapabilityRegistry.applyMinStakeActivation: the change does not take effect until the
    // chain reaches activation_block, so two hubs that append at different wall-clock moments
    // still agree on the config for every block.
    //
    // `minStakeXchain` and `consensusStrategy` are optional: omit either (or pass an
    // unparseable value) for a change that does not move that field, and the entry stores
    // null so getMinStake / getConsensusStrategy keep resolving the last-activated
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
    },

    // Reconstruct block-anchored provider-config history from finalized governance
    // proposals after a restart so a long-running hub and a freshly-started one resolve
    // identical model identities for every block. Genesis entries (from the static DEFAULTS)
    // are seeded first; this layers passed ATTESTATION_PROVIDER proposals on top, ordered by
    // activation_block. Idempotent. Best-effort: a hub without governance_proposals just gets
    // the genesis seed. Mirror of CapabilityRegistry.loadGovernanceHistory.
    async loadGovernanceHistory(){
        this.seedProviderConfigGenesis();
        if (!this.db) return;
        let rows;
        try {
            rows = await this.db.findGovernanceProposalsByStatus();
        } catch (e) {
            // Distinguish transient read failure from the benign "table absent on a
            // fresh hub" case: log so a startup-time DB error is visible in the log
            // and the hub doesn't silently serve pre-governance model config for
            // post-governance blocks.
            logger.warn(nodeUtil.format('ProviderRegistry: loadGovernanceHistory failed, hub may use genesis-only provider config:', e && e.message));
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
                // transparent and the last-activated floor keeps resolving.
                ms = (parsed && parsed.min_stake_xchain !== undefined) ? parsed.min_stake_xchain : undefined;
                // Same for the PBFT strategy. Must be read on BOTH write paths (this
                // restart replay and XChainHub.applyProviderGovernanceChange, the live
                // one) or a restarted hub and a long-running one resolve different state
                // machines for the same block, which is the divergence anchoring removes.
                cs = (parsed && parsed.consensus_strategy !== undefined) ? parsed.consensus_strategy : undefined;
            } catch (e) { continue; }
            this.applyProviderConfigActivation(providerId, r.activation_block, ac, ms, cs);
        }
    }
};
