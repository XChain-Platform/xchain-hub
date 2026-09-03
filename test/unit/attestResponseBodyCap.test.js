'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// ATTEST_RESPONSE_BODY_MAX_BYTES enforced by the leader before proposing and
// by every follower before signing (the ATTEST response mirror design, §5.3,
// decisions D40/D41, row 9).
//
// Today's only 8189 check is a post-finalization drop in the publisher that
// measures the ASSEMBLED WIRE (AttestationPublisher.js:319-324), not the
// body, so a body sitting exactly at the cap already finalizes and then dies
// once signatures are appended. These cases drive the three points that now
// refuse the body BEFORE any of that: this hub's own propose(), a peer's
// PROPOSE, and a peer's PREPARE.

const { expect }           = require('chai');
const sinon                = require('sinon');
const AttestationConsensus = require('../../src/AttestationConsensus.js');
const ValidatorIdentity    = require('../../src/ValidatorIdentity.js');
const {
    ATTEST_RESPONSE_BODY_MAX_BYTES,
    bodyByteLength,
    assertBodyWithinCap
} = require('../../src/lib/attest_response_body_cap.js');

const RID      = 'ab'.repeat(16);
const META     = 'tag=1';
const PROVIDER = 'http_get';
const NOW      = 1780000000;
const LEGACY_BLK = 10;   // no network below arms the mirror, so any block is legacy era
const MIRROR_BLK = 500;  // regtest arms the mirror at genesis (attest_response_mirror_activation.js)

// Bodies straddling the cap. Plain ASCII, so byte length equals Buffer length
// directly; the multibyte cases below prove the measurement is bytes, not
// characters, using this same helper on non-ASCII content.
const AT_CAP_BODY   = Buffer.alloc(ATTEST_RESPONSE_BODY_MAX_BYTES, 'x');
const OVER_CAP_BODY = Buffer.alloc(ATTEST_RESPONSE_BODY_MAX_BYTES + 1, 'x');

function makeEngine(network) {
    let identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    let peer     = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    let third    = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    let broadcast = sinon.stub();
    let hub = {
        network:        network,
        db:             { doQuery: async () => [] },
        p2pConfig:      {},
        getPeerManager: () => ({ on: () => {}, removeListener: () => {}, broadcast: broadcast }),
        getIdentity:    () => identity
    };
    let engine = new AttestationConsensus(hub, {
        getDef:    () => ({ max_response_bytes: 65536 }),
        getModule: () => ({ agree: (p) => p[0] || null })
    });
    engine.identity = identity;
    return {
        engine, identity, peer, third, broadcast,
        me:       identity.getPubkeyHex().toLowerCase(),
        peerKey:  peer.getPubkeyHex().toLowerCase(),
        thirdKey: third.getPubkeyHex().toLowerCase()
    };
}

function clearTimer(pending) {
    if (pending && pending.timer) clearTimeout(pending.timer);
}

describe('ATTEST_RESPONSE_BODY_MAX_BYTES module', function () {

    it('is frozen at 8189', function () {
        expect(ATTEST_RESPONSE_BODY_MAX_BYTES).to.equal(8189);
    });

    it('measures a Buffer by its own length', function () {
        expect(bodyByteLength(AT_CAP_BODY)).to.equal(8189);
        expect(bodyByteLength(OVER_CAP_BODY)).to.equal(8190);
        expect(assertBodyWithinCap(AT_CAP_BODY)).to.equal(true);
        expect(assertBodyWithinCap(OVER_CAP_BODY)).to.equal(false);
    });

    it('measures a multibyte STRING in UTF-8 bytes, not characters (D40/D41)', function () {
        // 8189 'é' characters: JS String#length is 8189 (one UTF-16 code unit
        // each), but 'é' is 2 bytes in UTF-8, so the wire body is 16378 bytes,
        // twice over the cap. A characters-not-bytes measurement would wrongly
        // accept this at exactly the cap.
        let multibyte = 'é'.repeat(8189);
        expect(multibyte.length, 'sanity: character count sits exactly at the cap').to.equal(8189);
        expect(bodyByteLength(multibyte)).to.equal(16378);
        expect(assertBodyWithinCap(multibyte)).to.equal(false);

        // Decoded the way the engine actually receives a body (base64 -> Buffer),
        // the same content measures the same bytes.
        let decoded = Buffer.from(Buffer.from(multibyte, 'utf8').toString('base64'), 'base64');
        expect(bodyByteLength(decoded)).to.equal(16378);
    });

    it('measures an astral (4-byte, 2-UTF-16-code-unit) character correctly', function () {
        // A char-count or UTF-16-code-unit measurement would read this as 2;
        // the wire body is 4 bytes.
        expect(bodyByteLength('\u{1F600}')).to.equal(4);
    });

    it('accepts a body one byte under the cap and refuses one at it plus one over that', function () {
        expect(assertBodyWithinCap(Buffer.alloc(ATTEST_RESPONSE_BODY_MAX_BYTES - 1))).to.equal(true);
        expect(assertBodyWithinCap(Buffer.alloc(ATTEST_RESPONSE_BODY_MAX_BYTES))).to.equal(true);
        expect(assertBodyWithinCap(Buffer.alloc(ATTEST_RESPONSE_BODY_MAX_BYTES + 1))).to.equal(false);
    });
});

