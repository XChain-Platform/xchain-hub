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
//
// ROLLCALL canonical + wire conformance against the FROZEN cross-service vector
// (xchain-documentation/protocol/test-vectors/rollcall_canonical.json).
//
// Three independent implementations must agree on these bytes: this hub PRODUCES
// them, the DOGE indexer's actions/rollcall.js rebuilds the canonical from the
// carried fields to verify each signature, and the BTC close rebuilds it AGAIN
// from its own ledger_hash. A drift between any two silently drops real presence
// proofs and evicts live validators, with no build or test failure anywhere
// unless the vector is asserted on every side. So this suite signs with REAL
// Ed25519 keys derived from the vector's own seeds and compares the resulting
// signature bytes, not merely the shape: a wrong canonical then fails here
// rather than a year later as an eviction.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const RollcallRound     = require('../../src/RollcallRound.js');
const ValidatorIdentity = require('../../src/ValidatorIdentity.js');

const VECTOR_PATH = path.join(__dirname, '..', '..', '..', 'xchain-documentation',
                              'protocol', 'test-vectors', 'rollcall_canonical.json');

// A bare canonical/wire builder: these two methods read only `this.network`, and
// exercising them without a constructor keeps the conformance assertions free of
// every unrelated boot dependency.
function builder(network) {
    let eng = Object.create(RollcallRound.prototype);
    eng.network = network;
    return eng;
}

