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
// REG-ATT-001: Incoming PROPOSE/PREPARE body_b64 size cap
//
// Peer-supplied body_b64 on ATTEST_PROPOSE / ATTEST_PREPARE must be
// rejected before Buffer allocation when it exceeds the provider's
// configured max_response_bytes (×1.4 base64 expansion). The only
// transport gate is the ~1 MB WebSocket frame limit — far larger than
// any legitimate provider response — so without this application-level
// check a responsible peer could force multi-hundred-KB allocations per
// message and sustain memory-amplification pressure on the hub.
// -----------------------------------------------------------------

describe('Regression: Attestation body_b64 size cap', function () {

    const PROVIDER_ID  = 'http_get';
    const MAX_RESP     = 32768;
    const MAX_B64      = Math.ceil(MAX_RESP * 1.4);   // 45876
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

    function envelope(type, b64Len) {
        return {
            type,
            data: {
                requestId:  'rid',
                providerId: PROVIDER_ID,
                body_b64:   'A'.repeat(b64Len),
                meta:       '',
                status:     'ok',
                sig_pubkey: SENDER_PK,
                sig:        'ee'.repeat(64)
            }
        };
    }

    describe('_maxBodyB64Length()', function () {
        it('derives the cap from max_response_bytes ×1.4 @regression-p1', function () {
            expect(consensus._maxBodyB64Length(PROVIDER_ID)).to.equal(MAX_B64);
        });

        it('falls back to a 64 KB cap when the provider def is missing @regression-p1', function () {
            consensus.providerRegistry.getDef.returns(null);
            expect(consensus._maxBodyB64Length('unknown')).to.equal(Math.ceil(65536 * 1.4));
        });
    });

    describe('_handlePropose()', function () {
        it('rejects an oversized body before decode/verify @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify');
            consensus._handlePropose(envelope('ATTEST_PROPOSE', MAX_B64 + 1));
            // Guard fires before signature verification and before storing.
            expect(verify.called).to.equal(false);
            expect(consensus.pending.get('rid').proposals.has(SENDER_PK)).to.equal(false);
        });

        it('lets a legitimately-sized body through to verification @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify').returns(false);
            consensus._handlePropose(envelope('ATTEST_PROPOSE', MAX_B64));
            // Size gate passed → signature verification was reached.
            expect(verify.calledOnce).to.equal(true);
        });
    });

    describe('_handlePrepare()', function () {
        it('rejects an oversized body before decode/verify @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify');
            consensus._handlePrepare(envelope('ATTEST_PREPARE', MAX_B64 + 1));
            expect(verify.called).to.equal(false);
            expect(consensus.pending.get('rid').prepares.has(SENDER_PK)).to.equal(false);
        });

        it('lets a legitimately-sized body through to verification @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify').returns(false);
            consensus._handlePrepare(envelope('ATTEST_PREPARE', MAX_B64));
            expect(verify.calledOnce).to.equal(true);
        });
    });
});