describe('LEADER: propose() refuses an over-cap body before broadcasting (legacy era)', function () {

    afterEach(function () { sinon.restore(); });

    async function drive(body) {
        let e = makeEngine('testnet');  // ATTEST_RESPONSE_MIRROR_ACTIVATION.testnet is null: legacy era
        await e.engine.propose(RID, {
            request:      { request_id: RID, block_index: LEGACY_BLK, deadline_block: LEGACY_BLK + 100 },
            providerId:   PROVIDER,
            redundancy:   3,
            snapshot:     { validators: [] },
            responsible:  [{ pubkey: e.me }, { pubkey: e.peerKey }, { pubkey: e.thirdKey }],
            leaderPubkey: e.me,
            role:         'leader',
            myProposal:   { body: body, meta: META, status: 'ok' },
            pinnedConsensusStrategy: 'byte_equality',
            pinnedMaxResponseBytes:  65536
        });
        let pending = e.engine.pending.get(RID);
        return { e, pending };
    }

    it('proposes and broadcasts a body exactly at the cap', async function () {
        let { e, pending } = await drive(AT_CAP_BODY);
        expect(pending.proposals.has(e.me), 'own body stored as a proposal').to.equal(true);
        expect(e.broadcast.calledOnce, 'PROPOSE broadcast once').to.equal(true);
        expect(e.broadcast.firstCall.args[0]).to.equal('ATTEST_PROPOSE');
        expect(e.engine.bodyOverCapRejectCount).to.equal(0);
        clearTimer(pending);
    });

    it('refuses to propose one byte over the cap, and counts it', async function () {
        let { e, pending } = await drive(OVER_CAP_BODY);
        expect(pending.proposals.has(e.me), 'own oversize body is not proposable by this hub').to.equal(false);
        expect(e.broadcast.called, 'no PROPOSE is broadcast for the oversize body').to.equal(false);
        expect(e.engine.bodyOverCapRejectCount).to.equal(1);
        clearTimer(pending);
    });

    it('refuses the same way in the MIRROR era', async function () {
        let e = makeEngine('regtest');  // regtest is armed at genesis
        sinon.stub(e.engine, '_nowSeconds').returns(NOW);
        await e.engine.propose(RID, {
            request:      { request_id: RID, block_index: MIRROR_BLK, deadline_block: MIRROR_BLK + 100 },
            providerId:   PROVIDER,
            redundancy:   3,
            snapshot:     { validators: [] },
            responsible:  [{ pubkey: e.me }, { pubkey: e.peerKey }, { pubkey: e.thirdKey }],
            leaderPubkey: e.me,
            role:         'leader',
            myProposal:   { body: OVER_CAP_BODY, meta: META, status: 'ok' },
            pinnedConsensusStrategy: 'byte_equality',
            pinnedMaxResponseBytes:  65536
        });
        let pending = e.engine.pending.get(RID);
        expect(pending.mirrorEra).to.equal(true);
        expect(pending.proposals.has(e.me)).to.equal(false);
        expect(e.broadcast.called).to.equal(false);
        clearTimer(pending);
    });
});

