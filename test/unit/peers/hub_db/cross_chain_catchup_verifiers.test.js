'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');

const ValidatorIdentity = require('../../../../src/validators/identity.js');
const CrossChainDexEngine = require('../../../../src/cross_chain/dex_engine.js');
const CrossChainCallEngine = require('../../../../src/cross_chain/call_engine.js');
const CrossChainBridgeEngine = require('../../../../src/cross_chain/bridge_engine.js');
const { listSnapshotCanonical } = require('../../../../src/cross_chain/list/canonical.js');
const registry = require('../../../../src/peers/hub_db/catchup_verifiers.js');

const TABLES = [
    'cross_chain_matches',
    'cross_chain_calls',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots'
];

const CANONICAL_ENGINES = {
    cross_chain_matches: Object.create(CrossChainDexEngine.prototype),
    cross_chain_calls: Object.create(CrossChainCallEngine.prototype),
    bridge_transfers: Object.create(CrossChainBridgeEngine.prototype),
    policy_snapshots: Object.create(CrossChainBridgeEngine.prototype),
    list_snapshots: { canonicalMatch: listSnapshotCanonical }
};

const ROWS = {
    cross_chain_matches: {
        match_id: 'a'.repeat(64), a_chain: 'BTC', a_action_index: 7, a_tick: 'AAA',
        a_amount: '20', a_ownership: 0, a_payout_addr: 'a-address',
        b_chain: 'LTC', b_action_index: 8, b_tick: 'BBB', b_amount: '40',
        b_ownership: 0, b_payout_addr: 'b-address', effective_time: 1700000000
    },
    cross_chain_calls: {
        phase: 'dispatch', call_id: 'b'.repeat(64), source_chain: 'BTC', source_action_index: 9,
        source_contract_index: 3, target_chain: 'DOGE', target_contract_index: 4,
        method: 'settle', params_json: '["x"]', gas_limit: 50000, cross_hops: 1,
        effective_time: 1700000001
    },
    bridge_transfers: {
        transfer_id: 'c'.repeat(64), tick: 'TOKEN', decimals: 8, src_chain: 'BTC',
        src_action_index: 10, src_address: 'src-address', dest_chain: 'DOGE',
        dest_address: 'dest-address', amount: '5.00000000', effective_time: 1700000002
    },
    policy_snapshots: {
        snapshot_id: 'd'.repeat(64), origin_chain: 'BTC', tick: 'TOKEN', policy_seq: 2,
        origin_block: 900, policy_hash: 'e'.repeat(64), effective_time: 1700000003
    },
    list_snapshots: {
        snapshot_id: 'f'.repeat(64), home_chain: 'BTC', home_list_index: 11,
        list_type: 'allow', seq: 3, kind: 'full', origin_block: 901,
        members_hash: '1'.repeat(64), meta_hash: '2'.repeat(64)
    }
};

const CANONICAL_PATTERNS = {
    cross_chain_matches: /^EQUIV\|XDEX\|.*\|\|XMATCH\|/,
    cross_chain_calls: /^EQUIV\|XCALL\|.*\|\|XCALL\|DISPATCH\|/,
    bridge_transfers: /^EQUIV\|XBRIDGE\|.*\|\|XBRIDGE\|/,
    policy_snapshots: /^EQUIV\|XPOLICY\|.*\|\|XPOLICY\|/,
    list_snapshots: /^EQUIV\|XLISTSHARE\|.*\|\|XLISTSHARE\|/
};

const TAMPERED_FIELDS = {
    cross_chain_matches: ['a_amount', '21'],
    cross_chain_calls: ['method', 'tampered'],
    bridge_transfers: ['amount', '6.00000000'],
    policy_snapshots: ['policy_hash', '3'.repeat(64)],
    list_snapshots: ['members_hash', '4'.repeat(64)]
};

