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

const { bftQuorumOrSingle } = require('../../src/lib/bft_quorum.js');

// Reusable validator sets for testing quorum/leader logic
// Each entry has { pubkey, addr } matching the shape used throughout the hub

function makeValidator(i) {
    let hex = String(i).padStart(2, '0');
    return {
        pubkey: hex.repeat(32),
        addr:   'ws://validator-' + i + ':10001'
    };
}

const VALIDATORS_1  = [makeValidator(1)];
const VALIDATORS_3  = [makeValidator(1), makeValidator(2), makeValidator(3)];
const VALIDATORS_4  = [makeValidator(1), makeValidator(2), makeValidator(3), makeValidator(4)];
const VALIDATORS_7  = Array.from({ length: 7 }, (_, i) => makeValidator(i + 1));
const VALIDATORS_10 = Array.from({ length: 10 }, (_, i) => makeValidator(i + 1));
const VALIDATORS_13 = Array.from({ length: 13 }, (_, i) => makeValidator(i + 1));

// STAKE_WEIGHTED_QUORUM fixtures: validators carry a staking source + weight.
function makeWeightedValidator(i, source, weight) {
    let v = makeValidator(i);
    return { pubkey: v.pubkey, addr: v.addr, source: source, weight: String(weight) };
}

// One whale source holding >2/3 of stake + three small distinct sources.
// S = 1000 + 100 + 100 + 100 = 1300. Whale alone: 3·1000 = 3000 > 2·1300 = 2600
// (a COUNT minority of one clears the weighted threshold); any subset of the
// three small sources is a COUNT majority but a STAKE minority.
const WEIGHTED_VALIDATORS_4 = [
    makeWeightedValidator(1, 'srcWhale', '1000'),
    makeWeightedValidator(2, 'src2', '100'),
    makeWeightedValidator(3, 'src3', '100'),
    makeWeightedValidator(4, 'src4', '100')
];

// Build a getActiveWeightSnapshot-shaped result from weighted validators.
function makeWeightSnapshot(validators, blockIndex) {
    let sources = new Set(validators.map(v => v.source));
    return {
        capability:  '*',
        blockIndex:  blockIndex,
        count:       validators.length,
        sourceCount: sources.size,
        validators:  validators.map(v => ({ pubkey: v.pubkey, source: v.source, weight: v.weight }))
    };
}

// Build a getActiveValidatorSnapshot-shaped whole-federation snapshot whose
// members are the validators under test. Consensus elects its leader from the
// snapshot population rather than the live validatorSet, so a snapshot
// carrying a placeholder pubkey no longer stands in for a real one: it now
// describes a federation with exactly one unaddressable member.
function makeFederationSnapshot(validators, blockIndex, amount) {
    return {
        capability: '*',
        blockIndex: blockIndex,
        count:      validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: String(amount || '50000') }))
    };
}

// A capability-snapshot double for a hub whose price rounds must be DETERMINISTIC.
// A federated OracleConsensus/Consensus refuses a round with no block-anchored snapshot
// (sizing quorum from the local live set makes the finalization threshold a function of
// this hub's indexer reachability), so a harness that only wants to exercise something
// else still has to model the snapshot. Membership mirrors the validators handed in, and
// the quorum is the shipped majority-floored BFT threshold over them, so the round is
// sized exactly as the live-set fallback would size it.
function makeCapabilitySnapshotStub(validators, amount) {
    let snapshotFor = (capability, blockIndex) => ({
        capability: capability,
        blockIndex: Number(blockIndex),
        count:      validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: String(amount || '50000') }))
    });
    return {
        getSnapshot:       async (capability, blockIndex) => snapshotFor(capability, blockIndex),
        getWeightSnapshot: async (capability, blockIndex) => snapshotFor(capability, blockIndex),
        getQuorum:         (snapshot) => bftQuorumOrSingle(
            snapshot && Array.isArray(snapshot.validators) ? snapshot.validators.length : 0, 0)
    };
}

// Sample price data
const SAMPLE_PRICES = [
    { coinPair: 'BTC/USD', price: '100000.12345678', sources: 2 },
    { coinPair: 'LTC/USD', price: '85.50000000',     sources: 2 },
    { coinPair: 'DOGE/USD', price: '0.15000000',     sources: 2 }
];

// Build an oracle submission map from an array of { sender, prices }
// The signing key makeValidator(i) would have produced for a fixture addr, or
// null for an addr outside that scheme. Submission maps are keyed by sender but
// every entry carries the PROVEN signing key (OracleRound takes it straight off
// the envelope), and the snapshot-membership filter keys on that key, so a
// fixture map without it is not the shape the engine actually sees.
function fixturePubkeyForAddr(addr) {
    let m = /^ws:\/\/validator-(\d+):/.exec(String(addr || ''));
    return m ? makeValidator(Number(m[1])).pubkey : null;
}

// A stable 64-hex signing key for an arbitrary test sender. Distinct senders get
// distinct keys and one sender always gets the same key, which is what keeps
// per-sender first-wins and per-key dedup assertions meaningful once admission
// and dedup key on the signing key rather than the addr. Tests that need two
// senders to SHARE a key pass it explicitly instead.
function pubkeyForTestSender(sender) {
    let known = fixturePubkeyForAddr(sender);
    if (known) return known;
    return require('crypto').createHash('sha256').update(String(sender)).digest('hex');
}

// entry.pubkey is honoured verbatim when supplied (including an explicit null),
// which is how a test binds two senders to ONE key to exercise dedup.
function buildSubmissions(entries) {
    let map = new Map();
    for (let entry of entries) {
        map.set(entry.sender, {
            prices:    entry.prices,
            sources:   entry.sources || 2,
            timestamp: entry.timestamp || Date.now(),
            pubkey:    Object.prototype.hasOwnProperty.call(entry, 'pubkey')
                ? entry.pubkey
                : fixturePubkeyForAddr(entry.sender)
        });
    }
    return map;
}

// Build a simple submission map where all validators submit the same prices
function buildUniformSubmissions(validators, prices) {
    let entries = validators.map(v => ({
        sender: v.addr,
        pubkey: v.pubkey,
        prices: prices
    }));
    return buildSubmissions(entries);
}

module.exports = {
    makeValidator,
    fixturePubkeyForAddr,
    pubkeyForTestSender,
    makeWeightedValidator,
    makeWeightSnapshot,
    makeFederationSnapshot,
    makeCapabilitySnapshotStub,
    VALIDATORS_1,
    VALIDATORS_3,
    VALIDATORS_4,
    VALIDATORS_7,
    VALIDATORS_10,
    VALIDATORS_13,
    WEIGHTED_VALIDATORS_4,
    SAMPLE_PRICES,
    buildSubmissions,
    buildUniformSubmissions
};
