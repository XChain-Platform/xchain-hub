'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The mesh fixture can model distinct pinned capability membership sets.

const { expect } = require('chai');
const {
    CP_ROW, buildMesh, registerMeshHooks
} = require('../../../../../helpers/anchor_mesh.js');

function sortedPubkeys(bus, indexes) {
    indexes = indexes || bus.nodes.map((node, i) => i);
    return indexes.map(i => bus.nodes[i].pubkey).sort();
}

function countValidators(bus, indexes) {
    return indexes.map(i => ({ pubkey: bus.nodes[i].pubkey, amount: '1' }));
}

function weightValidators(bus, indexes) {
    return indexes.map(i => ({ pubkey: bus.nodes[i].pubkey, weight: '1', source: 'wsrc' + i }));
}

function registerCountSnapshotTests() {
    it('keeps the default mesh snapshot shared and untracked', async () => {
        const bus = buildMesh(4);
        const snapshot = bus.nodes[0].pub.hub.capabilitySnapshot;
        const expected = countValidators(bus, [0, 1, 2, 3]);

        expect(await snapshot.getSnapshot('archive_publish', CP_ROW.snapshot_block))
            .to.deep.equal({ validators: expected });
        expect(await snapshot.getSnapshot('oracle_publish', CP_ROW.snapshot_block))
            .to.deep.equal({ validators: expected });
        expect(snapshot).not.to.have.property('getWeightSnapshot');
        expect(bus.snapshotReads).to.equal(undefined);
    });

    it('answers and records capability-specific count reads on regtest', async () => {
        const bus = buildMesh(4, { capabilitySets: { archive_publish: [0, 1, 2] } });
        const pub = bus.nodes[0].pub;
        const warnings = [];
        pub.warnMembershipUnresolved = (...args) => warnings.push(args);

        expect(await pub.capabilityPubkeysAt('archive_publish', CP_ROW.snapshot_block))
            .to.deep.equal(sortedPubkeys(bus, [0, 1, 2]));
        expect(await pub.capabilityPubkeysAt('oracle_publish', CP_ROW.snapshot_block))
            .to.deep.equal(sortedPubkeys(bus));
        expect(await pub.getActiveOraclePublishPubkeys(CP_ROW.snapshot_block))
            .to.deep.equal(sortedPubkeys(bus));
        expect(warnings).to.deep.equal([]);
        expect(bus.snapshotReads).to.deep.equal([
            ['archive_publish', CP_ROW.snapshot_block],
            ['oracle_publish', CP_ROW.snapshot_block],
            ['oracle_publish', CP_ROW.snapshot_block]
        ]);
    });
}

function registerWeightedAndFollowerTests() {
    it('keeps capability-specific weight answers when stakeWeighted is set', async () => {
        const bus = buildMesh(4, {
            capabilitySets: { archive_publish: [0, 1, 2] },
            stakeWeighted: true
        });
        const snapshot = bus.nodes[0].pub.hub.capabilitySnapshot;

        expect(await snapshot.getWeightSnapshot('archive_publish', CP_ROW.snapshot_block))
            .to.deep.equal({ validators: weightValidators(bus, [0, 1, 2]) });
        expect(await bus.nodes[0].pub.capabilityPubkeysAt('archive_publish', CP_ROW.snapshot_block))
            .to.deep.equal(sortedPubkeys(bus, [0, 1, 2]));
        expect(bus.snapshotReads).to.deep.equal([
            ['archive_publish', CP_ROW.snapshot_block],
            ['archive_publish', CP_ROW.snapshot_block]
        ]);
    });

    it('uses the capability-specific count answer below the mainnet weighted height', async () => {
        const bus = buildMesh(4, {
            network: 'mainnet',
            capabilitySets: { archive_publish: [0, 1, 2] }
        });
        const snapshot = bus.nodes[0].pub.hub.capabilitySnapshot;

        expect(await snapshot.getSnapshot('archive_publish', 100))
            .to.deep.equal({ validators: countValidators(bus, [0, 1, 2]) });
        expect(await bus.nodes[0].pub.capabilityPubkeysAt('archive_publish', 100))
            .to.deep.equal(sortedPubkeys(bus, [0, 1, 2]));
        expect(bus.snapshotReads).to.deep.equal([
            ['archive_publish', 100],
            ['archive_publish', 100]
        ]);
    });

    it('leaves archive followers on the oracle_publish set today', async () => {
        const bus = buildMesh(4, { capabilitySets: { archive_publish: [0, 1, 2] } });
        const pub = bus.nodes[0].pub;

        expect(await pub.archiveFollowerPubkeys(CP_ROW.snapshot_block, 'regtest'))
            .to.deep.equal(await pub.getActiveOraclePublishPubkeys(CP_ROW.snapshot_block));
        expect(await pub.archiveFollowerPubkeys(CP_ROW.snapshot_block, 'regtest'))
            .to.deep.equal(sortedPubkeys(bus));
    });
}

describe('anchor mesh capability sets', () => {
    registerMeshHooks();
    registerCountSnapshotTests();
    registerWeightedAndFollowerTests();
});
