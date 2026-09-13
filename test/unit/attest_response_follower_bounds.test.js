'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// The follower's guards on a leader-chosen `effective_time`
// (the ATTEST response mirror design, §3.1, decisions D5 and D59).
//
// Two guards, and the ORDER between them is the point. The canonical-int
// spelling guard runs first: a leader proposing '0120' passes every Number()-
// based check, collects an honest quorum, and finalizes a row whose canonical no
// verifier can ever rebuild, permanently stranding the request. That is why the
// cross-chain relay pairs its own bounds with allCanonicalInts before comparing
// anything numerically, and it is why the spelling case below is deliberately
// spelled as an IN-WINDOW value: if the guards were reordered, the numeric bound
// would wave it through.
//
// Every assertion here is on the observable outcome of the round (was a winner
// established, whose stamp is the round's, whose signature was counted), never
// on a stub call count.

const { expect }           = require('chai');
const sinon                = require('sinon');
const AttestationConsensus = require('../../src/AttestationConsensus.js');
const ValidatorIdentity    = require('../../src/ValidatorIdentity.js');
const { ATTEST_RESPONSE_FORWARD_S } = require('../../src/lib/attest_response_timing.js');

const RID       = 'cd'.repeat(16);
const BODY      = Buffer.from('the-agreed-body');
const META      = 'tag=1';
const PROVIDER  = 'http_get';
const NOW       = 1780000000;
const BLK       = 500;                                  // regtest: mirror era
const EXPECTED  = NOW + ATTEST_RESPONSE_FORWARD_S;      // what an honest leader stamps
const LOW_EDGE  = EXPECTED - 60;
const HIGH_EDGE = EXPECTED + 3600;

// A follower with an open round: it proposed its own body but holds only its own
// proposal, so `need` is unmet and it has NOT established a winner. The next
// PREPARE it accepts is the first point at which it adopts a field it did not
// choose, which is exactly where the guards live.
function makeFollower() {
    let identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    let leader   = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    let third    = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
    let hub = {
        network:        'regtest',
        db:             { doQuery: async () => [] },
        p2pConfig:      {},
        getPeerManager: () => ({ on: () => {}, removeListener: () => {}, broadcast: () => {} }),
        getIdentity:    () => identity
    };
    let engine = new AttestationConsensus(hub, {
        getDef:    () => ({ max_response_bytes: 65536 }),
        getModule: () => ({ agree: (p) => p[0] || null })
    });
    engine.identity = identity;
    sinon.stub(engine, '_nowSeconds').returns(NOW);
    return { engine, identity, leader, third,
             me:        identity.getPubkeyHex().toLowerCase(),
             leaderKey: leader.getPubkeyHex().toLowerCase(),
             thirdKey:  third.getPubkeyHex().toLowerCase() };
}

async function openRound(f) {
    await f.engine.propose(RID, {
        request:      { request_id: RID, block_index: BLK, deadline_block: BLK + 100 },
        providerId:   PROVIDER,
        redundancy:   3,
        snapshot:     { validators: [] },
        responsible:  [{ pubkey: f.leaderKey }, { pubkey: f.me }, { pubkey: f.thirdKey }],
        leaderPubkey: f.leaderKey,
        role:         'follower',
        myProposal:   { body: BODY, meta: META, status: 'ok' },
        pinnedConsensusStrategy: 'byte_equality',
        pinnedMaxResponseBytes:  65536
    });
    let pending = f.engine.pending.get(RID);
    expect(pending.mirrorEra, 'regtest at block 500 is the mirror era').to.equal(true);
    expect(pending.winner, 'the round must still be open').to.equal(null);
    return pending;
}

// A leader PREPARE stamped `wireEt`. `signOver` lets a case sign real bytes even
// when `wireEt` itself is a spelling the canonical builder refuses to accept.
function leaderPrepare(f, wireEt, signOver) {
    let canonical = f.engine._buildCanonical(RID, PROVIDER, BODY, 'ok', META, BLK,
        signOver === undefined ? wireEt : signOver).toString('utf8');
    return {
        type: 'ATTEST_PREPARE',
        data: {
            requestId:      RID,
            providerId:     PROVIDER,
            body_b64:       BODY.toString('base64'),
            meta:           META,
            status:         'ok',
            sig_pubkey:     f.leaderKey,
            sig:            f.leader.sign(canonical),
            effective_time: wireEt
        }
    };
}

