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

// Cross-service conformance guard (item 4535). The stake-weighted quorum
// predicate and the equivocation-header builder are CONSENSUS-CRITICAL and
// vendored byte-identically into five services (xchain-hub, xchain-indexer,
// xchain-explorer, xchain-sdk, xchain-sync); a divergence in their logic forks
// the chain. Their canonical source of record is xchain-indexer/src/consensus,
// which reconcile-twins.sh vendors into every other copy, including
// xchain-documentation/protocol/reference-impl/consensus; the canonical vectors
// live in xchain-documentation/protocol/test-vectors. This guard runs in every
// repo and asserts BOTH:
//   1. BEHAVIOR  - the local copy matches the canonical vectors.
//   2. IDENTITY  - the local copy is byte-identical to the xchain-documentation copy.
// (1) catches a logic change that happens to pass the local unit suite; (2)
// catches ANY edit to one copy that was not propagated to the others. When the
// sibling xchain-documentation repo is not checked out (standalone deploy), skip
// rather than fail, matching the existing cross-repo guard convention.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const swq   = require('../../../src/consensus/stake_weighted_quorum.js');
const equiv = require('../../../src/consensus/equivocation_header.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const LOCAL_DIR = path.join(__dirname, '..', '..', '..', 'src');
// Resolve the canonical xchain-documentation repo. Prefer an explicit path: GitHub CI
// sets XCHAIN_DOCS_DIR to wherever it checked the sibling out, because actions/checkout
// cannot write a path above the job workspace (the dev/bin/ci-all.sh sibling layout is
// one level above each repo). Fall back to that sibling layout for local + dev runs.
// When neither resolves (standalone deploy), the guards below skip rather than fail.
const DOCS_DIR  = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation');
const CANON_DIR = path.join(DOCS_DIR, 'protocol', 'reference-impl');
const VEC_DIR   = path.join(DOCS_DIR, 'protocol', 'test-vectors');
// Judge the vector directory before loading it, so a lane whose documentation entry
// links into a live main checkout never reads behaviour vectors no commit holds.
const VEC_VERDICT = siblingCheckout(__dirname, VEC_DIR);
// The registry parts this hub authors alone; every other part is shared with the reference impl.
const HUB_ONLY_PARTS = ['hub_rows.js'];
const HUB_SHARED_PARTS = registryParts(LOCAL_DIR).filter((f) => !HUB_ONLY_PARTS.includes(f));

let quorumVec = null, equivVec = null, activationVec = null;
if(VEC_VERDICT.usable){
    try {
        quorumVec     = require(path.join(VEC_DIR, 'stake_weighted_quorum.json'));
        equivVec      = require(path.join(VEC_DIR, 'equivocation_header.json'));
        activationVec = require(path.join(VEC_DIR, 'activation_predicates.json'));
    } catch(e){ /* sibling xchain-documentation absent */ }
}

// Every copy now shares ONE signature: meetsStakeThreshold(validators, signers),
// and every copy exports totalStake(). No per-repo adapter remains.
// A vector may carry `truncated: true` to exercise the fail-closed-on-truncation
// guard; JSON can't attach the `truncated` property to an array literal, so apply it
// onto a copy of the validators array here (the real set-building query sets it the
// same way on its returned array).
function vecValidators(c){
    if(c && c.truncated){ let v = (c.validators || []).slice(); v.truncated = true; return v; }
    return c.validators;
}
function meets(c){ return swq.meetsStakeThreshold(vecValidators(c), c.signers); }

describe('consensus-primitive conformance: canonical vectors @regression', function(){
    before(function(){ if(!skipOrFail(this, VEC_VERDICT, 'the consensus test-vector guard')) return; if(!quorumVec || !equivVec){ if(process.env.XCHAIN_REQUIRE_SIBLINGS==='1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but consensus test-vectors not found (sibling xchain-documentation missing)'); this.skip(); } });

    describe('stake_weighted_quorum.meetsStakeThreshold', function(){
        (quorumVec ? quorumVec.meetsStakeThreshold : []).forEach(function(c){
            it(c.name, function(){ assert.strictEqual(meets(c), c.expected); });
        });
    });

    describe('stake_weighted_quorum.totalStake', function(){
        (quorumVec ? quorumVec.totalStake : []).forEach(function(c){
            it(c.name, function(){
                if(c.throws) assert.throws(() => swq.totalStake(vecValidators(c)));
                else assert.strictEqual(String(swq.totalStake(vecValidators(c))), c.expected);
            });
        });
    });

    describe('equivocation_header builder', function(){
        it('ENGINE_TAGS matches the canonical map', function(){
            assert.deepStrictEqual(equiv.ENGINE_TAGS, equivVec.engineTags);
        });
        (equivVec ? equivVec.equivKey : []).forEach(function(c){
            it('equivKey: ' + c.name, function(){
                assert.strictEqual(equiv.equivKey(c.engineTag, c.roundId, c.view), c.expected);
            });
        });
        (equivVec ? equivVec.equivPrefix : []).forEach(function(c){
            it('equivPrefix: ' + c.name, function(){
                assert.strictEqual(equiv.equivPrefix(c.key), c.expected);
            });
        });
        (equivVec ? equivVec.buildEquivCanonical : []).forEach(function(c){
            it('buildEquivCanonical: ' + c.name, function(){
                assert.strictEqual(equiv.buildEquivCanonical(c.engineTag, c.roundId, c.view, c.content), c.expected);
            });
        });
    });
});

// JSON cannot carry NaN or undefined, so the corpus spells them {special:'nan'|'undefined'}.
function decodeSnapshotBlock(v){
    if(v === null || typeof v !== 'object') return v;
    if(v.special === 'nan') return NaN;
    if(v.special === 'undefined') return undefined;
    throw new Error('unknown special snapshotBlock: ' + JSON.stringify(v));
}

// The activation boundaries run through THIS repo's carriers
// and so through its own gate registry, which byte identity alone never reaches.
describe('consensus-primitive conformance: activation predicate vectors @regression', function(){
    const srb = require('../../../src/consensus/snapshot_reorg_buffer.js');
    before(function(){ if(!skipOrFail(this, VEC_VERDICT, 'the activation predicate vector guard')) return; if(!activationVec){ if(process.env.XCHAIN_REQUIRE_SIBLINGS==='1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but activation_predicates.json not found (sibling xchain-documentation missing)'); this.skip(); } });
    const groups = activationVec || {};

    it('every group this repo runs is a non-empty list', function(){
        for(const g of ['isStakeWeightedQuorumActive', 'isEquivHeaderActive', 'snapshotBurial'])
            assert.ok(Array.isArray(groups[g]) && groups[g].length > 0, g + ' is missing or empty');
    });
    (groups.isStakeWeightedQuorumActive || []).forEach(function(c){
        it('isStakeWeightedQuorumActive: ' + c.name, function(){
            assert.strictEqual(swq.isStakeWeightedQuorumActive(decodeSnapshotBlock(c.snapshotBlock), c.network), c.expected);
        });
    });
    (groups.isEquivHeaderActive || []).forEach(function(c){
        it('isEquivHeaderActive: ' + c.name, function(){
            assert.strictEqual(equiv.isEquivHeaderActive(decodeSnapshotBlock(c.snapshotBlock), c.network), c.expected);
        });
    });
    (groups.snapshotBurial || []).forEach(function(c){
        it('snapshotBurial: ' + c.name, function(){
            const sb = decodeSnapshotBlock(c.snapshotBlock);
            assert.strictEqual(srb.isSnapshotBurialActive(sb, c.network), c.active);
            assert.deepStrictEqual(srb.buriedSnapshotBlock(sb, c.network), decodeSnapshotBlock(c.buriedSnapshotBlock));
        });
    });
});

describe('consensus-primitive conformance: byte-identity to canonical source @regression', function(){
    before(function(){
        if (!skipOrFail(this, siblingCheckout(__dirname, CANON_DIR), 'the sibling parity guard')) return;
    });

    // The three carriers sit under consensus/ on both sides since W5 (the same tail in
    // every repo), so the compare is a raw byte compare; a canonical copy not yet at
    // that path skips here and fails under XCHAIN_REQUIRE_SIBLINGS=1.
    ['stake_weighted_quorum.js', 'equivocation_header.js', 'snapshot_reorg_buffer.js'].forEach(function(f){
        it(f + ' is byte-identical to xchain-documentation/protocol/reference-impl/consensus', function(){
            const canonPath = path.join(CANON_DIR, 'consensus', f);
            if (!skipOrFail(this, siblingCheckout(__dirname, canonPath), 'the sibling parity guard')) return;
            const local = fs.readFileSync(path.join(LOCAL_DIR, 'consensus', f), 'utf8');
            const canon = fs.readFileSync(canonPath, 'utf8');
            assert.strictEqual(local, canon,
                'this repo\'s consensus/' + f + ' has drifted from the canonical source; ' +
                'edit xchain-indexer/src/consensus/' + f + ' and re-run reconcile-twins.sh to re-vendor every copy.');
        });
    });

    // Compare the activation-registry parts too: this repo owns gate_registry/core.js, so
    // an unpropagated edit to it must turn this suite red, not only the consumers' suites
    // that read the reference copy. hub_rows.js is authored here alone and has no copy.
    it('gate_registry/ holds core.js and the vendored parts', function(){
        assert.ok(HUB_SHARED_PARTS.includes('core.js'),
            'src/consensus/gate_registry/ has no core.js, so the per-part byte guard would miss the part this repo owns');
    });

    it('gate_registry/ file set equals xchain-documentation/protocol/reference-impl', function(){
        const canonDir = path.join(CANON_DIR, 'consensus', 'gate_registry');
        if (!skipOrFail(this, siblingCheckout(__dirname, canonDir), 'the sibling parity guard')) return;
        const canon = registryParts(CANON_DIR);
        assert.ok(canon.length > 0, 'the canonical gate_registry/ under ' + CANON_DIR + ' is missing or empty');
        const missing = canon.filter((f) => !HUB_SHARED_PARTS.includes(f));
        const extra   = HUB_SHARED_PARTS.filter((f) => !canon.includes(f));
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
            'gate_registry/ file sets differ. Missing from this repo: [' + missing.join(', ') +
            ']. Present only in this repo: [' + extra.join(', ') +
            ']. Vendor the part with reconcile-twins.sh, or list a hub-only part in HUB_ONLY_PARTS.');
    });

    HUB_SHARED_PARTS.forEach(function(f){
        it('gate_registry/' + f + ' is byte-identical to xchain-documentation/protocol/reference-impl', function(){
            const canonPath = path.join(CANON_DIR, 'consensus', 'gate_registry', f);
            if (!skipOrFail(this, siblingCheckout(__dirname, canonPath), 'the sibling parity guard')) return;
            const local = fs.readFileSync(path.join(LOCAL_DIR, 'consensus', 'gate_registry', f), 'utf8');
            const canon = fs.readFileSync(canonPath, 'utf8');
            assert.strictEqual(local, canon, gateRegistryDriftMessage(f));
        });
    });
});

/** List the regular .js files of one side's consensus/gate_registry/, sorted; empty when absent. */
function registryParts(root){
    const dir = path.join(root, 'consensus', 'gate_registry');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.js')).map((d) => d.name).sort();
}

/** Name the file to edit for a drifted part: core.js is owned here, the rest by the indexer. */
function gateRegistryDriftMessage(f){
    if (f === 'core.js') {
        return 'this repo owns consensus/gate_registry/core.js and it differs from ' +
            'xchain-documentation/protocol/reference-impl/consensus/gate_registry/core.js; ' +
            'run reconcile-twins.sh --write to carry the edit to every copy, or revert it.';
    }
    return 'this repo\'s consensus/gate_registry/' + f + ' has drifted from the canonical source; ' +
        'edit xchain-indexer/src/protocol_changes/' + f + ' and re-run reconcile-twins.sh to re-vendor every copy.';
}
