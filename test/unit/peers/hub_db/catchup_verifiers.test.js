'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

function freshRegistry() {
    return proxyquire('../../../../src/peers/hub_db/catchup_verifiers.js', {});
}

describe('hub DB catch-up verifier registry', function () {
    it('names all eleven mirrored tables', function () {
        const registry = freshRegistry();
        expect(registry.MIRRORED_TABLES).to.have.lengthOf(11);
        expect(new Set(registry.MIRRORED_TABLES).size).to.equal(11);
    });

    it('registers one verifier and refuses unknown or duplicate registrations', function () {
        const registry = freshRegistry();
        const verifier = () => true;
        expect(registry.registerCatchupVerifier('price_snapshots', verifier)).to.equal(verifier);
        expect(registry.getCatchupVerifier('price_snapshots')).to.equal(verifier);
        expect(() => registry.registerCatchupVerifier('price_snapshots', verifier)).to.throw('already registered');
        expect(() => registry.registerCatchupVerifier('not_a_mirror', verifier)).to.throw('Unknown');
        expect(() => registry.getCatchupVerifier('not_a_mirror')).to.throw('Unknown');
    });
});
