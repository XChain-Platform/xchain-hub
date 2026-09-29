'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// A WIDENED responsible set must still settle every hub on the LEADER's
// mirror-era stamp.
//
// Zero-conf widening makes the responsible set one larger than REDUNDANCY, so a
// byte_equality hub reaches `need` proposals before the leader's can have
// arrived. Settling then falls back to that hub's own stamp, which is its own
// wall-clock second plus the forward margin, so a hub that proposed a second
// earlier than its peers signs a canonical nobody else can rebuild, counts no
// peer PREPARE, never finalizes, and pays its provider again when the request
// comes back pending (the ZC2 re-mine drill on a GitHub runner, 2026-09-29:
// hub 4 proposed in second :26, hubs 2 and 3 in :27, the leader in :29).

const { expect }           = require('chai');
const sinon                = require('sinon');
const AttestationConsensus = require('../../../../src/attestation/consensus.js');
const ValidatorIdentity    = require('../../../../src/validators/identity.js');
const { ATTEST_RESPONSE_FORWARD_S } = require('../../../../src/attestation/attest_response_timing.js');

const RID        = 'cd'.repeat(16);
const BODY       = Buffer.from('the-agreed-body');
const META       = 'tag=1';
const PROVIDER   = 'http_get';
const NOW        = 1780000000;
const MIRROR_BLK = 500;   // regtest activation is 0, so this is mirror era

// One in-process federation on a synchronous bus, each engine on its OWN clock.
function makeFederation(clocks) {
    let bus  = { engines: [] };
    let hubs = [];
    for (let i = 0; i < clocks.length; i++) {
        let identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        let peerManager = {
            on: () => {}, removeListener: () => {},
            broadcast: (type, data) => {
                let env = { type: type, data: JSON.parse(JSON.stringify(data)) };
                for (let e of bus.engines) if (e.identity !== identity) e.handleMessage(env);
            }
        };
        let hub = {
            network:        'regtest',
            db:             { doQuery: async () => [] },
            p2pConfig:      {},
            getPeerManager: () => peerManager,
            getIdentity:    () => identity
        };
        let registry = {
            getDef:    () => ({ max_response_bytes: 65536, consensus_strategy: 'byte_equality' }),
            getModule: () => ({ agree: (proposals) => proposals[0] || null })
        };
        let engine = new AttestationConsensus(hub, registry);
        engine.identity = identity;
        sinon.stub(engine, 'nowSeconds').returns(clocks[i]);
        bus.engines.push(engine);
        hubs.push({ engine: engine, identity: identity, pubkey: identity.getPubkeyHex().toLowerCase() });
    }
    return hubs;
}

// Four responsible hubs, REDUNDANCY 3 (widen 1); the leader is `leader`.
function roundStateFor(hubs, me, leader) {
    return {
        request:      { request_id: RID, block_index: MIRROR_BLK, deadline_block: MIRROR_BLK + 100 },
        providerId:   PROVIDER,
        redundancy:   3,
        snapshot:     { validators: hubs.map(h => ({ pubkey: h.pubkey })) },
        responsible:  hubs.map(h => ({ pubkey: h.pubkey })),
        leaderPubkey: leader.pubkey,
        role:         me === leader ? 'leader' : 'follower',
        myProposal:   { body: BODY, meta: META, status: 'ok' },
        pinnedConsensusStrategy: 'byte_equality',
        pinnedMaxResponseBytes:  65536
    };
}

async function settle() {
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
}

function cleanup(hubs) {
    for (let h of hubs) {
        for (let [, p] of h.engine.pending) if (p.timer) clearTimeout(p.timer);
        h.engine.pending.clear();
    }
}

function registerLeaderLastTest() {
    it('the leader proposing last still sets the one stamp every hub signs, and every hub finalizes', async function () {
        // hubs[0] is the early widen hub (second :26), hubs[1..2] propose in :27,
        // hubs[3] is the leader and proposes last, in :29.
        let hubs   = makeFederation([NOW - 1, NOW, NOW, NOW + 2]);
        let leader = hubs[3];
        let finalized = [];
        for (let h of hubs) h.engine.on('request:finalized', (p) => finalized.push({ hub: h, payload: p }));
        try {
            for (let h of hubs.slice(0, 3)) await h.engine.propose(RID, roundStateFor(hubs, h, leader));
            await settle();
            for (let h of hubs.slice(0, 3)) {
                let p = h.engine.pending.get(RID);
                expect(p.winner, 'hub ' + hubs.indexOf(h) + ' settled a winner before the leader proposed').to.not.be.ok;
            }

            await leader.engine.propose(RID, roundStateFor(hubs, leader, leader));
            await settle();

            let leaderStamp = NOW + 2 + ATTEST_RESPONSE_FORWARD_S;
            for (let h of hubs) {
                let p = h.engine.pending.get(RID);
                expect(p.effectiveTime, 'hub ' + hubs.indexOf(h) + ' stamp').to.equal(leaderStamp);
            }
            let who = new Set(finalized.map(ev => hubs.indexOf(ev.hub)));
            expect([...who].sort(), 'hubs that finalized').to.deep.equal([0, 1, 2, 3]);
            for (let ev of finalized) expect(ev.payload.effectiveTime).to.equal(leaderStamp);
        } finally { cleanup(hubs); }
    });
}

function registerFallbackTests() {
    it('with the leader silent and a responsible proposal still missing, holds rather than settling its own stamp', async function () {
        // Three hubs plus a leader that never proposes: the wait ends only at the
        // leader's proposal or a full set, so 3 of 4 hold until the round timeout.
        let hubs   = makeFederation([NOW, NOW, NOW, NOW]);
        let leader = hubs[3];
        try {
            for (let h of hubs.slice(0, 3)) await h.engine.propose(RID, roundStateFor(hubs, h, leader));
            await settle();
            for (let h of hubs.slice(0, 3)) expect(h.engine.pending.get(RID).winner).to.not.be.ok;
        } finally { cleanup(hubs); }
    });

    it('an unwidened set (responsible equals REDUNDANCY) is untouched: the leader is always among `need`', async function () {
        let hubs   = makeFederation([NOW - 1, NOW, NOW + 2]);
        let leader = hubs[2];
        let finalized = [];
        for (let h of hubs) h.engine.on('request:finalized', (p) => finalized.push(p));
        try {
            for (let h of hubs) {
                let rs = roundStateFor(hubs, h, leader);
                await h.engine.propose(RID, rs);
            }
            await settle();
            expect(finalized.length).to.equal(3);
            for (let p of finalized) expect(p.effectiveTime).to.equal(NOW + 2 + ATTEST_RESPONSE_FORWARD_S);
        } finally { cleanup(hubs); }
    });
}

describe('mirror-era stamp on a widened responsible set', function () {

    afterEach(function () { sinon.restore(); });

    registerLeaderLastTest();

    registerFallbackTests();
});
