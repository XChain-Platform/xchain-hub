'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    isAdmissibleSigner,
    provenPubkey,
    registryHasPubkey
} = require('../../../src/lib/chain_signer_admission');

describe('chain signer admission', function () {
    describe('provenPubkey', function () {
        it('lowercases the envelope signing key', function () {
            expect(provenPubkey({ sig_pubkey: 'AbC123' })).to.equal('abc123');
        });

        it('returns null without a string signing key', function () {
            expect(provenPubkey(null)).to.equal(null);
            expect(provenPubkey({})).to.equal(null);
            expect(provenPubkey({ sig_pubkey: 123 })).to.equal(null);
        });
    });

    describe('registryHasPubkey', function () {
        it('matches case-insensitively over a Map-like registry', function () {
            const registry = { values: () => ['OTHER', 'AbC123'][Symbol.iterator]() };
            expect(registryHasPubkey(registry, 'abc123')).to.equal(true);
        });

        it('returns false for a missing or non-iterable registry', function () {
            expect(registryHasPubkey(null, 'abc123')).to.equal(false);
            expect(registryHasPubkey({}, 'abc123')).to.equal(false);
        });
    });

    describe('isAdmissibleSigner', function () {
        it('admits a key in the chain-effective signer set', function () {
            const peerManager = {
                validatorPubkeys: new Map([['validator', 'different']]),
                effectiveSignerSet: new Set(['abc123'])
            };
            expect(isAdmissibleSigner(peerManager, { sig_pubkey: 'AbC123' })).to.equal(true);
        });

        it('admits a key in the validator registry', function () {
            const peerManager = {
                validatorPubkeys: new Map([['validator', 'AbC123']]),
                effectiveSignerSet: new Set()
            };
            expect(isAdmissibleSigner(peerManager, { sig_pubkey: 'abc123' })).to.equal(true);
        });

        it('refuses an envelope without a signing key', function () {
            const peerManager = { validatorPubkeys: new Map(), effectiveSignerSet: new Set() };
            expect(isAdmissibleSigner(peerManager, {})).to.equal(false);
        });

        it('refuses a key unknown to the registry and chain set', function () {
            const peerManager = {
                validatorPubkeys: new Map([['validator', 'registered']]),
                effectiveSignerSet: new Set(['on-chain'])
            };
            expect(isAdmissibleSigner(peerManager, { sig_pubkey: 'unknown' })).to.equal(false);
        });

        it('admits any proven key when both authorization sets are empty', function () {
            const peerManager = { validatorPubkeys: new Map(), effectiveSignerSet: new Set() };
            expect(isAdmissibleSigner(peerManager, { sig_pubkey: 'unknown' })).to.equal(true);
        });

        it('admits any proven key when the chain set is absent and the registry is empty', function () {
            const peerManager = { validatorPubkeys: new Map() };
            expect(isAdmissibleSigner(peerManager, { sig_pubkey: 'unknown' })).to.equal(true);
        });

        it('refuses an unknown key when only the registry is empty', function () {
            const peerManager = {
                validatorPubkeys: new Map(),
                effectiveSignerSet: new Set(['on-chain'])
            };
            expect(isAdmissibleSigner(peerManager, { sig_pubkey: 'unknown' })).to.equal(false);
        });
    });
});
