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
 * XChain Hub - NODEPROOF full-node tier activation config 
 *
 * The verified-full-node tier (NODEPROOF.md) ships INERT: the canonical coin
 * bundle carries REWARD_SHARE '0' and an empty GENESIS_VERIFIERS list, and the
 * launch genesis parameters (claude/reports/launch/GENESIS-PARAMETERS.md row B7)
 * keep it that way at launch. Activation is therefore a deliberate, fleet-wide
 * config change, and every knob it touches is a CONSENSUS parameter:
 *
 *   REWARD_SHARE               splits the oracle-round budget into the base and
 *                              full-node tranches (indexer price.js). A hub or
 *                              indexer with a different value derives different
 *                              validator_rewards rows -> different block hashes.
 *   GENESIS_VERIFIERS          the bootstrap verifier universe, unioned with the
 *                              on-chain verified set on BOTH sides (hub
 *                              _eligibleVerifiers / indexer _eligibleVerifierSet).
 *                              It is the leader-election domain and the 2/3+1
 *                              quorum denominator, so a divergent list means a
 *                              quorum one hub assembles is one the chain rejects.
 *   CHALLENGE_INTERVAL_BLOCKS  which epochs are challenged, and
 *   CONFIRM_DEPTH              which coin block the answer comes from: together
 *                              they derive challenge_id, so a divergent value
 *                              makes a hub answer a challenge nobody asked.
 *   VERDICT_ACCEPT_WINDOW_BLOCKS  the indexer's on-chain verdict admission window.
 *   PROOF_WINDOW_BLOCKS        how long a passing proof keeps verifier standing.
 *   REWARD_PASS_WINDOW_BLOCKS  the participation-rate denominator window, and
 *   MIN_PASS_RATE_BPS          the rate a staking source must clear to earn the
 *                              tranche (reward-only tier; there is no slashing).
 *
 * This module is the hub's preflight for that change. It is pure (no I/O) and is
 * consumed by XChainHub._assertCanonicalFullnode, which mirrors the 
 * MIN_STAKE assert: on mainnet/testnet a divergent or incoherent block is
 * REFUSED fail-closed, on regtest/standalone it warns so venues can run their own
 * knobs. See claude/reports/launch/NODEPROOF-ACTIVATION-RUNBOOK.md.
 *
 * Two distinct checks live here, deliberately separate:
 *
 *   diffCanonical()      operator override vs the pinned coin bundle. Activation
 *                        belongs in the byte-identity-gated bundle that every
 *                        service ships, NOT in one operator's capabilities.json;
 *                        the same reasoning as the FEE_DESTINATION env override
 *                        being ignored off regtest (src/coins/index.js).
 *   validateActivation() internal coherence of the EFFECTIVE block, which catches
 *                        the activation footguns a diff never can (a REWARD_SHARE
 *                        the tier can never pay out, a verifier key the runtime
 *                        silently drops, a window that contains no challenge).
 *
 ********************************************************************/

'use strict';

// Validator pubkeys are Ed25519 (32 bytes), rendered lowercase hex on the wire.
// Both eligible-verifier sites filter on exactly this shape and SILENTLY DROP
// anything else, which is why a malformed entry has to be caught here instead.
const HEX64 = /^[0-9a-fA-F]{64}$/;

// Per-key coherence bounds for the integer knobs. A key absent from the block is
// not checked (the runtime falls back to its own default); a key that IS present
// must be a sane positive integer, since every one of these is a block count.
const INT_BOUNDS = {
    CHALLENGE_INTERVAL_BLOCKS:    { min: 1 },
    CONFIRM_DEPTH:                { min: 1 },
    PROOF_WINDOW_BLOCKS:          { min: 1 },
    VERDICT_ACCEPT_WINDOW_BLOCKS: { min: 1 },
    REWARD_PASS_WINDOW_BLOCKS:    { min: 1 },
    MIN_PASS_RATE_BPS:            { min: 0, max: 10000 },
};

function isPlainObject(o){
    return !!o && typeof o === 'object' && !Array.isArray(o);
}

// Consensus keys are exactly the ones the canonical bundle declares, so adding a
// knob to coins/BTC.js FULLNODE automatically brings it under the assert. The
// '$'-prefixed entries are the internal env/sidecar descriptors, never config.
function consensusKeys(canonical){
    if(!isPlainObject(canonical)) return [];
    return Object.keys(canonical).filter(k => k.charAt(0) !== '$');
}

