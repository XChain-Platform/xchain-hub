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
 * XChain Hub - Canonical Config Guards
 *
 * The two operator files that must agree with the pinned coin bundle:
 * capability MIN_STAKE thresholds and the FULLNODE block. A divergence here
 * is a consensus fork, so each guard says on which networks it refuses.
 *
 ********************************************************************/

const coins = require('../coins');
const fullnodeActivation = require('../lib/fullnode_activation.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');
const logger = getLogger();

// Every configured capability whose floor differs from the canonical one.
function collectMinStakeMismatches(caps, canonicalCaps) {
    let mismatches = [];
    for(let [cap, entry] of Object.entries(caps)){
        let canonical = canonicalCaps[cap];
        if(!canonical){
            // Unknown to the canonical registry: nothing to assert against. The
            // registry and self-test layers already surface unusable capabilities.
            logger.warn('Capability "' + cap + '" is not in the canonical coins registry; ' +
                'MIN_STAKE not asserted.');
            continue;
        }
        let configured = Number((entry && entry.MIN_STAKE !== undefined) ? entry.MIN_STAKE : 0);
        let expected   = Number(canonical.MIN_STAKE);
        if(!Number.isFinite(configured) || configured !== expected){
            mismatches.push(cap + ': configured ' +
                ((entry && entry.MIN_STAKE !== undefined) ? entry.MIN_STAKE : '(missing -> 0)') +
                ' vs canonical ' + canonical.MIN_STAKE);
        }
    }
    return mismatches;
}

// A canonical capability the operator file never mentions is a worse class than
// a low floor, and this is the error that refuses it.
function unconfiguredCapabilityError(unconfigured, canonicalCaps, mismatches) {
    let missing = unconfigured.map(cap =>
        cap + ' (canonical ' + canonicalCaps[cap].MIN_STAKE + ')').join('; ');
    let err = new Error('CONSENSUS CANNOT RUN: capability ' +
        (unconfigured.length === 1 ? '"' + unconfigured[0] + '" is' : unconfigured.join(', ') + ' are') +
        ' missing from HUB_CAPABILITY_CONFIG entirely, so this hub has no qualifying ' +
        'floor for ' + (unconfigured.length === 1 ? 'it' : 'them') + ' and CapabilitySnapshot ' +
        'refuses to build a snapshot: EVERY consensus round for ' +
        (unconfigured.length === 1 ? 'that capability' : 'those capabilities') +
        ' fails closed with min_stake_unconfigured. Omitting min_stake would let each ' +
        'indexer apply its OWN threshold, so two hubs could qualify different validator ' +
        'sets for the same round and FORK. Add CAPABILITIES.<capability>.MIN_STAKE to ' +
        'capabilities.json (equal to the indexer constant) for: ' + missing +
        '. Refusing to start rather than warning once and then failing every round ' +
        '(XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1 to bypass on a venue that deliberately ' +
        'runs without these capabilities).');
    err.code = 'CAPABILITY_UNCONFIGURED';
    err.capabilities = unconfigured;
    // Surface any threshold mismatches too, so one boot attempt shows the
    // operator every edit the file needs rather than one per restart.
    if(mismatches.length > 0){
        logger.warn('Capability MIN_STAKE mismatches in the same config: ' + mismatches.join('; '));
    }
    return err;
}

class CanonicalConfig {

