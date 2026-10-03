'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const checkpointForms = require('../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const attestMethods = require('../../../../src/anchor/publisher/attest_round.js');
const archiveAttestMethods = require('../../../../src/anchor/publisher/archive/attest.js');
const rewardMethods = require('../../../../src/anchor/publisher/reward.js');
const ar = require('../../../../src/consensus/gates/anchor_reward_gate.js');

const MODULE_PATH = require.resolve('../../../../src/peers/hub_db/catchup_verifiers.js');
const EXPECTED_TABLES = [
    'price_snapshots',
    'oracle_prices',
    'cross_chain_matches',
    'capability_snapshots',
    'cross_chain_calls',
    'state_checkpoints',
    'anchor_reward_attestations',
    'attestation_responses',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots'
];
const BUILT_IN_TABLES = ['state_checkpoints', 'anchor_reward_attestations'];

function identities(count) {
    return Array.from({ length: count }, () => {
        const pair = ValidatorIdentity.generate();
        return new ValidatorIdentity(pair.privkeyHex);
    });
}

function checkpointRow(snapshotBlock) {
    return {
        chain: 'BTC', network: 'mainnet', block_index: 91,
        block_hash: 'block', ledger_hash: 'ledger', actions_hash: 'actions',
        contract_hash: 'contract', checkpoint_seq: snapshotBlock,
        snapshot_block: snapshotBlock, state_root: null,
        state_root_version: null, block_merkle_root: null,
        block_merkle_version: null
    };
}

function checkpointHub(signers, network) {
    const validators = signers.map(s => ({
        pubkey: s.getPubkeyHex(), source: '', weight: '1', amount: '1'
    }));
    const calls = [];
    return {
        calls,
        stateCheckpoints: {
            network: network || 'mainnet',
            normalizeCheckpoint: row => Object.assign({}, row),
            assertCheckpointNetwork(cp) {
                if(cp.network !== this.network) throw new Error('network mismatch');
            },
            async resolveCapabilityValidators(capability, block) {
                calls.push({ capability, block });
                return validators;
            }
        }
    };
}

function signCheckpoint(row, signers) {
    const canonical = checkpointForms.canonicalCheckpoint(row);
    row.validator_signatures = JSON.stringify(signers.map(s => ({
        pubkey: s.getPubkeyHex(), sig: s.sign(canonical)
    })));
    return row;
}

function rewardHub(signers, network) {
    const signingSet = signers.map(s => ({
        pubkey: s.getPubkeyHex(), source: '', amount: '1'
    }));
    const calls = [];
    return {
        calls,
        signingSet,
        stateAnchorPublisher: {
            network: network || 'mainnet',
            attestationCanonical: attestMethods.attestationCanonical,
            archiveAttestationCanonical: archiveAttestMethods.archiveAttestationCanonical,
            federationQuorumMet: rewardMethods.federationQuorumMet,
            async resolveCapabilitySet(capability, block, resolvedNetwork) {
                calls.push({ capability, block, network: resolvedNetwork });
                return signingSet;
            }
        }
    };
}

function rewardRow(type, snapshotBlock, publisher) {
    return {
        chain: type === 'anchor_bundle' ? 'DOGE' : 'BTC', network: 'mainnet',
        reward_type: type, round_reference: type === 'anchor_bundle' ? snapshotBlock : 7,
        snapshot_block: snapshotBlock, publisher,
        reward_amount: type === 'anchor_bundle' ? ar.ANCHOR_REWARD_AMOUNT : ar.ARCHIVE_REWARD_AMOUNT
    };
}

function signReward(row, signers, publisher) {
    const canonical = row.reward_type === 'anchor_bundle'
        ? attestMethods.attestationCanonical.call({}, row, publisher)
        : archiveAttestMethods.archiveAttestationCanonical.call({}, row, row.round_reference, publisher);
    row.publisher_attestations = JSON.stringify(signers.map(s => ({
        pubkey: s.getPubkeyHex(), sig: s.sign(canonical)
    })));
    return row;
}

describe('catch-up verifier registry', function () {
    let registry;

    beforeEach(function () {
        delete require.cache[MODULE_PATH];
        registry = require(MODULE_PATH);
    });

    afterEach(function () {
        delete require.cache[MODULE_PATH];
    });

    it('exports the immutable set of eleven mirrored table names', function () {
        expect(registry.MIRRORED_TABLES).to.deep.equal(EXPECTED_TABLES);
        expect(Object.isFrozen(registry.MIRRORED_TABLES)).to.equal(true);
    });

    it('registers and returns a verifier for every unclaimed mirrored table', function () {
        for (const table of EXPECTED_TABLES) {
            if (BUILT_IN_TABLES.includes(table)) {
                expect(registry.getCatchupVerifier(table)).to.be.a('function');
                continue;
            }
            const verifier = () => table;
            registry.registerCatchupVerifier(table, verifier);
            expect(registry.getCatchupVerifier(table)).to.equal(verifier);
        }
    });

    it('refuses an unknown table name', function () {
        expect(() => registry.registerCatchupVerifier('unknown_table', () => true))
            .to.throw('Unknown mirrored table: unknown_table');
        expect(registry.getCatchupVerifier('unknown_table')).to.equal(undefined);
    });

    it('refuses a second registration and preserves the first verifier', function () {
        const first = () => true;
        registry.registerCatchupVerifier('oracle_prices', first);

        expect(() => registry.registerCatchupVerifier('oracle_prices', () => false))
            .to.throw('Catch-up verifier already registered for table: oracle_prices');
        expect(registry.getCatchupVerifier('oracle_prices')).to.equal(first);
    });

    it('refuses a non-function verifier without reserving the table', function () {
        expect(() => registry.registerCatchupVerifier('cross_chain_matches', null))
            .to.throw(TypeError, 'Catch-up verifier must be a function');

        const verifier = () => true;
        registry.registerCatchupVerifier('cross_chain_matches', verifier);
        expect(registry.getCatchupVerifier('cross_chain_matches')).to.equal(verifier);
    });
});

