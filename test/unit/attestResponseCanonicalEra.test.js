'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// The mirror-era ATTEST response canonical, DRIVEN THROUGH A REAL PBFT ROUND
// (the ATTEST response mirror design, §3.1 and §4.2, decisions D5, D6, D59,
// D69; frontier rows 6 and 8).
//
// Reading the diff cannot tell you whether era selection is coherent, because
// the failure this whole row exists to prevent is era selection forking PER CODE
// PATH rather than per request, and every code path looks locally correct.
// So the tests below stand three real AttestationConsensus engines on a shared
// bus, run a whole round through them, and assert on the bytes the leader signed
// against the bytes a follower verified.
//
// The single most important test here is the legacy one: its expectation is a
// CAPTURED LITERAL, taken from the engine before this change, so a from-genesis
// replay of every historical block is proved unchanged rather than assumed.

const crypto               = require('crypto');
const fs                   = require('fs');
const path                 = require('path');
const { expect }           = require('chai');
const sinon                = require('sinon');
const AttestationConsensus = require('../../src/AttestationConsensus.js');
const ValidatorIdentity    = require('../../src/ValidatorIdentity.js');
const { isCanonicalIntSpelling } = require('../../src/attest_response_canonical.js');
const { ATTEST_RESPONSE_FORWARD_S } = require('../../src/lib/attest_response_timing.js');

// Captured from the engine at HEAD~ (before the mirror-era canonical landed), by
// building the canonical for this exact round on a network whose activation map
// entry is null. Any change to the legacy concatenation, in this file or in
// attest_response_canonical.js, moves this string and reds the test.
const LEGACY_CANONICAL_LITERAL =
    'ababababababababababababababababhttp_get' +
    '89b4876221ec2646eac2acaa23b99959f84bf6f18a44d24f0195261733437c46' +
    'oktag=1';

const RID        = 'ab'.repeat(16);
const BODY       = Buffer.from('the-agreed-body');
const META       = 'tag=1';
const PROVIDER   = 'http_get';
const NOW        = 1780000000;          // fixed clock; every hub reads the same one
const MIRROR_BLK = 500;                 // regtest activation is 0, so this is mirror era
const LEGACY_BLK = 900000;              // mainnet activation is null: legacy at every height

// One in-process federation of `n` engines sharing a bus. broadcast() delivers
// synchronously to every OTHER engine, which is what a PBFT round looks like from
// inside a single hub and is enough to prove the canonicals agree.
function makeFederation(network, n) {
    let bus  = { engines: [] };
    let hubs = [];

    for (let i = 0; i < n; i++) {
        let identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        let peerManager = {
            on: () => {}, removeListener: () => {},
            broadcast: (type, data) => {
                // Deep-ish copy through JSON so a handler cannot mutate a peer's
                // object, and so a Buffer never crosses the bus by reference.
                let env = { type: type, data: JSON.parse(JSON.stringify(data)) };
                for (let e of bus.engines) if (e.identity !== identity) e._handleMessage(env);
            }
        };
        let hub = {
            network:        network,
            db:             { doQuery: async () => [] },
            p2pConfig:      {},
            getPeerManager: () => peerManager,
            getIdentity:    () => identity
        };
        let registry = {
            getDef:    () => ({ max_response_bytes: 65536, consensus_strategy: 'byte_equality' }),
            // byte_equality: every honest hub fetched identical bytes, so returning
            // the first ok proposal returns the same body and meta on every hub.
            getModule: () => ({ agree: (proposals) => proposals[0] || null })
        };
        let engine = new AttestationConsensus(hub, registry);
        engine.identity = identity;
        // Fixed clock everywhere: the leader's stamp and every follower's window
        // are then exact, so a bounds failure is a bug and never a timing flake.
        sinon.stub(engine, '_nowSeconds').returns(NOW);
        bus.engines.push(engine);
        hubs.push({ engine: engine, identity: identity, pubkey: identity.getPubkeyHex().toLowerCase() });
    }
    return hubs;
}

function roundStateFor(hubs, me, blockIndex) {
    return {
        request:      { request_id: RID, block_index: blockIndex, deadline_block: blockIndex + 100 },
        providerId:   PROVIDER,
        redundancy:   hubs.length,
        snapshot:     { validators: hubs.map(h => ({ pubkey: h.pubkey })) },
        responsible:  hubs.map(h => ({ pubkey: h.pubkey })),
        leaderPubkey: hubs[0].pubkey,
        role:         me.pubkey === hubs[0].pubkey ? 'leader' : 'follower',
        myProposal:   { body: BODY, meta: META, status: 'ok' },
        pinnedConsensusStrategy: 'byte_equality',
        pinnedMaxResponseBytes:  65536
    };
}

