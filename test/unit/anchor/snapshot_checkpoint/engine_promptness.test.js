'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const { writeCapabilitySnapshotRows } = require('../../../../src/lib/capability_snapshot_write.js');
const { key, block, harness } = require('./support/engine_harness.js');

// The hub writes a new capability set every cadence interval and each off-BTC mirror holds
// a fresh row until its checkpoint exists. Checkpointing one snapshot per poll, on a poll
// that ran just before each set was written, left the newest set unproven when the next
// one arrived, so a mirror's hold set never emptied and its block loop deferred for good.
const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

const validator = { pubkey: key('1'), weight: '1', source: 'seed:' + key('1') };

// A harness whose db also takes capability set writes: a written snapshot block is listed
// as uncheckpointed until a checkpoint is stored for it.
function writable(h) {
    const written = [];
    const scan = h.db.listUncheckpointedSnapshotBlocks;
    h.db.createCapabilitySnapshots = sinon.spy(async rows => {
        for (const row of rows) if (!written.includes(row.snapshot_block)) written.push(row.snapshot_block);
    });
    h.db.listUncheckpointedSnapshotBlocks = sinon.spy(async (...args) => (await scan(...args)).concat(written
        .filter(snapshotBlock => !h.rows.has(['BTC', h.source.network, snapshotBlock - 6].join('|')))
        .map(snapshotBlock => ({ snapshot_block: snapshotBlock }))));
    return h;
}

function registerDrainTests() {
    it('checkpoints every due sole-validator snapshot in one tick, oldest first', async function () {
        const h = harness({ due: [118, 106, 112] });

        await h.engine.tick();

        expect([...h.rows.values()].map(row => row.block_index)).to.deep.equal([100, 106, 112]);
    });

    it('stops draining at a snapshot another hub leads', async function () {
        const validators = [{ pubkey: key('1') }, { pubkey: key('2') }];
        // The tip sits exactly at the due height, inside the turn hub's fallback wait.
        const h = harness({ validators, due: [107, 108], block: block(101), tip: 107 });
        sinon.stub(h.engine, 'leadRound').resolves();

        await h.engine.tick();

        expect(h.db.listUncheckpointedSnapshotBlocks.callCount).to.equal(1);
        expect(h.engine.leadRound.called).to.equal(false);
        expect(h.rows.size).to.equal(0);
    });
}

function registerWriteTriggerTests() {
    it('checkpoints a capability set as soon as it is written, without waiting for the poll', async function () {
        const h = writable(harness({ due: [] }));
        await h.engine.start();
        try {
            await writeCapabilitySnapshotRows(h.db, 'oracle_publish', 106, [validator], null);
            await settle();
            expect([...h.rows.values()].map(row => row.block_index)).to.deep.equal([100]);
        } finally {
            await h.engine.stop();
        }
    });

    it('runs again after a tick that scanned before a set was written', async function () {
        const h = writable(harness({ due: [] }));
        const scan = h.db.listUncheckpointedSnapshotBlocks;
        let first = true;
        h.db.listUncheckpointedSnapshotBlocks = sinon.spy(async (...args) => {
            const result = await scan(...args);
            if (first) {
                first = false;
                await writeCapabilitySnapshotRows(h.db, 'oracle_publish', 106, [validator], null);
            }
            return result;
        });
        await h.engine.start();
        try {
            await h.engine.tick();
            await settle();
            expect([...h.rows.values()].map(row => row.block_index)).to.deep.equal([100]);
        } finally {
            await h.engine.stop();
        }
    });

}

function registerWriteScopeTests() {
    it('ignores a set written to another database, and every write once stopped', async function () {
        const h = writable(harness({ due: [] }));
        const other = { createCapabilitySnapshots: sinon.spy(async () => {}) };
        await h.engine.start();
        await writeCapabilitySnapshotRows(other, 'oracle_publish', 106, [validator], null);
        await settle();
        expect(h.db.listUncheckpointedSnapshotBlocks.called).to.equal(false);

        await h.engine.stop();
        await writeCapabilitySnapshotRows(h.db, 'oracle_publish', 106, [validator], null);
        await settle();
        expect(h.db.listUncheckpointedSnapshotBlocks.called).to.equal(false);
        expect(h.rows.size).to.equal(0);
    });

    it('does not scan on a write while the gate is unarmed', async function () {
        const h = writable(harness({ network: 'mainnet', due: [] }));
        await h.engine.start();
        try {
            await writeCapabilitySnapshotRows(h.db, 'oracle_publish', 106, [validator], null);
            await settle();
            expect(h.db.listUncheckpointedSnapshotBlocks.called).to.equal(false);
        } finally {
            await h.engine.stop();
        }
    });
}

describe('SnapshotCheckpointEngine promptness', function () {
    afterEach(function () { sinon.restore(); });
    registerDrainTests();
    registerWriteTriggerTests();
    registerWriteScopeTests();
});
