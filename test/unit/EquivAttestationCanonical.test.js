'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header (WI-2 bump 2) — attestation (XATTEST) round-trip.
// CONSENSUS-CRITICAL: the attestation canonical is a UTF-8 Buffer
// (request_id || provider_id || sha256(body) || status || meta). The hub
// (AttestationConsensus._buildCanonical) and the on-chain verifier
// (indexer actions/attest.js) MUST produce byte-identical bytes. XATTEST has
// no view change (VIEW=0); the gate keys on the REQUEST's block (deterministic
// from request_id, NOT in the content) + network, so both sides flip identically.
const { expect } = require('chai');
const crypto = require('crypto');
const eq  = require('../../src/equivocation_header.js');
const AttestationConsensus = require('../../src/AttestationConsensus.js');

function mockHub(network){
    return { network: network, getPeerManager: () => ({}), db: {}, getIdentity: () => null, p2pConfig: {} };
}

const RID = 'abc123', PROVIDER = 'prov1', BODY = Buffer.from('hello', 'utf8'), STATUS = 'ok', META = 'm1';
function rawStr(){
    const h = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
    return String(RID) + String(PROVIDER) + h + String(STATUS) + String(META);
}

describe('EQUIV attestation canonical (WI-2 bump 2)', function () {

    it('below the flag-day (mainnet) → bare bytes (regression-safe)', function () {
        const c = new AttestationConsensus(mockHub('mainnet'));
        expect(c._buildCanonical(RID, PROVIDER, BODY, STATUS, META, 5).toString('utf8')).to.equal(rawStr());
    });

    it('at/above the flag-day (regtest) → header-wrapped Buffer (TAG=XATTEST, ROUND_ID=request_id, VIEW=0)', function () {
        const c = new AttestationConsensus(mockHub('regtest'));
        const out = c._buildCanonical(RID, PROVIDER, BODY, STATUS, META, 480);
        expect(Buffer.isBuffer(out)).to.equal(true);
        expect(out.toString('utf8')).to.equal('EQUIV|XATTEST|' + RID + '|0||' + rawStr());
    });

    it('undefined requestBlock (no request in scope) → gate OFF (bare bytes)', function () {
        const c = new AttestationConsensus(mockHub('regtest'));
        expect(c._buildCanonical(RID, PROVIDER, BODY, STATUS, META, undefined).toString('utf8')).to.equal(rawStr());
    });

    it('matches buildEquivCanonical(XATTEST, request_id, 0, raw) — indexer twin parity', function () {
        const c = new AttestationConsensus(mockHub('regtest'));
        const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RID, 0, rawStr());
        expect(c._buildCanonical(RID, PROVIDER, BODY, STATUS, META, 480).toString('utf8')).to.equal(expected);
    });
});