    // Assert operator MIN_STAKE thresholds against the canonical coins registry
    // (src/coins/BTC.js STAKING.CAPABILITIES, byte-identity-gated across the fleet).
    // This is the qualifying floor every CapabilitySnapshot sends the indexer, so a hub
    // whose capabilities.json diverges computes a DIFFERENT qualified set and quorum N
    // than its peers: a consensus fork, not a local preference. mainnet and testnet
    // throw MIN_STAKE_MISMATCH and startCapabilities rethrows, so boot halts fail-closed;
    // regtest and standalone warn only, so a test venue can run a deliberately low floor.
    // XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1 is a loud one-off bypass. A capability with no
    // MIN_STAKE key seeds a genesis floor of '0', so a missing key counts as a mismatch
    // and never as a pass.
    //
    // A canonical capability ABSENT from the file entirely is a different, worse class
    // and is refused on EVERY network (CAPABILITY_UNCONFIGURED). A low floor is
    // something a test venue chooses deliberately, which is why the mismatch above is
    // non-strict off mainnet and testnet; a hole is never chosen, and its blast radius is
    // total: CapabilitySnapshot fails closed on every round for that capability
    // (min_stake_unconfigured) because omitting min_stake would let each indexer apply
    // its OWN threshold and fork the qualified set. Warning once at boot and then
    // failing every round forever is the behaviour this refusal replaces.
    assertCanonicalMinStakes(caps){
        if(!caps || typeof caps !== 'object' || Array.isArray(caps)) return;
        if(hubConfig.XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT === '1'){
            logger.warn('XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1: skipping canonical MIN_STAKE ' +
                'assertion. Divergent thresholds fork the qualified validator set; ' +
                'only bypass on a venue where every hub runs the SAME override.');
            return;
        }
        // STAKING is network-independent in the registry (no per-network overrides) but
        // resolves through the same getCoinConfig path consumers use. Staking is
        // BTC-anchored, so only BTC's floors gate quorum.
        let network = this.network || 'mainnet';
        let canonicalCaps;
        try {
            let cfg = coins.getCoinConfig('BTC', network);
            canonicalCaps = (cfg.STAKING && cfg.STAKING.CAPABILITIES) ? cfg.STAKING.CAPABILITIES : null;
        } catch(e){
            logger.warn('Canonical MIN_STAKE assertion skipped: could not resolve BTC coin config for network "' +
                network + '": ' + e.message);
            return;
        }
        if(!canonicalCaps) return;
        const mismatches = collectMinStakeMismatches(caps, canonicalCaps);
        // Capabilities the canonical registry knows about that this file never mentions.
        // DISABLED_CAPABILITIES does NOT excuse one: that flag only stops THIS hub from
        // serving the capability, while it still has to build the federation-wide
        // snapshot for every round its peers run.
        let unconfigured = Object.keys(canonicalCaps).filter(cap => !caps[cap]);
        if(unconfigured.length > 0){
            throw unconfiguredCapabilityError(unconfigured, canonicalCaps, mismatches);
        }
        if(mismatches.length === 0) return;
        let detail = 'capability MIN_STAKE diverges from the canonical coins registry ' +
            '(src/coins/BTC.js STAKING.CAPABILITIES): ' + mismatches.join('; ') +
            '. Every hub must query the indexer with the SAME floor or the qualified ' +
            'validator set / quorum N forks across the federation. Fix capabilities.json ' +
            'to the canonical values (XCHAIN_HUB_SKIP_MIN_STAKE_ASSERT=1 to bypass on a ' +
            'coordinated test venue).';
        // Strict only on a declared consensus network; a standalone hub (no network, so no
        // consensus runs) and regtest venues warn instead of refusing.
        if(this.network === 'mainnet' || this.network === 'testnet'){
            let err = new Error(detail);
            err.code = 'MIN_STAKE_MISMATCH';
            throw err;
        }
        logger.warn('MIN_STAKE mismatch (non-strict on ' + (this.network || 'standalone') + '): ' + detail);
    }

    // Canonical FULLNODE block for this hub's network, or null when unresolvable. The
    // full-node tier is BTC-anchored, so BTC is the only bundle that matters.
    canonicalFullnode(){
        let network = this.network || 'mainnet';
        try {
            let cfg = coins.getCoinConfig('BTC', network);
            return cfg.FULLNODE || null;
        } catch(e){
            logger.warn('Canonical FULLNODE resolution skipped: could not resolve BTC coin config for network "' +
                network + '": ' + e.message);
            return null;
        }
    }

    // Assert an operator FULLNODE override against the canonical registry and check the
    // effective block for activation coherence. Activating the inert NODEPROOF tier moves
    // the challenge schedule, the verifier quorum and the oracle reward split: fleet-wide
    // consensus, so it belongs in the pinned bundle. Throws FULLNODE_CONFIG_MISMATCH.
    assertCanonicalFullnode(fn){
        if(!fn || typeof fn !== 'object' || Array.isArray(fn)) return;
        if(hubConfig.XCHAIN_HUB_SKIP_FULLNODE_ASSERT === '1'){
            logger.warn('XCHAIN_HUB_SKIP_FULLNODE_ASSERT=1: skipping canonical FULLNODE ' +
                'assertion. Divergent NODEPROOF knobs fork the challenge schedule, the ' +
                'verifier quorum and the oracle reward split; only bypass on a venue where every ' +
                'hub runs the SAME override.');
            return;
        }
        let canonical = this.canonicalFullnode();
        if(!canonical) return;

        let problems = fullnodeActivation.diffCanonical(fn, canonical)
            .concat(fullnodeActivation.validateActivation(
                fullnodeActivation.mergeWithCanonical(canonical, fn)));
        if(problems.length === 0) return;

        let detail = 'FULLNODE config is unsafe to run: ' + problems.join('; ') +
            '. NODEPROOF activation is a fleet-wide consensus change: set it in the pinned ' +
            'coin bundle (src/coins/BTC.js FULLNODE) across hub, indexer and sync together, ' +
            'never in a single operator capabilities.json ' +
            '(XCHAIN_HUB_SKIP_FULLNODE_ASSERT=1 to bypass on a coordinated test venue).';

        if(this.network === 'mainnet' || this.network === 'testnet'){
            let err = new Error(detail);
            err.code = 'FULLNODE_CONFIG_MISMATCH';
            throw err;
        }
        logger.warn('FULLNODE config problem (non-strict on ' + (this.network || 'standalone') + '): ' + detail);
    }

    // Seed p2pConfig.FULLNODE from the canonical coin bundle, operator keys on top.
    // Without it FullNodeChallengeRound read only the operator file and fell back to
    // hardcoded literals, so activating the tier the documented way changed the indexer
    // while every hub kept the inert defaults. Idempotent, so hot-reload can re-run it.
    seedCanonicalFullnode(){
        if(!this.p2pConfig) return;
        let canonical = this.canonicalFullnode();
        if(!canonical) return;
        this.p2pConfig.FULLNODE = fullnodeActivation.mergeWithCanonical(canonical, this.p2pConfig.FULLNODE);
    }
}

module.exports = CanonicalConfig;
