'use strict';

// Cross-service conformance guard (item 4535). The stake-weighted quorum
// predicate and the equivocation-header builder are hand-copied across five
// services in three bignum dialects; a divergence in their logic forks the
// chain. These vectors are the single source of truth (xchain-documentation/
// protocol/test-vectors); every repo runs them against its own local copy so
// behavioral drift is machine-detectable. When the sibling documentation repo
// is not checked out (standalone deploy), skip rather than fail, matching the
// existing cross-repo guard convention.

const assert = require('assert');

const swq   = require('../../src/stake_weighted_quorum.js');
const equiv = require('../../src/equivocation_header.js');

let quorumVec = null, equivVec = null;
try {
    quorumVec = require('../../../xchain-documentation/protocol/test-vectors/stake_weighted_quorum.json');
    equivVec  = require('../../../xchain-documentation/protocol/test-vectors/equivocation_header.json');
} catch(e){ /* sibling xchain-documentation absent */ }

// Per-repo adapter: the hub copy is meetsStakeThreshold(validators, signerPubkeys)
// and is the only copy that also exports totalStake().
function meets(c){ return swq.meetsStakeThreshold(c.validators, c.signers); }
const HAS_TOTAL_STAKE = true;

describe('consensus-primitive conformance: canonical vectors @regression', function(){
    before(function(){ if(!quorumVec || !equivVec) this.skip(); });

    describe('stake_weighted_quorum.meetsStakeThreshold', function(){
        (quorumVec ? quorumVec.meetsStakeThreshold : []).forEach(function(c){
            it(c.name, function(){ assert.strictEqual(meets(c), c.expected); });
        });
    });

    if(HAS_TOTAL_STAKE){
        describe('stake_weighted_quorum.totalStake', function(){
            (quorumVec ? quorumVec.totalStake : []).forEach(function(c){
                it(c.name, function(){
                    if(c.throws) assert.throws(() => swq.totalStake(c.validators));
                    else assert.strictEqual(String(swq.totalStake(c.validators)), c.expected);
                });
            });
        });
    }

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