describe('FOLLOWER: _handlePropose refuses an over-cap peer proposal (legacy era)', function () {

    async function openRound(e) {
        await e.engine.propose(RID, {
            request:      { request_id: RID, block_index: LEGACY_BLK, deadline_block: LEGACY_BLK + 100 },
            providerId:   PROVIDER,
            redundancy:   3,
            snapshot:     { validators: [] },
            responsible:  [{ pubkey: e.me }, { pubkey: e.peerKey }, { pubkey: e.thirdKey }],
            leaderPubkey: e.peerKey,
            role:         'follower',
            myProposal:   { body: Buffer.from('own-tiny-body'), meta: META, status: 'ok' },
            pinnedConsensusStrategy: 'byte_equality',
            pinnedMaxResponseBytes:  65536
        });
        return e.engine.pending.get(RID);
    }

    function peerProposeEnvelope(e, body) {
        let canonical = e.engine._buildCanonical(RID, PROVIDER, body, 'ok', META, LEGACY_BLK).toString('utf8');
        return {
            type: 'ATTEST_PROPOSE',
            data: {
                requestId:  RID,
                providerId: PROVIDER,
                body_b64:   body.toString('base64'),
                meta:       META,
                status:     'ok',
                sig_pubkey: e.peerKey,
                sig:        e.peer.sign(canonical)
            }
        };
    }

    it('stores a peer proposal exactly at the cap', function () {
        let e = makeEngine('testnet');
        return openRound(e).then((pending) => {
            e.engine._handlePropose(peerProposeEnvelope(e, AT_CAP_BODY));
            expect(pending.proposals.has(e.peerKey)).to.equal(true);
            expect(e.engine.bodyOverCapRejectCount).to.equal(0);
            clearTimer(pending);
        });
    });

    it('refuses a peer proposal one byte over the cap, and never signs for it', function () {
        let e = makeEngine('testnet');
        return openRound(e).then((pending) => {
            e.engine._handlePropose(peerProposeEnvelope(e, OVER_CAP_BODY));
            expect(pending.proposals.has(e.peerKey), 'never entered the candidate set').to.equal(false);
            expect(pending.signatures.has(e.peerKey), 'never signed for').to.equal(false);
            expect(e.engine.bodyOverCapRejectCount).to.equal(1);
            clearTimer(pending);
        });
    });
});

describe('FOLLOWER: _handlePrepare refuses to adopt/co-sign an over-cap leader body (legacy era)', function () {

    async function openRound(e) {
        await e.engine.propose(RID, {
            request:      { request_id: RID, block_index: LEGACY_BLK, deadline_block: LEGACY_BLK + 100 },
            providerId:   PROVIDER,
            redundancy:   3,
            snapshot:     { validators: [] },
            responsible:  [{ pubkey: e.peerKey }, { pubkey: e.me }, { pubkey: e.thirdKey }],
            leaderPubkey: e.peerKey,
            role:         'follower',
            myProposal:   { body: AT_CAP_BODY, meta: META, status: 'ok' },
            pinnedConsensusStrategy: 'byte_equality',
            pinnedMaxResponseBytes:  65536
        });
        let pending = e.engine.pending.get(RID);
        expect(pending.winner, 'round still open').to.equal(null);
        return pending;
    }

    function leaderPrepareEnvelope(e, body) {
        let canonical = e.engine._buildCanonical(RID, PROVIDER, body, 'ok', META, LEGACY_BLK).toString('utf8');
        return {
            type: 'ATTEST_PREPARE',
            data: {
                requestId:  RID,
                providerId: PROVIDER,
                body_b64:   body.toString('base64'),
                meta:       META,
                status:     'ok',
                sig_pubkey: e.peerKey,
                sig:        e.peer.sign(canonical)
            }
        };
    }

    it('adopts and co-signs a leader body exactly at the cap', function () {
        let e = makeEngine('testnet');
        return openRound(e).then((pending) => {
            e.engine._handlePrepare(leaderPrepareEnvelope(e, AT_CAP_BODY));
            expect(pending.winner, 'winner established').to.not.equal(null);
            expect(pending.signatures.has(e.peerKey), 'leader sig counted').to.equal(true);
            expect(pending.signatures.has(e.me), 'this hub co-signed').to.equal(true);
            expect(e.engine.bodyOverCapRejectCount).to.equal(0);
            clearTimer(pending);
        });
    });

    it('refuses a leader body one byte over the cap: no winner, no signature', function () {
        let e = makeEngine('testnet');
        return openRound(e).then((pending) => {
            e.engine._handlePrepare(leaderPrepareEnvelope(e, OVER_CAP_BODY));
            expect(pending.winner, 'must not establish a winner over cap').to.equal(null);
            expect(pending.signatures.has(e.peerKey)).to.equal(false);
            expect(pending.signatures.has(e.me)).to.equal(false);
            expect(e.engine.bodyOverCapRejectCount).to.equal(1);
            clearTimer(pending);
        });
    });
});