// Verifier keys are compared (and used) case-insensitively and as a SET: both
// runtimes lowercase them into a Set, so order and case carry no meaning and must
// not read as divergence.
function normalizeVerifiers(list){
    if(!Array.isArray(list)) return null;
    return list.map(v => String(v).toLowerCase()).sort();
}

// Numeric when both sides parse as finite numbers ('0.25' == 0.25, '144' == 144),
// otherwise exact string compare. Mirrors the MIN_STAKE assert's spelling
// tolerance without letting an unparseable value pass as equal.
function sameScalar(a, b){
    let na = Number(a), nb = Number(b);
    if(Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '')
        return na === nb;
    return String(a) === String(b);
}

// Merge the canonical bundle with an operator overlay. Canonical is the base so
// every consensus key always has a value; the overlay contributes the local,
// non-consensus keys (BTC_RPC, POLL_MS, COLLECT_MS, ENABLED, ...) and, on a venue
// where divergence is only warned about, its own knobs.
function mergeWithCanonical(canonical, operator){
    let out = {};
    for(let k of consensusKeys(canonical)) out[k] = canonical[k];
    if(isPlainObject(operator))
        for(let k of Object.keys(operator)) if(k.charAt(0) !== '$') out[k] = operator[k];
    return out;
}

// Divergence of an operator override from the pinned coin bundle, one string per
// consensus key the override contradicts. Keys the bundle does not declare are
// local config and pass through unreported.
function diffCanonical(operator, canonical){
    let problems = [];
    if(!isPlainObject(operator) || !isPlainObject(canonical)) return problems;
    for(let key of consensusKeys(canonical)){
        if(!(key in operator)) continue;
        let mine = operator[key], theirs = canonical[key];
        if(Array.isArray(theirs) || Array.isArray(mine)){
            let a = normalizeVerifiers(mine), b = normalizeVerifiers(theirs);
            if(a === null || b === null || a.join(',') !== b.join(','))
                problems.push(key + ': configured ' + JSON.stringify(mine) +
                              ' vs canonical ' + JSON.stringify(theirs));
            continue;
        }
        if(!sameScalar(mine, theirs))
            problems.push(key + ': configured ' + JSON.stringify(mine) +
                          ' vs canonical ' + JSON.stringify(theirs));
    }
    return problems;
}

// Is the tier switched on? Activation is REWARD_SHARE > 0 and nothing else: that
// single value is what flips price.js from the single 'oracle_round' reward row
// to the two-tranche 'oracle_base' + 'oracle_full_node' split.
function isActive(fn){
    if(!isPlainObject(fn)) return false;
    let share = Number(fn.REWARD_SHARE);
    return Number.isFinite(share) && share > 0;
}

