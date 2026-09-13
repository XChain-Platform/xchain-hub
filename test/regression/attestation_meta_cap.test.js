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

const sinon               = require('sinon');
const { expect }          = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { createMockHub }    = require('../helpers/mockHub');

// -----------------------------------------------------------------
// REG-ATT-002: Incoming PROPOSE/PREPARE meta size cap
//
// Peer-supplied `meta` on ATTEST_PROPOSE / ATTEST_PREPARE must be
// rejected before decode/verify when it exceeds ATTEST_META_MAX_LENGTH
// (256 chars). meta is a short provider tag (HTTP status code, LLM model
// id); anything longer is adversarial padding that would otherwise be
// stored, hashed into the canonical, and re-broadcast unbounded. Mirrors
// the body_b64 cap (REG-ATT-001).
// -----------------------------------------------------------------

describe('Regression: Attestation meta size cap', function () {

    const PROVIDER_ID  = 'http_get';
    const MAX_RESP     = 32768;
    const META_MAX     = 256;                         // ATTEST_META_MAX_LENGTH
    const SENDER_PK    = 'cd'.repeat(32);

    let hub, consensus;

    beforeEach(function () {
        hub = createMockHub();
        let providerRegistry = {
            getDef:    sinon.stub().returns({ max_response_bytes: MAX_RESP }),
            getModule: sinon.stub().returns(null)
        };
        consensus = new AttestationConsensus(hub, providerRegistry);

        // Inject an active round whose responsible set admits SENDER_PK.
        consensus.pending.set('rid', {
            requestId:   'rid',
            providerId:  PROVIDER_ID,
            request:     { block_index: 0 },
            responsible: [{ pubkey: SENDER_PK }],
            proposals:   new Map(),
            prepares:    new Set(),
            signatures:  new Map(),
            winner:      null,
            finalized:   false
        });
    });

    afterEach(function () {
        for (let [, p] of consensus.pending) { if (p.timer) clearTimeout(p.timer); }
        sinon.restore();
    });

    // A legitimately-sized body so the meta guard is the only gate exercised.
    function envelope(type, metaLen) {
        return {
            type,
            data: {
                requestId:  'rid',
                providerId: PROVIDER_ID,
                body_b64:   'A'.repeat(16),
                meta:       'x'.repeat(metaLen),
                status:     'ok',
                sig_pubkey: SENDER_PK,
                sig:        'ee'.repeat(64)
            }
        };
    }

    describe('_handlePropose()', function () {
        it('rejects an oversized meta before decode/verify @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify');
            consensus._handlePropose(envelope('ATTEST_PROPOSE', META_MAX + 1));
            // Guard fires before signature verification and before storing.
            expect(verify.called).to.equal(false);
            expect(consensus.pending.get('rid').proposals.has(SENDER_PK)).to.equal(false);
        });

        it('lets a normal-size meta through to verification @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify').returns(false);
            consensus._handlePropose(envelope('ATTEST_PROPOSE', META_MAX));
            // Meta gate passed → signature verification was reached.
            expect(verify.calledOnce).to.equal(true);
        });
    });

    describe('_handlePrepare()', function () {
        it('rejects an oversized meta before decode/verify @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify');
            consensus._handlePrepare(envelope('ATTEST_PREPARE', META_MAX + 1));
            expect(verify.called).to.equal(false);
            expect(consensus.pending.get('rid').prepares.has(SENDER_PK)).to.equal(false);
        });

        it('lets a normal-size meta through to verification @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify').returns(false);
            consensus._handlePrepare(envelope('ATTEST_PREPARE', META_MAX));
            expect(verify.calledOnce).to.equal(true);
        });
    });
});