describe('RollcallRound canonical + wire conformance', function () {

    let V;
    before(function () {
        // The vector is the ground truth, not this file. If the sibling checkout
        // is absent the suite must say so loudly rather than quietly assert
        // nothing, which is how a conformance test rots into decoration.
        assert.ok(fs.existsSync(VECTOR_PATH),
            'frozen ROLLCALL vector not found at ' + VECTOR_PATH +
            ' (the xchain-documentation sibling checkout is required)');
        V = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'));
    });

    it('reproduces the frozen EQUIV-wrapped canonical byte for byte', function () {
        const eng = builder(V.canonical.network);
        assert.strictEqual(eng._canonical(V.canonical.epoch_height, V.canonical.ledger_hash),
                           V.canonical.expected);
    });

    it('builds the canonical through equivocation_header, not by concatenation', function () {
        // The header's `||` is the key/content boundary every consumer matches on,
        // and ENGINE_TAGS.ROLLCALL is where the tag comes from. Assert the pieces
        // are really in the built string, so a hand-rolled template that happened
        // to match today cannot pass tomorrow.
        const eq  = require('../../src/equivocation_header.js');
        const eng = builder('regtest');
        const out = eng._canonical(30, V.canonical.ledger_hash);
        assert.ok(out.startsWith(eq.equivPrefix(eq.equivKey(eq.ENGINE_TAGS.ROLLCALL, '30', 0))));
        assert.strictEqual(eq.ENGINE_TAGS.ROLLCALL, 'XROLLCALL');
    });

    it('signs with REAL Ed25519 keys to the exact signature bytes in the vector', function () {
        const eng   = builder(V.canonical.network);
        const canon = eng._canonical(V.canonical.epoch_height, V.canonical.ledger_hash);
        for (const s of V.signers) {
            const id = new ValidatorIdentity(s.seed);
            assert.strictEqual(id.getPubkeyHex().toLowerCase(), s.pubkey,
                'seed ' + s.seed.slice(0, 8) + ' does not derive the vector pubkey');
            assert.strictEqual(id.sign(canon).toLowerCase(), s.sig,
                'signature over our canonical differs from the frozen one: the canonical drifted');
            assert.strictEqual(ValidatorIdentity.verify(canon, s.sig, s.pubkey), true);
        }
    });

    it('rejects every negative vector: a signature over another epoch, network or ledger_hash', function () {
        const eng   = builder(V.canonical.network);
        const canon = eng._canonical(V.canonical.epoch_height, V.canonical.ledger_hash);
        for (const bad of V.invalid) {
            assert.strictEqual(bad.verifies, false);
            // The vector's own stated canonical must not verify...
            assert.strictEqual(ValidatorIdentity.verify(bad.canonical, bad.sig, bad.pubkey), false,
                bad.name);
            // ...and the canonical it was built to attack is genuinely a different
            // string from ours, so the assertion above is testing binding rather
            // than a typo.
            assert.notStrictEqual(bad.canonical, canon, bad.name);
        }
    });

    it('binds the canonical to network, epoch and ledger_hash independently', function () {
        const lh = V.canonical.ledger_hash;
        const regtest = builder('regtest');
        const testnet = builder('testnet');
        assert.notStrictEqual(regtest._canonical(30, lh), testnet._canonical(30, lh));
        assert.notStrictEqual(regtest._canonical(30, lh), regtest._canonical(60, lh));
        assert.notStrictEqual(regtest._canonical(30, lh), regtest._canonical(30, '0'.repeat(64)));
    });

    it('epoch 0 is a real epoch, not a falsy no-op', function () {
        // _canonical is pure string building and does not consult ROLLCALL_ACTIVATION,
        // so this holds whether or not regtest is armed. A falsy check on the height
        // would build 'EQUIV|XROLLCALL||0||...' or skip the epoch outright.
        const out = builder('regtest')._canonical(0, V.canonical.ledger_hash);
        assert.strictEqual(out, 'EQUIV|XROLLCALL|0|0||regtest|0|' + V.canonical.ledger_hash);
    });

    it('reproduces both frozen WIRE payloads, byte counts included', function () {
        const eng = builder(V.canonical.network);
        const byKey = {};
        for (const s of V.signers) byKey[s.pubkey] = { pubkey: s.pubkey, sig: s.sig };

        for (const w of V.wire) {
            // Recover the pair order from the expected payload itself rather than
            // assuming it, so this asserts our JOIN and not our guess.
            const fields = w.expected.split('|');
            const pairs  = [];
            for (let i = 6; i < fields.length; i += 2) pairs.push(byKey[fields[i]]);
            assert.strictEqual(pairs.length, w.sig_count, w.name + ': pair recovery');

            const wire = eng._buildWire(V.canonical.epoch_height, V.canonical.ledger_hash,
                                        w.publisher, pairs);
            assert.strictEqual(wire, w.expected, w.name);
            assert.strictEqual(Buffer.byteLength(wire, 'utf8'), w.bytes, w.name + ': byte count');
        }
    });

    it('SIG_COUNT is the real pair count and PUBLISHER carries no signature of its own', function () {
        const eng   = builder('regtest');
        const pairs = V.signers.map(s => ({ pubkey: s.pubkey, sig: s.sig }));
        // A publisher that signed nothing: the reward attaches to the key, and the
        // wire must still carry exactly the pairs it collected.
        const wire   = eng._buildWire(30, V.canonical.ledger_hash, 'e'.repeat(64), pairs);
        const fields = wire.split('|');
        assert.strictEqual(fields[4], 'e'.repeat(64), 'PUBLISHER field');
        assert.strictEqual(Number(fields[5]), pairs.length, 'SIG_COUNT');
        assert.strictEqual(fields.length - 6, pairs.length * 2,
            'the indexer rejects any payload whose SIG_COUNT is not exactly the pair count');
        assert.strictEqual(fields.indexOf('e'.repeat(64), 6), -1,
            'the publisher key must not appear among the pairs unless it actually signed');
    });

    it('lowercases every hex field on the wire (the action name stays upper)', function () {
        const eng  = builder('regtest');
        const wire = eng._buildWire(30, V.canonical.ledger_hash.toUpperCase(), 'A'.repeat(64),
                                    [{ pubkey: 'B'.repeat(64), sig: 'C'.repeat(128) }]);
        const fields = wire.split('|');
        assert.strictEqual(fields[0], 'ROLLCALL', 'the action name is the decoder allowlist key');
        for (const f of fields.slice(1))
            assert.strictEqual(f, f.toLowerCase(), 'hex field not lowercased: ' + f.slice(0, 12));
    });

    it('splits at the vector-declared 41 pairs per action', function () {
        assert.strictEqual(RollcallRound.MAX_PAIRS_PER_ACTION, V.size_budget.max_pairs_per_action);

        const mk = n => Array.from({ length: n }, (_, i) => ({
            pubkey: i.toString(16).padStart(64, '0'), sig: i.toString(16).padStart(128, '0')
        }));
        assert.strictEqual(RollcallRound.chunkPairs(mk(41), 41).length, 1);
        assert.strictEqual(RollcallRound.chunkPairs(mk(42), 41).length, 2);
        const chunks = RollcallRound.chunkPairs(mk(83), 41);
        assert.deepStrictEqual(chunks.map(c => c.length), [41, 41, 1]);
        // Every pair rides exactly one chunk: a split may cost a second fee and
        // must never cost a signature, because the chain's present set is the
        // UNION of what lands.
        assert.strictEqual(chunks.reduce((n, c) => n + c.length, 0), 83);
        assert.strictEqual(new Set(chunks.flat().map(p => p.pubkey)).size, 83);
    });

    // ── v1: the GATES form ───────────────────────────────────────────────────
    //
    // Same contract as v0 and the same reason for it: the hub PRODUCES these bytes,
    // the DOGE parser rebuilds the canonical from the carried GATES to verify each
    // signature, and the BTC close rebuilds it again from the stored column. The
    // attack these cases exist to catch is the cheap one: a site that quietly drops
    // GATES rebuilds the v0 canonical, every signature still verifies, and the epoch
    // records a gate list nobody signed.

    it('reproduces the frozen v1 canonical, gates hash included', function () {
        const V1  = V.canonical_v1;
        const eng = builder(V1.network);
        assert.strictEqual(eng._canonical(V1.epoch_height, V1.ledger_hash, V1.gates), V1.expected);
        // The commitment is sha256 of the field EXACTLY as carried, and the vector
        // states it separately so a helper that hashed a normalised list would fail
        // here rather than at an eviction a year later.
        const rc = require('../../src/rollcall_canonical.js');
        assert.strictEqual(rc.gatesHash(V1.gates), V1.gates_hash);
        assert.ok(V1.expected.endsWith('|' + V1.gates_hash));
        assert.strictEqual(Buffer.byteLength(V1.gates, 'utf8'), V1.gates_bytes);
    });

    it('omitting gates still builds the v0 canonical byte for byte', function () {
        // The version is a function of the gates argument alone, so a v0 epoch on a
        // build that knows v1 must be unchanged: an accidental v1 canonical below the
        // height would drop every peer signature on the network.
        const eng = builder(V.canonical.network);
        const v0  = eng._canonical(V.canonical.epoch_height, V.canonical.ledger_hash);
        assert.strictEqual(v0, V.canonical.expected);
        assert.strictEqual(eng._canonical(V.canonical.epoch_height, V.canonical.ledger_hash, null), v0);
        assert.notStrictEqual(v0, V.canonical_v1.expected);
    });

    it('signs the v1 canonical with REAL keys to the exact frozen signature bytes', function () {
        const V1    = V.canonical_v1;
        const eng   = builder(V1.network);
        const canon = eng._canonical(V1.epoch_height, V1.ledger_hash, V1.gates);
        for (const s of V.signers_v1) {
            const id = new ValidatorIdentity(s.seed);
            assert.strictEqual(id.getPubkeyHex().toLowerCase(), s.pubkey,
                'seed ' + s.seed.slice(0, 8) + ' does not derive the vector pubkey');
            assert.strictEqual(id.sign(canon).toLowerCase(), s.sig,
                'signature over our v1 canonical differs from the frozen one: the canonical drifted');
            assert.strictEqual(ValidatorIdentity.verify(canon, s.sig, s.pubkey), true);
        }
    });

    it('rejects every v1 negative vector, the gates-stripped canonical included', function () {
        const V1    = V.canonical_v1;
        const canon = builder(V1.network)._canonical(V1.epoch_height, V1.ledger_hash, V1.gates);
        const realSigs = new Set(V.signers_v1.map(s => s.sig));
        for (const bad of V.invalid_v1) {
            assert.strictEqual(bad.verifies, false);
            assert.strictEqual(ValidatorIdentity.verify(bad.canonical, bad.sig, bad.pubkey), false, bad.name);
            // Each case must be a REAL mismatch and not a typo: either the canonical
            // under attack differs from ours (the stripped and the wrong-gates forms),
            // or the canonical is ours and the signature is a foreign one (the v0
            // signature offered for a v1 epoch).
            assert.ok(bad.canonical !== canon || !realSigs.has(bad.sig), bad.name);
        }
    });

    it('reproduces the frozen v1 WIRE payload, byte count included', function () {
        const V1  = V.canonical_v1;
        const eng = builder(V1.network);
        const byKey = {};
        for (const s of V.signers_v1) byKey[s.pubkey] = { pubkey: s.pubkey, sig: s.sig };

        for (const w of V.wire_v1) {
            const fields = w.expected.split('|');
            // GATES sits at index 5 and pushes the pairs one field right of v0.
            assert.strictEqual(fields[1], '1', w.name + ': VERSION');
            assert.strictEqual(fields[5], w.gates, w.name + ': GATES field position');
            assert.strictEqual(Number(fields[6]), w.sig_count, w.name + ': SIG_COUNT position');
            const pairs = [];
            for (let i = 7; i < fields.length; i += 2) pairs.push(byKey[fields[i]]);
            assert.strictEqual(pairs.length, w.sig_count, w.name + ': pair recovery');

            const wire = eng._buildWire(V1.epoch_height, V1.ledger_hash, w.publisher, pairs, w.gates);
            assert.strictEqual(wire, w.expected, w.name);
            assert.strictEqual(Buffer.byteLength(wire, 'utf8'), w.bytes, w.name + ': byte count');
        }
    });

    it('derives the v1 pair cap from the REAL gates string, not a frozen number', function () {
        const B = V.size_budget;
        assert.strictEqual(RollcallRound.ACTION_DATA_CEILING, B.max_data_bytes);
        assert.strictEqual(RollcallRound.BYTES_PER_PAIR, B.bytes_per_pair);

        // The fixture list is frozen, so its header and cap are too.
        const fixture = V.canonical_v1.gates;
        assert.strictEqual(RollcallRound.v1HeaderBytes(fixture), B.v1.fixture_header_bytes);
        assert.strictEqual(RollcallRound.maxPairsForGates(fixture), B.v1.fixture_max_pairs_per_action);

        // The LIVE list is not frozen: a gate appended to SHARED_GATES lengthens it
        // and must shrink the cap on its own. Assert the formula, and that a longer
        // list really does buy fewer pairs, rather than today's number.
        const live = require('../../src/consensus_rules_digest.js').knownGateKeys().join(',');
        assert.strictEqual(
            RollcallRound.maxPairsForGates(live),
            Math.floor((B.max_data_bytes - RollcallRound.v1HeaderBytes(live)) / B.bytes_per_pair));
        const longer = live + ',zzz_module.ZZZ_EXPORT'.repeat(40);
        assert.ok(RollcallRound.maxPairsForGates(longer) < RollcallRound.maxPairsForGates(live),
            'a longer GATES list must cost pairs, or the cap is not derived from it');
        // A list past the ceiling leaves room for nothing, and 0 is the refusal the
        // publish path checks; chunkPairs would otherwise silently fall back to 41.
        assert.strictEqual(RollcallRound.maxPairsForGates('a.B,'.repeat(3000)), 0);
        // v0 is untouched by all of it.
        assert.strictEqual(RollcallRound.maxPairsForGates(null), B.max_pairs_per_action);
        assert.strictEqual(RollcallRound.maxPairsForGates(undefined), B.max_pairs_per_action);
    });

    it('a full-cap v1 action fits the ceiling and one more pair does not', function () {
        const eng   = builder('mainnet');
        const gates = require('../../src/consensus_rules_digest.js').knownGateKeys().join(',');
        const cap   = RollcallRound.maxPairsForGates(gates);
        assert.ok(cap > 0);
        const mk = n => Array.from({ length: n }, (_, i) => ({
            pubkey: i.toString(16).padStart(64, '0'), sig: i.toString(16).padStart(128, '0')
        }));
        // A 7-digit epoch is the widest header the cap was derived against.
        const at   = eng._buildWire(1008000, V.canonical.ledger_hash, 'a'.repeat(64), mk(cap), gates);
        const over = eng._buildWire(1008000, V.canonical.ledger_hash, 'a'.repeat(64), mk(cap + 1), gates);
        assert.ok(Buffer.byteLength(at, 'utf8') <= V.size_budget.max_data_bytes,
            'a full v1 action is ' + Buffer.byteLength(at, 'utf8') + ' bytes, past the ' +
            V.size_budget.max_data_bytes + '-byte ceiling; the decoder DROPS an oversize action silently');
        assert.ok(Buffer.byteLength(over, 'utf8') > V.size_budget.max_data_bytes,
            'the v1 cap is below the real ceiling; the split is costing fees for nothing');
    });

    it('a full 41-pair action stays inside the protocol action-data ceiling', function () {
        const eng   = builder('mainnet');
        const pairs = Array.from({ length: V.size_budget.max_pairs_per_action }, (_, i) => ({
            pubkey: i.toString(16).padStart(64, '0'), sig: i.toString(16).padStart(128, '0')
        }));
        // A 7-digit epoch is the header the size budget was measured against.
        const wire = eng._buildWire(1008000, V.canonical.ledger_hash, 'a'.repeat(64), pairs);
        assert.ok(Buffer.byteLength(wire, 'utf8') <= V.size_budget.max_data_bytes,
            'a full action is ' + Buffer.byteLength(wire, 'utf8') + ' bytes, past the ' +
            V.size_budget.max_data_bytes + '-byte ceiling; the decoder DROPS an oversize action silently');
        // And 42 would not fit, so the bound is the real one and not slack.
        const over = eng._buildWire(1008000, V.canonical.ledger_hash, 'a'.repeat(64),
                                    pairs.concat([{ pubkey: 'f'.repeat(64), sig: 'f'.repeat(128) }]));
        assert.ok(Buffer.byteLength(over, 'utf8') > V.size_budget.max_data_bytes,
            'MAX_PAIRS_PER_ACTION is below the real ceiling; the split is costing fees for nothing');
    });
});
