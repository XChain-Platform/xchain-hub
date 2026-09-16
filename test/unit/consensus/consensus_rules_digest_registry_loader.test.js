/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/consensus/consensus_rules_digest_registry_loader.test.js
 *
 * The rules digest reads every shared gate VALUE from the activation
 * registry by key and THROWS on a miss (decision D40). Pinned here: every
 * value the digest publishes is the registry row of the same key, the four
 * function-valued names come from their carrier and canonicalise as they
 * always did, and a row the registry lacks takes the digest, the signed GATES
 * field and the active set down naming the key, where it used to read ABSENT.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const crd      = require('../../../src/consensus_rules_digest.js');
const registry = require('../../../src/consensus/gate_registry.js');

const CRD = require.resolve('../../../src/consensus_rules_digest.js');
const REG = require.resolve('../../../src/consensus/gate_registry.js');

// A fresh digest module whose registry answers `key` by throwing the miss. The
// carriers are never touched; the module-level value cache is what is cleared.
function freshDigestMissing(key) {
    const realReg = require.cache[REG];
    const realCrd = require.cache[CRD];
    const stub = Object.create(Object.getPrototypeOf(realReg));
    Object.assign(stub, realReg);
    stub.exports = Object.assign({}, realReg.exports, {
        get: (k) => { if (k === key) throw new registry.RegistryMissError(k); return realReg.exports.get(k); },
    });
    require.cache[REG] = stub;
    delete require.cache[CRD];
    try {
        return require('../../../src/consensus_rules_digest.js');
    } finally {
        require.cache[REG] = realReg;
        require.cache[CRD] = realCrd;
    }
}

describe('consensus_rules_digest: values by registry key', function () {

    it('publishes, for every shared gate that is a row, exactly the canonical form of that row', function () {
        const { gates } = crd.computeConsensusRulesDigest();
        let rows = 0;
        for (const [mod, names] of crd.SHARED_GATES) {
            for (const name of names) {
                const key = mod + '.' + name;
                if (!registry.has(key)) continue;
                rows += 1;
                expect(gates[key], key).to.equal(crd.canonical(registry.get(key)));
            }
        }
        expect(rows, 'the digest rows the registry supplies').to.equal(29);
        expect(Object.keys(gates).length, 'every SHARED_GATES name is a digest key').to.equal(33);
    });

    it('reads the four function-valued names from their carrier, canonicalising to no value, as before', function () {
        const { gates } = crd.computeConsensusRulesDigest();
        const carrier = require('../../../src/mirror_admission_activation.js');
        for (const name of ['encodeAdmitBlocks', 'decodeAdmitBlocks', 'isAdmissionEra', 'admissionCanonicalField']) {
            const key = 'mirror_admission_activation.' + name;
            expect(registry.has(key), key + ' is not a row').to.equal(false);
            expect(typeof carrier[name]).to.equal('function');
            expect(gates[key], key).to.equal(undefined);
            expect(Object.prototype.hasOwnProperty.call(gates, key), key + ' is still a digest key').to.equal(true);
        }
    });

    it('reads no gate as ABSENT in this build', function () {
        const { gates } = crd.computeConsensusRulesDigest();
        expect(Object.keys(gates).filter((k) => gates[k] === crd.ABSENT)).to.deep.equal([]);
    });
});

describe('consensus_rules_digest: a registry miss', function () {

    const KEY = 'attest_relay_activation.ATTEST_RELAY_ACTIVATION';

    it('takes the digest, the GATES field and the active set down naming the key, never ABSENT', function () {
        const fresh = freshDigestMissing(KEY);
        expect(() => fresh.computeConsensusRulesDigest()).to.throw(registry.RegistryMissError, KEY);
        expect(() => fresh.knownGateKeys()).to.throw(KEY);
        expect(() => fresh.activeGatesAt(0, 'regtest')).to.throw(KEY);
    });

    it('leaves the shipped module untouched: the digest still reads the pinned value afterwards', function () {
        expect(crd.computeConsensusRulesDigest().gates[KEY]).to.equal(crd.canonical(registry.get(KEY)));
        expect(crd.knownGateKeys().length).to.equal(33);
    });
});
