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

// Ledger P60. AttestationRound's leader rotation skips a slot only once it can
// prove the member never spoke for the request, and `pending.proposals` cannot
// answer that: a round timeout deletes `pending` outright while the request runs
// on across retries, so every retry started from a blank sheet and the ladder
// froze on the mute slot forever. `proposerSeen` is the record that outlives the
// teardown.

const sinon                = require('sinon');
const { expect }           = require('chai');
const AttestationConsensus = require('../../src/AttestationConsensus');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const { createMockHub }    = require('../helpers/mockHub');

function mkIdentity() {
    return new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
}
function pub(id) { return id.getPubkeyHex().toLowerCase(); }

function makeProviderRegistry() {
    return {
        getDef:    sinon.stub().returns(null),
        getModule: sinon.stub().returns(null)
    };
}

describe('AttestationConsensus: cross-round proposer record (P60)', function () {

    let hub, consensus, me, live, mute, pending;
    const RID  = 'ab'.repeat(16);
    const BODY = Buffer.from('a-body');

    function proposeEnvelope(signer) {
        let canonical = consensus._buildCanonical(RID, 'http_get', BODY, 'ok', '', 0, null).toString('utf8');
        return {
            type: 'ATTEST_PROPOSE',
            data: {
                requestId:  RID,
                providerId: 'http_get',
                body_b64:   BODY.toString('base64'),
                meta:       '',
                status:     'ok',
                sig_pubkey: pub(signer),
                sig:        signer.sign(canonical)
            }
        };
    }

    beforeEach(function () {
        hub       = createMockHub();
        consensus = new AttestationConsensus(hub, makeProviderRegistry());
        me   = mkIdentity();
        live = mkIdentity();
        mute = mkIdentity();

        pending = {
            requestId:    RID,
            request:      { request_id: 'req', block_index: 0 },
            providerId:   'http_get',
            redundancy:   3,
            quorum:       3,
            mirrorEra:    false,
            responsible:  [{ pubkey: pub(me) }, { pubkey: pub(live) }, { pubkey: pub(mute) }],
            proposals:    new Map(),
            prepares:     new Set(),
            commits:      new Set(),
            signatures:   new Map(),
            winner:       null,
            status:       'ok',
            myPubkey:     pub(me),
            leaderPubkey: pub(me),
            role:         'leader',
            finalized:    false,
            timer:        null
        };
        consensus.pending.set(RID, pending);
    });

    afterEach(function () {
        for (let [, p] of consensus.pending) { if (p.timer) clearTimeout(p.timer); }
        sinon.restore();
    });

    it('records an accepted PROPOSE and reads it back per request and pubkey', function () {
        consensus._handlePropose(proposeEnvelope(live));
        expect(consensus.hasProposedFor(RID, pub(live))).to.be.true;
        expect(consensus.hasProposedFor(RID, pub(mute))).to.be.false;
        expect(consensus.hasProposedFor('cd'.repeat(16), pub(live))).to.be.false;
    });

    it('survives the round teardown a timeout performs', function () {
        consensus._handlePropose(proposeEnvelope(live));
        // What the round-timeout handler does to a stalled round.
        consensus.pending.delete(RID);
        consensus.earlyMessages.delete(RID);
        consensus._markTornDown(RID);

        expect(consensus.pending.has(RID)).to.be.false;
        expect(consensus.hasProposedFor(RID, pub(live)), 'the retry round lost the evidence').to.be.true;
        expect(consensus.hasProposedFor(RID, pub(mute))).to.be.false;
    });

    it('does not record a PROPOSE it rejects', function () {
        let env = proposeEnvelope(mute);
        env.data.sig = 'ff'.repeat(64);            // bad signature
        consensus._handlePropose(env);
        expect(consensus.hasProposedFor(RID, pub(mute))).to.be.false;

        // Nor one from outside the responsible set.
        let outsider = mkIdentity();
        consensus._handlePropose(proposeEnvelope(outsider));
        expect(consensus.hasProposedFor(RID, pub(outsider))).to.be.false;
    });

    it('reads a case-folded pubkey and rid the same way', function () {
        consensus._handlePropose(proposeEnvelope(live));
        expect(consensus.hasProposedFor(RID.toUpperCase(), pub(live).toUpperCase())).to.be.true;
    });

    it('is ring-bounded FIFO so requestId flooding cannot grow it', function () {
        let c = new AttestationConsensus(
            createMockHub({ p2pConfig: { ATTESTATION_PROPOSER_SEEN_MAX: '2' } }), makeProviderRegistry());
        c._recordProposer('r1', pub(live));
        c._recordProposer('r2', pub(live));
        c._recordProposer('r3', pub(live));
        expect(c.proposerSeen.size).to.equal(2);
        expect(c.hasProposedFor('r1', pub(live))).to.be.false;
        expect(c.hasProposedFor('r3', pub(live))).to.be.true;
    });

    it('clears the record on stop()', async function () {
        consensus._handlePropose(proposeEnvelope(live));
        await consensus.stop();
        expect(consensus.proposerSeen.size).to.equal(0);
        expect(consensus.hasProposedFor(RID, pub(live))).to.be.false;
    });
});
