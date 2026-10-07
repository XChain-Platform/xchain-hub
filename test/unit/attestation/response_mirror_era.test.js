/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * XChain Hub - the three ATTEST response mirror era readers agree.
 *
 * The publisher's early return, the mirror's era gate and consensus's
 * effective_time rule each decide the same era for a request. If the publisher
 * and the mirror disagree, a response is delivered twice or dropped; if
 * consensus disagrees with them, the round signs a canonical for one era while
 * delivery serves the other. This pins all three, on the REAL gate registry with
 * no stubs, to the one shared predicate, and pins that predicate to the row.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const gateRegistry = require('../../../src/consensus/gate_registry');
const { ATTEST_RESPONSE_MIRROR_KEY, isMirrorEraRequest } = require('../../../src/attestation/response_mirror_era.js');
const AttestationPublisher      = require('../../../src/attestation/publisher');
const AttestationResponseMirror = require('../../../src/attestation/response_mirror');
const AttestationConsensus      = require('../../../src/attestation/consensus');

const NETWORKS = ['regtest', 'testnet', 'mainnet'];
const SRC = path.resolve(__dirname, '../../../src/attestation');

// The activation height a network's row holds, read from the registry rather than copied here.
function threshold(network){
    return gateRegistry.get(ATTEST_RESPONSE_MIRROR_KEY)[network];
}

// Heights around the boundary plus the values a malformed request can carry.
function heightsFor(network){
    let t = threshold(network);
    let hs = [0, 1, 10000000, NaN, null, undefined];
    if (typeof t === 'number') hs.push(Math.max(0, t - 1), t, t + 1);
    return hs;
}

describe('ATTEST response mirror era: one predicate for publisher, mirror and consensus', () => {

    it('reads the activation row by the same key the registry carries', () => {
        expect(gateRegistry.has(ATTEST_RESPONSE_MIRROR_KEY)).to.equal(true);
    });

    for (const network of NETWORKS) {
        it(`follows the registry row on ${network}: on at and above the height, off below it and on an unarmed network`, () => {
            let t = threshold(network);
            if (typeof t !== 'number') {
                for (const h of heightsFor(network)) expect(isMirrorEraRequest(network, h), `h=${h}`).to.equal(false);
                return;
            }
            expect(isMirrorEraRequest(network, t)).to.equal(true);
            expect(isMirrorEraRequest(network, t + 1)).to.equal(true);
            if (t > 0) expect(isMirrorEraRequest(network, t - 1)).to.equal(false);
        });

        it(`gives the mirror, consensus and the publisher the same answer on ${network} at every height`, () => {
            let self = { hub: { network } };
            for (const h of heightsFor(network)) {
                let want = isMirrorEraRequest(network, h);
                expect(AttestationResponseMirror.prototype.isMirrorEra.call(self, h), `mirror h=${h}`).to.equal(want);
                expect(AttestationConsensus.prototype.isMirrorEra.call(self, h), `consensus h=${h}`).to.equal(want);
                // The publisher converts block_index with Number() before it asks, so compare on that value.
                let skipped = AttestationPublisher.prototype.finalizedEventSkipped.call(
                    { enabled: true, hub: { network } },
                    { requestId: 'ab'.repeat(32), request: { block_index: h } });
                expect(skipped, `publisher h=${h}`).to.equal(isMirrorEraRequest(network, Number(h)));
            }
        });
    }

    it('leaves no reader that asks the registry for the mirror row directly', () => {
        for (const rel of ['response_mirror.js', 'consensus/effective_time.js', 'publisher/on_finalized.js']) {
            let text = fs.readFileSync(path.join(SRC, rel), 'utf8');
            expect(text, rel).to.not.include(ATTEST_RESPONSE_MIRROR_KEY);
            expect(text, rel).to.not.match(/\bactiveAt\(/);
            expect(text, rel).to.match(/require\('\.{1,2}\/(\.\.\/)?response_mirror_era\.js'\)/);
        }
    });
});
