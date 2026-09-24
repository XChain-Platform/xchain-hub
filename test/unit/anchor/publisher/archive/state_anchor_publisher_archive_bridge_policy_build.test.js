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

// buildArchive carries bridge transfers and policy snapshots beside matches. Vector L
// (no such rows) was recorded from the builder before it learned them and must stay
// byte-identical; vector B adds a finalized and a retracted transfer and a policy with
// both lists.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity    = require('../../../../../src/validators/identity');
const { BRIDGE_KEYS, POLICY_KEYS, ARCHIVE_MAX_POLICY_ROWS, ARCHIVE_MAX_JSON_BYTES } =
    require('../../../../../src/anchor/publisher/constants.js');
const { DB_METHODS }       = require('../../../../helpers/mockHub.js');
const vectors              = require('../../../../fixtures/anchor_archive_vectors.json');

function buildPub(sets) {
    let identity = new ValidatorIdentity('11'.repeat(32));
    let pub = new StateAnchorPublisher({
        db: { ...DB_METHODS }, network: 'regtest',
        getIdentity: () => identity, getPeerManager: () => ({ broadcast() {} }), p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (cap, block) => sets[cap + '@' + block] || [];
    return pub;
}

async function build(pub, i, quorumRows) {
    return pub.buildArchive(i.network, i.batch_seq, i.matches, i.wrapper_snapshot_block, i.calls, i.rewards, quorumRows);
}

describe('archive bridge and policy build', () => {
    it('constants name the key orders and the caps', () => {
        expect(BRIDGE_KEYS).to.have.length(19);
        expect(POLICY_KEYS).to.have.length(19);
        expect(ARCHIVE_MAX_POLICY_ROWS).to.equal(8);
        expect(ARCHIVE_MAX_JSON_BYTES).to.equal(8 * 1024 * 1024);
    });

    it('vector L: no new rows leaves the bytes and crc32 unchanged', async () => {
        let { inputs, json, crc32 } = vectors.L;
        let pub = buildPub(inputs.capability_sets);
        let r = await build(pub, inputs);
        expect(r.json).to.equal(json);
        expect(pub.crc32Hex(r.json)).to.equal(crc32);
        let empty = await build(pub, inputs, { bridges: [], policies: [] });
        expect(empty.json).to.equal(json);
        expect(r.json).to.not.contain('bridge_transfers').and.not.contain('policy_snapshots');
    });

    it('vector B: exact bytes and crc32, keys after rewards and before capability_snapshots', async () => {
        let { inputs, json, crc32 } = vectors.B;
        let pub = buildPub(inputs.capability_sets);
        let r = await build(pub, inputs, { bridges: inputs.bridges, policies: inputs.policies });
        expect(r.json).to.equal(json);
        expect(pub.crc32Hex(r.json)).to.equal(crc32);
        expect(Object.keys(JSON.parse(r.json))).to.deep.equal(
            ['v', 'network', 'batch_seq', 'matches', 'calls', 'rewards',
             'bridge_transfers', 'policy_snapshots', 'capability_snapshots']);
        let o = JSON.parse(r.json);
        expect(o.bridge_transfers.map(t => t.status)).to.deep.equal(['retracted', 'finalized']);
        expect(o.bridge_transfers.map(t => Object.keys(t))).to.deep.equal([BRIDGE_KEYS, BRIDGE_KEYS]);
        expect(Object.keys(o.policy_snapshots[0])).to.deep.equal(POLICY_KEYS);
        expect(r.count).to.equal(1);
    });

    it('a bridge or policy row adds the cross_chain group at its own snapshot_block', async () => {
        let { inputs } = vectors.B;
        let sets = { ...inputs.capability_sets, 'cross_chain@80': [{ pubkey: 'ee'.repeat(32), amount: '4', source: '' }] };
        let early = { ...inputs.bridges[0], snapshot_block: 80 };
        let r = await build(buildPub(sets), { ...inputs, matches: [], calls: [], rewards: [] },
                            { bridges: [early], policies: [] });
        let groups = JSON.parse(r.json).capability_snapshots.map(s => s.capability + '@' + s.snapshot_block);
        expect(groups).to.include('cross_chain@80');
    });

    it('serializes nullable and integer columns by the row rules', () => {
        let pub = buildPub({});
        let t = pub.serializeBridgeTransfer({ ...vectors.B.inputs.bridges[0], id: '5', admit_block_doge: '77', finalizing_view: null });
        expect(t.id).to.equal(5);
        expect(t.admit_block_doge).to.equal(77);
        expect(t.admit_block_btc).to.equal(null);
        expect(t.finalizing_view).to.equal(0);
        let p = pub.serializePolicySnapshot({ ...vectors.B.inputs.policies[0], sleeping: '1', allow_list: null });
        expect(p.sleeping).to.equal(1);
        expect(p.allow_list).to.equal(null);
    });

    it('canonicals delegate to the bridge engine forms', () => {
        let pub = buildPub({});
        let t = pub.bridgeTransferCanonical(vectors.B.inputs.bridges[0]);
        let p = pub.policySnapshotCanonical(vectors.B.inputs.policies[0]);
        expect(t).to.contain('XBRIDGE|' + vectors.B.inputs.bridges[0].transfer_id);
        expect(p).to.contain('XPOLICY|' + vectors.B.inputs.policies[0].snapshot_id);
    });
});