// Drive a whole round: every hub proposes, the bus carries PROPOSE/PREPARE/COMMIT,
// and we settle the async agree() hops before asserting.
async function driveRound(hubs, blockIndex) {
    let finalized = [];
    for (let h of hubs) h.engine.on('request:finalized', (p) => finalized.push({ hub: h, payload: p }));
    for (let h of hubs) await h.engine.propose(RID, roundStateFor(hubs, h, blockIndex));
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    return finalized;
}

function cleanup(hubs) {
    for (let h of hubs) {
        for (let [, p] of h.engine.pending) if (p.timer) clearTimeout(p.timer);
        h.engine.pending.clear();
    }
}

describe('mirror-era ATTEST response canonical, driven through a round', function () {

    afterEach(function () { sinon.restore(); });

    it('LEGACY ERA IS BYTE-PRESERVED: the round signs the captured pre-change literal', async function () {
        let hubs = makeFederation('mainnet', 3);
        try {
            let finalized = await driveRound(hubs, LEGACY_BLK);

            // The round still works exactly as it did.
            expect(finalized.length, 'every hub finalizes').to.equal(3);

            // The bytes: identical on every hub, and identical to what the engine
            // produced before the mirror-era canonical existed.
            for (let h of hubs) {
                let p = h.engine.pending.get(RID);
                expect(p.mirrorEra, 'mainnet activation is null, so legacy').to.equal(false);
                expect(p.effectiveTime, 'no stamp exists in the legacy era').to.equal(null);
                let canonical = h.engine._buildCanonical(RID, PROVIDER, BODY, 'ok', META, LEGACY_BLK, p.effectiveTime);
                expect(canonical.toString('utf8')).to.equal(LEGACY_CANONICAL_LITERAL);
            }

            // And the legacy wire carries no new field at all, so a hub on this
            // build and a hub on the previous one send identical envelopes.
            for (let ev of finalized) expect(ev.payload.effectiveTime).to.equal(null);
        } finally { cleanup(hubs); }
    });

    it('MIRROR ERA: leader and followers sign one byte-identical canonical carrying the stamp', async function () {
        let hubs = makeFederation('regtest', 3);
        try {
            let finalized = await driveRound(hubs, MIRROR_BLK);
            expect(finalized.length, 'every hub finalizes').to.equal(3);

            let expectedStamp = NOW + ATTEST_RESPONSE_FORWARD_S;
            let canonicals = new Set();
            for (let h of hubs) {
                let p = h.engine.pending.get(RID);
                expect(p.mirrorEra, 'regtest activation is 0').to.equal(true);
                // Every hub settled on the LEADER's stamp, not its own.
                expect(p.effectiveTime, 'hub ' + h.pubkey.substring(0, 8)).to.equal(expectedStamp);
                canonicals.add(h.engine._buildCanonical(RID, PROVIDER, BODY, 'ok', META, MIRROR_BLK, p.effectiveTime).toString('utf8'));
            }
            expect(canonicals.size, 'one canonical across the whole federation').to.equal(1);

            // It is the legacy string with the separator and the stamp appended,
            // under the EQUIV header that is already active on regtest.
            let only = [...canonicals][0];
            expect(only.endsWith('|' + expectedStamp), only.slice(-40)).to.equal(true);
            expect(only).to.contain(LEGACY_CANONICAL_LITERAL);
            expect(isCanonicalIntSpelling(String(expectedStamp))).to.equal(true);

            // The signatures every hub collected verify over exactly those bytes,
            // which is the property the indexer will re-derive.
            for (let ev of finalized) {
                expect(ev.payload.effectiveTime).to.equal(expectedStamp);
                expect(ev.payload.signatures.length).to.be.at.least(3);
                for (let s of ev.payload.signatures)
                    expect(ValidatorIdentity.verify(only, s.sig, s.pubkey), 'sig from ' + s.pubkey.substring(0, 8)).to.equal(true);
            }
        } finally { cleanup(hubs); }
    });

    it('a follower verifying the LEADER\'s exact wire bytes rebuilds the leader\'s canonical', async function () {
        let hubs = makeFederation('regtest', 3);
        try {
            await driveRound(hubs, MIRROR_BLK);
            let leader   = hubs[0];
            let follower = hubs[2];
            let lp = leader.engine.pending.get(RID);
            let fp = follower.engine.pending.get(RID);

            let leaderBytes   = leader.engine._buildCanonical(RID, PROVIDER, lp.winner.body, lp.status, lp.winner.meta, MIRROR_BLK, lp.effectiveTime);
            let followerBytes = follower.engine._buildCanonical(RID, PROVIDER, fp.winner.body, fp.status, fp.winner.meta, MIRROR_BLK, fp.effectiveTime);
            expect(Buffer.compare(leaderBytes, followerBytes), 'leader and follower bytes differ').to.equal(0);

            // And the leader's own signature is in the follower's set, verified
            // over the follower's own rebuild.
            expect(fp.signatures.has(leader.pubkey)).to.equal(true);
            expect(ValidatorIdentity.verify(followerBytes.toString('utf8'), fp.signatures.get(leader.pubkey), leader.pubkey)).to.equal(true);
        } finally { cleanup(hubs); }
    });

    it('era selection is an ASSERTION on both sides, never a silent branch', function () {
        let hubs = makeFederation('regtest', 1);
        try {
            let e = hubs[0].engine;
            // Mirror era with no stamp: the legacy bytes would be a canonical no
            // mirror-era verifier rebuilds, so it must not be produced at all.
            expect(() => e._buildCanonical(RID, PROVIDER, BODY, 'ok', META, MIRROR_BLK, null))
                .to.throw(/mirror-era request .* has no effective_time/);
            // Legacy era with a stamp: the inverse, and just as fatal.
            expect(() => e._buildCanonical(RID, PROVIDER, BODY, 'ok', META, undefined, NOW + 120))
                .to.throw(/legacy-era request .* was handed effective_time/);
            // A non-canonical spelling never reaches bytes (the shared module's
            // contract, re-asserted here because this is the caller that relies on it).
            expect(() => e._buildCanonical(RID, PROVIDER, BODY, 'ok', META, MIRROR_BLK, '0120'))
                .to.throw(/not a canonical integer spelling/);
        } finally { cleanup(hubs); }
    });

    it('NO CALL SITE CAN FORK THE ERA: every in-file canonical build passes an explicit era', function () {
        // A source-level pin, because the runtime assertion above only fires for a
        // caller that already opted in. The six-argument form yields legacy bytes
        // by design (it is what the canonical-shape suites use), so a NEW call site
        // that forgot the era would be silently legacy - which is precisely the
        // per-code-path fork decision D69 names. This test is the guard.
        let src   = fs.readFileSync(path.join(__dirname, '../../src/AttestationConsensus.js'), 'utf8');
        let lines = src.split('\n');
        let sites = [];
        lines.forEach((line, i) => {
            if (!/this\._(build|sign)Canonical\(/.test(line)) return;
            // Skip the two forwarding calls inside _signCanonical itself, which are
            // the arity fork rather than a round's call site.
            if (/\? this\._buildCanonical|: this\._buildCanonical\(requestId/.test(line)) return;
            sites.push({ line: i + 1, text: line.trim() });
        });

        expect(sites.length, 'call-site count changed; re-derive the list').to.equal(14);
        for (let s of sites) {
            let args = s.text.slice(s.text.indexOf('(') + 1);
            // The seventh argument is the era. Counting top-level commas is enough:
            // no argument at these sites contains one outside a nested call, and a
            // nested call's commas only ever inflate the count, never deflate it.
            let depth = 0, commas = 0;
            for (let ch of args) {
                if (ch === '(') depth++;
                else if (ch === ')') { if (depth === 0) break; depth--; }
                else if (ch === ',' && depth === 0) commas++;
            }
            expect(commas, 'line ' + s.line + ' passes no era argument: ' + s.text).to.be.at.least(6);
            expect(/effectiveTime|wireEffective|myEffective/.test(s.text),
                'line ' + s.line + ' passes something that is not an era: ' + s.text).to.equal(true);
        }
    });

    it('a mirror-era round produces a canonical no legacy verifier can rebuild, and vice versa', async function () {
        // The two eras never share a signature. Proving it directly is what makes
        // the flag day safe: a signature harvested from one era cannot be replayed
        // into the other even for the same request, body, status and meta.
        let mirrorHubs = makeFederation('regtest', 3);
        let legacyHubs = makeFederation('mainnet', 3);
        try {
            await driveRound(mirrorHubs, MIRROR_BLK);
            await driveRound(legacyHubs, LEGACY_BLK);
            let mp = mirrorHubs[0].engine.pending.get(RID);
            let mirrorBytes = mirrorHubs[0].engine._buildCanonical(RID, PROVIDER, BODY, 'ok', META, MIRROR_BLK, mp.effectiveTime).toString('utf8');
            expect(mirrorBytes).to.not.equal(LEGACY_CANONICAL_LITERAL);

            let sig = mp.signatures.get(mirrorHubs[0].pubkey);
            expect(ValidatorIdentity.verify(mirrorBytes, sig, mirrorHubs[0].pubkey)).to.equal(true);
            expect(ValidatorIdentity.verify(LEGACY_CANONICAL_LITERAL, sig, mirrorHubs[0].pubkey)).to.equal(false);
        } finally { cleanup(mirrorHubs); cleanup(legacyHubs); }
    });

    it('the response hash the canonical binds is still sha256 of the body bytes', function () {
        // Pinned because the field moved into a shared module; the hash is the one
        // field the indexer re-derives from the stored payload rather than reading.
        let hubs = makeFederation('mainnet', 1);
        try {
            let h = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
            expect(LEGACY_CANONICAL_LITERAL).to.contain(h);
        } finally { cleanup(hubs); }
    });
});