// Internal coherence of an EFFECTIVE (merged) block. Returns one string per
// problem; empty means the block is safe to run. Shape problems are reported on
// any block; the cross-knob deadlock checks only apply once the tier is active,
// because an inert tier never reads those windows.
function validateActivation(fn){
    let problems = [];
    if(!isPlainObject(fn)) return problems;

    if('REWARD_SHARE' in fn){
        let raw   = fn.REWARD_SHARE;
        let share = Number(raw);
        if(!Number.isFinite(share) || String(raw).trim() === '')
            problems.push('REWARD_SHARE is not a number: ' + JSON.stringify(raw) +
                          ' (price.js compares it against 0 and multiplies the round budget by it)');
        else if(share < 0 || share > 1)
            problems.push('REWARD_SHARE ' + JSON.stringify(raw) + ' is outside [0,1]; it is the FRACTION ' +
                          'of the oracle-round budget routed to verified full nodes, so >1 pays out more ' +
                          'than the round budget and <0 is meaningless');
    }

    for(let [key, bound] of Object.entries(INT_BOUNDS)){
        if(!(key in fn)) continue;
        let n = Number(fn[key]);
        if(!Number.isFinite(n) || !Number.isInteger(n))
            problems.push(key + ' is not an integer: ' + JSON.stringify(fn[key]));
        else if(n < bound.min || (bound.max !== undefined && n > bound.max))
            problems.push(key + ' ' + n + ' is outside [' + bound.min + ',' +
                          (bound.max !== undefined ? bound.max : '∞') + ']');
    }

    if('GENESIS_VERIFIERS' in fn){
        let list = fn.GENESIS_VERIFIERS;
        if(!Array.isArray(list)){
            problems.push('GENESIS_VERIFIERS must be an array of 64-hex Ed25519 pubkeys, got ' +
                          JSON.stringify(list));
        } else {
            let bad = list.filter(v => !HEX64.test(String(v)));
            if(bad.length)
                problems.push('GENESIS_VERIFIERS contains ' + bad.length + ' entr' +
                              (bad.length === 1 ? 'y' : 'ies') + ' that are not 64-hex Ed25519 pubkeys (' +
                              bad.map(v => JSON.stringify(String(v))).join(', ') +
                              '); the runtime SILENTLY DROPS them, so the bootstrap verifier set would be ' +
                              'smaller than intended and quorum would be computed over the wrong denominator');
            let seen = new Set(), dupes = new Set();
            for(let v of list){
                let k = String(v).toLowerCase();
                if(seen.has(k)) dupes.add(k); else seen.add(k);
            }
            if(dupes.size)
                problems.push('GENESIS_VERIFIERS has ' + dupes.size + ' duplicate entr' +
                              (dupes.size === 1 ? 'y' : 'ies') + ' (case-insensitive); the runtime dedupes ' +
                              'into a Set, so the verifier count is lower than the list suggests');
        }
    }

    if(!isActive(fn)) return problems;

    // ── activation deadlocks: only reachable once REWARD_SHARE > 0 ──
    let verifiers = Array.isArray(fn.GENESIS_VERIFIERS)
        ? fn.GENESIS_VERIFIERS.filter(v => HEX64.test(String(v))) : [];
    if(verifiers.length === 0)
        problems.push('REWARD_SHARE ' + JSON.stringify(fn.REWARD_SHARE) + ' activates the tier but ' +
                      'GENESIS_VERIFIERS is empty: the eligible-verifier set is (on-chain verified nodes ∪ ' +
                      'genesis verifiers) and the on-chain set starts empty, so no verdict can ever reach ' +
                      'quorum, nobody ever becomes verified, and the full-node tranche is unearnable');

    let interval = Number(fn.CHALLENGE_INTERVAL_BLOCKS);
    if(Number.isFinite(interval) && interval > 0){
        let proofWin = Number(fn.PROOF_WINDOW_BLOCKS);
        if(Number.isFinite(proofWin) && proofWin < interval)
            problems.push('PROOF_WINDOW_BLOCKS ' + proofWin + ' is shorter than CHALLENGE_INTERVAL_BLOCKS ' +
                          interval + ': verifier standing would lapse between consecutive challenges, ' +
                          'collapsing the verifier set back to GENESIS_VERIFIERS every epoch');
        let rewardWin = Number(fn.REWARD_PASS_WINDOW_BLOCKS);
        if(Number.isFinite(rewardWin) && rewardWin < interval)
            problems.push('REWARD_PASS_WINDOW_BLOCKS ' + rewardWin + ' is shorter than ' +
                          'CHALLENGE_INTERVAL_BLOCKS ' + interval + ': the trailing window contains no ' +
                          'challenge epoch, so the participation denominator is 0 and the tranche never pays');
    }

    return problems;
}

// One-line operator-facing summary of the effective block, for the boot log.
function describeActivation(fn){
    if(!isPlainObject(fn)) return 'INERT (no FULLNODE config)';
    if(!isActive(fn)) return 'INERT (REWARD_SHARE=' + String(fn.REWARD_SHARE === undefined ? '0' : fn.REWARD_SHARE) + ')';
    let n = Array.isArray(fn.GENESIS_VERIFIERS)
        ? fn.GENESIS_VERIFIERS.filter(v => HEX64.test(String(v))).length : 0;
    return 'ACTIVE (REWARD_SHARE=' + String(fn.REWARD_SHARE) + ', ' + n + ' genesis verifier' +
           (n === 1 ? '' : 's') + ')';
}

module.exports = {
    HEX64,
    consensusKeys,
    mergeWithCanonical,
    diffCanonical,
    validateActivation,
    describeActivation,
    isActive,
};
