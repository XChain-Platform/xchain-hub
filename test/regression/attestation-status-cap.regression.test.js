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

const sinon                = require('sinon');
const { expect }           = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { createMockHub }    = require('../helpers/mockHub');

// -----------------------------------------------------------------
// REG-ATT-003: Incoming PROPOSE/PREPARE status size cap
//
// Peer-supplied `status` sits in exactly the position `meta` does: it is
// hashed into the canonical, stored verbatim in the round state for the
// round's lifetime, and concatenated into the A-F4 prepareCandidates key.
// Legitimate values are three short literals ('ok', 'provider_error',
// 'no_quorum'), so it must be capped before decode/verify at the same
// ATTEST_META_MAX_LENGTH the meta field gets (REG-ATT-002).
// -----------------------------------------------------------------

describe('Regression: Attestation status size cap', function () {

    const PROVIDER_ID  = 'http_get';
    const MAX_RESP     = 32768;
    const STATUS_MAX   = 256;                         // ATTEST_META_MAX_LENGTH
    const SENDER_PK    = 'cd'.repeat(32);

    let hub, consensus, warns;

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

        warns = [];
        sinon.stub(console, 'warn').callsFake((m) => warns.push(String(m)));
    });

    afterEach(function () {
        for (let [, p] of consensus.pending) { if (p.timer) clearTimeout(p.timer); }
        sinon.restore();
    });

    // A legitimately-sized body and meta so the status guard is the only new gate.
    function envelope(type, statusLen) {
        return {
            type,
            data: {
                requestId:  'rid',
                providerId: PROVIDER_ID,
                body_b64:   'A'.repeat(16),
                meta:       'm',
                status:     'x'.repeat(statusLen),
                sig_pubkey: SENDER_PK,
                sig:        'ee'.repeat(64)
            }
        };
    }

    describe('_handlePropose()', function () {
        it('rejects an oversized status before decode/verify @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify');
            consensus._handlePropose(envelope('ATTEST_PROPOSE', STATUS_MAX + 1));
            // Guard fires before signature verification and before storing.
            expect(verify.called).to.equal(false);
            expect(consensus.pending.get('rid').proposals.has(SENDER_PK)).to.equal(false);
            expect(warns.some(m => m.indexOf('oversized PROPOSE status') !== -1)).to.equal(true);
        });

        it('lets a max-length status through to verification @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify').returns(false);
            consensus._handlePropose(envelope('ATTEST_PROPOSE', STATUS_MAX));
            // Status gate passed -> signature verification was reached.
            expect(verify.calledOnce).to.equal(true);
            expect(warns.some(m => m.indexOf('oversized') !== -1)).to.equal(false);
        });
    });

    describe('_handlePrepare()', function () {
        it('rejects an oversized status before decode/verify @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify');
            consensus._handlePrepare(envelope('ATTEST_PREPARE', STATUS_MAX + 1));
            expect(verify.called).to.equal(false);
            expect(consensus.pending.get('rid').prepares.has(SENDER_PK)).to.equal(false);
            expect(warns.some(m => m.indexOf('oversized PREPARE status') !== -1)).to.equal(true);
        });

        it('lets a max-length status through to the non-ok gates @regression-p0', function () {
            let verify = sinon.stub(ValidatorIdentity, 'verify').returns(false);
            consensus._handlePrepare(envelope('ATTEST_PREPARE', STATUS_MAX));
            // Past the size gate: the envelope now dies on the non-ok canonical-shape
            // check (non-empty body/meta), which is the next gate downstream.
            expect(warns.some(m => m.indexOf('oversized') !== -1)).to.equal(false);
            expect(warns.some(m => m.indexOf('non-canonical body/meta') !== -1)).to.equal(true);
            expect(verify.called).to.equal(false);
        });
    });
});