function signedContext(count) {
    const identities = Array.from({ length: count }, () =>
        new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
    const validators = identities.map((identity, index) => ({
        pubkey: identity.getPubkeyHex(),
        source: 'source-' + index,
        amount: '1'
    }));
    return {
        identities,
        context: {
            resolveCapabilityValidators: async () => validators
        }
    };
}

function rowFor(table) {
    return Object.assign({
        status: 'finalized',
        snapshot_block: 1,
        network: 'regtest',
        finalizing_view: 2,
        admit_blocks: { BTC: 100, DOGE: 200, LTC: 300 }
    }, ROWS[table]);
}

function canonicalFor(table, row) {
    return CANONICAL_ENGINES[table].canonicalMatch(row, row.finalizing_view);
}

function finalizedRow(table, set, signatureCount, overrides) {
    const row = Object.assign(rowFor(table), overrides);
    const canonical = canonicalFor(table, row);
    row.validator_signatures = JSON.stringify(set.identities.slice(0, signatureCount).map(identity => ({
        pubkey: identity.getPubkeyHex(),
        sig: identity.sign(canonical)
    })));
    return row;
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
            const row = finalizedRow(table, set, 3);
            expect(canonicalFor(table, row)).to.match(CANONICAL_PATTERNS[table]);
            const accepted = await registry.getCatchupVerifier(table)(
                row, set.context);
            expect(accepted).to.equal(true);
        });

        it('rejects signed ' + table + ' bytes after a consensus field changes', async function () {
            const set = signedContext(4);
            const row = finalizedRow(table, set, 3);
            row[TAMPERED_FIELDS[table][0]] = TAMPERED_FIELDS[table][1];
            const accepted = await registry.getCatchupVerifier(table)(row, set.context);
            expect(accepted).to.equal(false);
        });
    }

    it('does not substitute a generic canonical override for production bytes', async function () {
        const set = signedContext(4);
        set.context.engine = { canonicalMatch: () => 'substitute-canonical' };
        const accepted = await registry.getCatchupVerifier('cross_chain_matches')(
            finalizedRow('cross_chain_matches', set, 3), set.context);
        expect(accepted).to.equal(true);
    });
});

describe('cross-chain catch-up verifier row eligibility', function () {
    it('skips pending rows before signer-set resolution', async function () {
        let resolved = false;
        const accepted = await registry.getCatchupVerifier('cross_chain_matches')({
            status: 'pending',
            snapshot_block: 1,
            network: 'regtest',
            validator_signatures: '[]'
        }, {
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
            finalizedRow('cross_chain_calls', set, 2), set.context);
        expect(accepted).to.equal(false);
    });

    it('keeps malformed members in the count-quorum denominator', async function () {
        const set = signedContext(2);
        const row = finalizedRow('cross_chain_matches', set, 2, { network: 'mainnet' });
        set.context.resolveCapabilityValidators = async () => [
            { pubkey: set.identities[0].getPubkeyHex(), amount: '1' },
            { pubkey: set.identities[1].getPubkeyHex(), amount: '1' },
            { pubkey: 'not-a-pubkey', amount: '1' },
            { pubkey: 'also-not-a-pubkey', amount: '1' }
        ];

        const accepted = await registry.getCatchupVerifier('cross_chain_matches')(row, set.context);
        expect(accepted).to.equal(false);
    });
});

describe('cross-chain catch-up verifier signature validation', function () {
    it('deduplicates stake carried by two keys from one source', async function () {
        const set = signedContext(3);
        const validators = [
            { pubkey: set.identities[0].getPubkeyHex(), source: 'source-a', amount: '60' },
            { pubkey: set.identities[1].getPubkeyHex(), source: 'source-a', amount: '60' },
            { pubkey: set.identities[2].getPubkeyHex(), source: 'source-b', amount: '40' }
        ];
        set.context.resolveCapabilityValidators = async () => validators;

        const accepted = await registry.getCatchupVerifier('list_snapshots')(
            finalizedRow('list_snapshots', set, 2), set.context);
        expect(accepted).to.equal(false);
    });

    it('rejects forged, duplicate and out-of-set signatures', async function () {
        const set = signedContext(4);
        const outsider = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        const row = finalizedRow('bridge_transfers', set, 2);
        const canonical = canonicalFor('bridge_transfers', row);
        const signatures = JSON.parse(row.validator_signatures);
        signatures.push(signatures[0]);
        signatures.push({ pubkey: set.identities[2].getPubkeyHex(), sig: outsider.sign(canonical) });
        signatures.push({ pubkey: outsider.getPubkeyHex(), sig: outsider.sign(canonical) });
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
            resolveCapabilityValidators: async () => []
        });
        expect(accepted).to.equal(false);
    });
});
