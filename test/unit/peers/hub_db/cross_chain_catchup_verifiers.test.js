'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');

const ValidatorIdentity = require('../../../../src/validators/identity.js');
const registry = require('../../../../src/peers/hub_db/catchup_verifiers.js');

const TABLES = [
    'cross_chain_matches',
    'cross_chain_calls',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots'
];

function signedContext(count) {
    const identities = Array.from({ length: count }, () =>
        new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
    const canonical = 'catch-up-canonical';
    const validators = identities.map((identity, index) => ({
        pubkey: identity.getPubkeyHex(),
        source: 'source-' + index,
        amount: '1'
    }));
    return {
        canonical,
        identities,
        context: {
            engine: { canonicalMatch: () => canonical },
            resolveCapabilityValidators: async () => validators
        }
    };
}

function finalizedRow(set, signatureCount) {
    return {
        status: 'finalized',
        snapshot_block: 1,
        network: 'regtest',
        finalizing_view: 2,
        validator_signatures: JSON.stringify(set.identities.slice(0, signatureCount).map(identity => ({
            pubkey: identity.getPubkeyHex(),
            sig: identity.sign(set.canonical)
        })))
    };
}

describe('cross-chain catch-up verifiers', function () {
    it('registers all five signed final-row verifiers', function () {
        for (const table of TABLES) {
            expect(registry.getCatchupVerifier(table), table).to.be.a('function');
        }
    });

    for (const table of TABLES) {
        it('accepts a quorum-signed finalized ' + table + ' row', async function () {
            const set = signedContext(4);
            const accepted = await registry.getCatchupVerifier(table)(
                finalizedRow(set, 3), set.context);
            expect(accepted).to.equal(true);
        });
    }

    it('skips pending rows before signer-set resolution', async function () {
        let resolved = false;
        const accepted = await registry.getCatchupVerifier('cross_chain_matches')({
            status: 'pending',
            snapshot_block: 1,
            network: 'regtest',
            validator_signatures: '[]'
        }, {
            engine: { canonicalMatch: () => 'unused' },
            resolveCapabilityValidators: async () => {
                resolved = true;
                return [];
            }
        });
        expect(accepted).to.equal(false);
        expect(resolved).to.equal(false);
    });

    it('rejects a finalized row below quorum', async function () {
        const set = signedContext(4);
        const accepted = await registry.getCatchupVerifier('cross_chain_calls')(
            finalizedRow(set, 2), set.context);
        expect(accepted).to.equal(false);
    });

    it('keeps malformed members in the count-quorum denominator', async function () {
        const set = signedContext(2);
        const row = finalizedRow(set, 2);
        row.network = 'mainnet';
        set.context.resolveCapabilityValidators = async () => [
            { pubkey: set.identities[0].getPubkeyHex(), amount: '1' },
            { pubkey: set.identities[1].getPubkeyHex(), amount: '1' },
            { pubkey: 'not-a-pubkey', amount: '1' },
            { pubkey: 'also-not-a-pubkey', amount: '1' }
        ];

        const accepted = await registry.getCatchupVerifier('cross_chain_matches')(row, set.context);
        expect(accepted).to.equal(false);
    });

    it('deduplicates stake carried by two keys from one source', async function () {
        const set = signedContext(3);
        const validators = [
            { pubkey: set.identities[0].getPubkeyHex(), source: 'source-a', amount: '60' },
            { pubkey: set.identities[1].getPubkeyHex(), source: 'source-a', amount: '60' },
            { pubkey: set.identities[2].getPubkeyHex(), source: 'source-b', amount: '40' }
        ];
        set.context.resolveCapabilityValidators = async () => validators;

        const accepted = await registry.getCatchupVerifier('list_snapshots')(
            finalizedRow(set, 2), set.context);
        expect(accepted).to.equal(false);
    });

    it('rejects forged, duplicate and out-of-set signatures', async function () {
        const set = signedContext(4);
        const outsider = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const row = finalizedRow(set, 2);
        const signatures = JSON.parse(row.validator_signatures);
        signatures.push(signatures[0]);
        signatures.push({ pubkey: set.identities[2].getPubkeyHex(), sig: outsider.sign(set.canonical) });
        signatures.push({ pubkey: outsider.getPubkeyHex(), sig: outsider.sign(set.canonical) });
        row.validator_signatures = JSON.stringify(signatures);

        const accepted = await registry.getCatchupVerifier('bridge_transfers')(row, set.context);
        expect(accepted).to.equal(false);
    });

    it('rejects malformed signatures and an unavailable signer snapshot', async function () {
        const malformed = {
            status: 'finalized',
            snapshot_block: 1,
            network: 'regtest',
            validator_signatures: '{'
        };
        const accepted = await registry.getCatchupVerifier('policy_snapshots')(malformed, {
            engine: { canonicalMatch: () => 'canonical' },
            resolveCapabilityValidators: async () => []
        });
        expect(accepted).to.equal(false);
    });
});