describe('state checkpoint catch-up verifier', function () {
    let registry;

    before(function () {
        registry = require(MODULE_PATH);
    });

    it('accepts a checkpoint only with a valid count quorum from its height', async function () {
        const keys = identities(4);
        const hub = checkpointHub(keys);
        const row = signCheckpoint(checkpointRow(100), keys.slice(0, 3));
        const verify = registry.getCatchupVerifier('state_checkpoints');

        expect(await verify(row, hub)).to.equal(true);
        expect(hub.calls).to.deep.equal([{ capability: 'oracle_publish', block: 100 }]);
        row.validator_signatures = JSON.stringify(JSON.parse(row.validator_signatures).slice(0, 2));
        expect(await verify(row, hub)).to.equal(false);
    });

    it('rejects checkpoint signature replay, duplication, malformed proof, and network drift', async function () {
        const keys = identities(4);
        const hub = checkpointHub(keys);
        const verify = registry.getCatchupVerifier('state_checkpoints');
        const valid = signCheckpoint(checkpointRow(100), keys.slice(0, 3));
        const signatures = JSON.parse(valid.validator_signatures);

        const tampered = Object.assign({}, valid, { block_hash: 'other' });
        expect(await verify(tampered, hub)).to.equal(false);
        const duplicated = Object.assign({}, valid, { validator_signatures: JSON.stringify([signatures[0], signatures[0]]) });
        expect(await verify(duplicated, hub)).to.equal(false);
        expect(await verify(Object.assign({}, valid, { validator_signatures: '{' }), hub)).to.equal(false);
        expect(await verify(Object.assign({}, valid, { network: 'testnet' }), hub)).to.equal(false);
    });

    it('uses the live stake-weighted checkpoint threshold and fails closed on truncation', async function () {
        const keys = identities(3);
        const hub = checkpointHub(keys, 'testnet');
        const validators = await hub.stateCheckpoints.resolveCapabilityValidators('oracle_publish', 12);
        validators.forEach((v, i) => { v.source = 'source-' + i; v.weight = ['70', '20', '10'][i]; });
        const verify = registry.getCatchupVerifier('state_checkpoints');
        const row = signCheckpoint(Object.assign(checkpointRow(12), { network: 'testnet' }), [keys[0]]);

        expect(await verify(row, hub)).to.equal(true);
        validators.truncated = true;
        expect(await verify(row, hub)).to.equal(false);
    });
});

describe('anchor reward catch-up verifier', function () {
    let registry;

    before(function () {
        registry = require(MODULE_PATH);
    });

    it('accepts bundle and archive reward attestations only with their valid count quorum', async function () {
        const keys = identities(4);
        const hub = rewardHub(keys);
        const verify = registry.getCatchupVerifier('anchor_reward_attestations');
        const bundle = signReward(rewardRow('anchor_bundle', 100, keys[0].getPubkeyHex()), keys.slice(0, 3), keys[0].getPubkeyHex());
        const archive = signReward(rewardRow('anchor_archive', 100, keys[0].getPubkeyHex()), keys.slice(0, 3), keys[0].getPubkeyHex());

        expect(await verify(bundle, hub)).to.equal(true);
        expect(await verify(archive, hub)).to.equal(true);
        expect(hub.calls).to.deep.equal([
            { capability: 'oracle_publish', block: 100, network: 'mainnet' },
            { capability: 'oracle_publish', block: 100, network: 'mainnet' }
        ]);
    });

    it('rejects short, replayed, and semantically malformed reward attestations', async function () {
        const keys = identities(4);
        const hub = rewardHub(keys);
        const verify = registry.getCatchupVerifier('anchor_reward_attestations');
        const row = signReward(rewardRow('anchor_bundle', 100, keys[0].getPubkeyHex()), keys.slice(0, 3), keys[0].getPubkeyHex());
        const signatures = JSON.parse(row.publisher_attestations);

        expect(await verify(Object.assign({}, row, { publisher_attestations: JSON.stringify(signatures.slice(0, 2)) }), hub)).to.equal(false);
        expect(await verify(Object.assign({}, row, { snapshot_block: 101, round_reference: 101 }), hub)).to.equal(false);
        expect(await verify(Object.assign({}, row, { round_reference: 99 }), hub)).to.equal(false);
        expect(await verify(Object.assign({}, row, { reward_amount: '999' }), hub)).to.equal(false);
        expect(await verify(Object.assign({}, row, { publisher: identities(1)[0].getPubkeyHex() }), hub)).to.equal(false);
    });

    it('uses the live stake-weighted reward threshold and fails closed on truncation', async function () {
        const keys = identities(3);
        const hub = rewardHub(keys, 'testnet');
        hub.signingSet.forEach((v, i) => {
            v.source = 'source-' + i;
            v.amount = ['70', '20', '10'][i];
        });
        const verify = registry.getCatchupVerifier('anchor_reward_attestations');
        const row = Object.assign(rewardRow('anchor_bundle', 12, keys[0].getPubkeyHex()), { network: 'testnet' });
        signReward(row, [keys[0]], keys[0].getPubkeyHex());

        expect(await verify(row, hub)).to.equal(true);
        hub.signingSet.truncated = true;
        expect(await verify(row, hub)).to.equal(false);
    });
});
