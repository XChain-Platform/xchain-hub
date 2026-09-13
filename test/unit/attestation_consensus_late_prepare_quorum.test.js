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

// Regression for the lost-COMMIT / late-PREPARE stall: after this node has
// broadcast its COMMIT (_commitSent=true), a late PREPARE whose signature
// crosses the commit quorum must finalize the round. Before the fix,
// _handlePrepare stored the sig but only called _checkPrepareQuorum (which
// short-circuits on _commitSent), so _checkCommitQuorum never re-ran and a
// fully-quorate round sat until the round timeout discarded the work.

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

describe('AttestationConsensus: late PREPARE completes commit quorum after COMMIT sent', function () {

    let hub, consensus, me, peerB, peerC, pending;
    const RID  = 'ab'.repeat(16); // 32 hex chars
    const BODY = Buffer.from('winning-body');

    beforeEach(function () {
        hub       = createMockHub();
        consensus = new AttestationConsensus(hub, makeProviderRegistry());
        me    = mkIdentity();
        peerB = mkIdentity();
        peerC = mkIdentity();

        // Canonical bytes every co-signer signs over (built by the engine so
        // the equiv-header gating matches exactly).
        let canonical = consensus._buildCanonical(RID, 'http_get', BODY, 'ok', '', 0).toString('utf8');

        // A round with the winner established, this node already committed
        // (_commitSent=true), holding 2 of 3 required verifying signatures.
        pending = {
            request:      { request_id: 'req', block_index: 0 },
            providerId:   'http_get',
            redundancy:   3,
            quorum:       3,
            responsible:  [{ pubkey: pub(me) }, { pubkey: pub(peerB) }, { pubkey: pub(peerC) }],
            commits:      new Set([pub(me), pub(peerB)]),
            prepares:     new Set([pub(me), pub(peerB)]),
            signatures:   new Map([
                [pub(me),    me.sign(canonical)],
                [pub(peerB), peerB.sign(canonical)]
            ]),
            proposals:    new Map(),
            winner:       { body: BODY, meta: '' },
            status:       'ok',
            myPubkey:     pub(me),
            leaderPubkey: pub(me),
            role:         'leader',
            finalized:    false,
            _commitSent:  true,
            timer:        null
        };
        consensus.pending.set(RID, pending);
    });

    afterEach(function () {
        for (let [, p] of consensus.pending) { if (p.timer) clearTimeout(p.timer); }
        sinon.restore();
    });

    it('finalizes the round when peer C\'s PREPARE (its COMMIT was lost) completes quorum', function () {
        let canonical = consensus._buildCanonical(RID, 'http_get', BODY, 'ok', '', 0).toString('utf8');
        let finalized = sinon.spy();
        consensus.on('request:finalized', finalized);

        // Sanity: not yet quorate (2 of 3 sigs), round not finalized.
        expect(pending.finalized).to.equal(false);
        expect(pending.signatures.size).to.equal(2);

        // Peer C's COMMIT never arrived (lost on best-effort gossip); its
        // PREPARE arrives after this node already sent COMMIT.
        consensus._handlePrepare({
            type: 'ATTEST_PREPARE',
            data: {
                requestId:  RID,
                providerId: 'http_get',
                body_b64:   BODY.toString('base64'),
                meta:       '',
                status:     'ok',
                sig_pubkey: pub(peerC),
                sig:        peerC.sign(canonical)
            }
        });

        // The late sig crosses commit quorum and the round finalizes now,
        // rather than stalling until the round timeout.
        expect(pending.signatures.size).to.equal(3);
        expect(pending.finalized).to.equal(true);
        expect(consensus.finalized.has(RID)).to.equal(true);
        expect(finalized.calledOnce).to.equal(true);
        expect(finalized.firstCall.args[0].signatures).to.have.lengthOf(3);
    });
});