describe('follower bounds on a leader-chosen effective_time', function () {

    afterEach(function () { sinon.restore(); });

    async function drive(wireEt, signOver) {
        let f = makeFollower();
        let pending = await openRound(f);
        let ownStamp = pending.effectiveTime;
        let threw = null;
        try { f.engine._handlePrepare(leaderPrepare(f, wireEt, signOver)); }
        catch (e) { threw = e; }
        let out = { f, pending, ownStamp, threw };
        if (pending.timer) clearTimeout(pending.timer);
        return out;
    }

    it('ACCEPTS the value an honest leader computes from the same frozen constant', async function () {
        let { pending, f, threw } = await drive(EXPECTED);
        expect(threw).to.equal(null);
        expect(pending.winner, 'winner established').to.not.equal(null);
        expect(pending.effectiveTime, 'the round adopted the leader\'s stamp').to.equal(EXPECTED);
        expect(pending.signatures.has(f.leaderKey), 'the leader\'s signature was counted').to.equal(true);
        // And this hub co-signed the adopted bytes rather than its own.
        let adopted = f.engine._buildCanonical(RID, PROVIDER, BODY, 'ok', META, BLK, pending.effectiveTime).toString('utf8');
        expect(ValidatorIdentity.verify(adopted, pending.signatures.get(f.me), f.me)).to.equal(true);
    });

    it('REJECTS a proposal 10 seconds in the past', async function () {
        // Below the propagation floor: a row eligible the instant it lands makes an
        // indexer that already holds it apply a block earlier than one still
        // receiving it, and their action-index counters fork for good.
        let { pending, f, ownStamp, threw } = await drive(NOW - 10);
        expect(threw).to.equal(null);
        expect(pending.winner, 'a past stamp must not establish a winner').to.equal(null);
        expect(pending.effectiveTime, 'the round\'s own stamp is untouched').to.equal(ownStamp);
        expect(pending.signatures.has(f.leaderKey)).to.equal(false);
    });

    it('ACCEPTS the top edge of the window and REJECTS one second past it', async function () {
        let atEdge = await drive(HIGH_EDGE);
        expect(atEdge.pending.winner, 'now + forward + 3600 is inside the window').to.not.equal(null);
        expect(atEdge.pending.effectiveTime).to.equal(HIGH_EDGE);

        let past = await drive(HIGH_EDGE + 1);
        expect(past.pending.winner, 'one second past the edge is out').to.equal(null);
        expect(past.pending.effectiveTime).to.equal(past.ownStamp);
    });

    it('ACCEPTS the bottom edge of the window and REJECTS one second below it', async function () {
        let atEdge = await drive(LOW_EDGE);
        expect(atEdge.pending.winner).to.not.equal(null);
        expect(atEdge.pending.effectiveTime).to.equal(LOW_EDGE);

        let below = await drive(LOW_EDGE - 1);
        expect(below.pending.winner).to.equal(null);
        expect(below.pending.effectiveTime).to.equal(below.ownStamp);
    });

    it('REJECTS an hour-plus griefing stamp', async function () {
        let { pending } = await drive(NOW + 7200);
        expect(pending.winner, 'a far-future stamp pins the callback past the deadline').to.equal(null);
    });

    it('REJECTS a non-canonical spelling THAT IS INSIDE THE NUMERIC WINDOW (D59, order-sensitive)', async function () {
        // '01780000120' is Number-equal to the value the previous test accepted, so
        // the numeric bound cannot refuse it. Only the spelling guard can, and only
        // if it runs first. If the guards were reordered this call would reach
        // buildResponseCanonicalRaw, which throws by contract - so `threw` is
        // asserted null as well as the round staying open.
        let { pending, f, ownStamp, threw } = await drive('0' + String(EXPECTED), EXPECTED);
        expect(threw, 'the spelling guard must refuse it, not let the builder throw').to.equal(null);
        expect(pending.winner, '\'0\'-padded stamp must not establish a winner').to.equal(null);
        expect(pending.effectiveTime).to.equal(ownStamp);
        expect(pending.signatures.has(f.leaderKey)).to.equal(false);
    });

    it('ACCEPTS a canonically spelled STRING, and it produces the same bytes as the number', async function () {
        // JSON gives no guarantee about which JS type a peer's integer arrives as.
        // A canonically spelled string is the same value and the same bytes.
        let { pending } = await drive(String(EXPECTED));
        expect(pending.winner).to.not.equal(null);
        expect(pending.effectiveTime).to.equal(EXPECTED);
    });

    it('REJECTS a mirror-era PREPARE that carries no effective_time at all', async function () {
        let f = makeFollower();
        let pending = await openRound(f);
        let env = leaderPrepare(f, EXPECTED);
        delete env.data.effective_time;
        f.engine._handlePrepare(env);
        expect(pending.winner, 'a mirror-era round cannot adopt a legacy PREPARE').to.equal(null);
        if (pending.timer) clearTimeout(pending.timer);
    });

    // item 6491: the non-ok winner-establishing block adopted the sender's stamp
    // BEFORE the byte_equality no_quorum self-derivation gate (items 2641/2579)
    // could refuse the message, so a PREPARE this hub declines to co-sign still
    // moved the round's bytes. The ok path already defers adoption to its commit
    // point; this pins the non-ok path to the same rule.
    it('REJECTS a no_quorum PREPARE it cannot derive, leaving its own stamp in place', async function () {
        let f = makeFollower();
        let pending = await openRound(f);
        let ownStamp = pending.effectiveTime;
        expect(ownStamp, 'the follower stamped its own candidate at propose()').to.equal(EXPECTED);
        // In-window, so the bounds guard passes and only the derivation gate refuses.
        let wireEt = EXPECTED + 900;
        let canonical = f.engine._buildCanonical(RID, PROVIDER, Buffer.alloc(0), 'no_quorum', '', BLK, wireEt).toString('utf8');
        f.engine._handlePrepare({
            type: 'ATTEST_PREPARE',
            data: { requestId: RID, providerId: PROVIDER, body_b64: '', meta: '', status: 'no_quorum',
                    sig_pubkey: f.leaderKey, sig: f.leader.sign(canonical), effective_time: wireEt }
        });
        // Only this hub's own proposal is in hand, so the verdict is not yet
        // locally derivable: the message is held, not adopted on faith.
        expect(pending.winner, 'a no_quorum PREPARE is not adopted on faith').to.equal(null);
        expect(pending.signatures.has(f.leaderKey)).to.equal(false);
        expect(f.engine.earlyMessages.has(RID), 'held for local derivation').to.equal(true);
        expect(pending.effectiveTime, 'a refused PREPARE leaves the round stamp alone').to.equal(ownStamp);
        if (pending.timer) clearTimeout(pending.timer);
    });

    it('drops an out-of-window PROPOSE, so the leader-stamp resolver never sees one', async function () {
        // The resolver takes the round's stamp from the leader's PROPOSE, so that
        // envelope is a leader-chosen field too and gets the same treatment.
        let f = makeFollower();
        let pending = await openRound(f);
        let bad = f.engine._buildCanonical(RID, PROVIDER, BODY, 'ok', META, BLK, NOW - 10).toString('utf8');
        f.engine._handlePropose({
            type: 'ATTEST_PROPOSE',
            data: { requestId: RID, providerId: PROVIDER, body_b64: BODY.toString('base64'), meta: META,
                    status: 'ok', sig_pubkey: f.leaderKey, sig: f.leader.sign(bad), effective_time: NOW - 10 }
        });
        expect(pending.proposals.has(f.leaderKey), 'an out-of-window proposal is not stored').to.equal(false);
        expect(pending.effectiveTime).to.equal(NOW + ATTEST_RESPONSE_FORWARD_S);
        if (pending.timer) clearTimeout(pending.timer);
    });
});
