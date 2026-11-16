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

// The leader's bundle-eligible ladder age, run as real SQL on MariaDB: it agrees with the
// JS rules that decide what a v0 bundle carries (groupSectionsByNetwork and the
// superseded reader rule), every case shows the wider follower age counting the row it
// drops, the anchor mesh's in-memory fake returns the same ages, and the marker exclusion
// reads the marker rows once rather than through a correlated subquery per row.

const { expect } = require('chai');
const testDb = require('../../helpers/testDb');
const StateAnchorPublisher = require('../../../src/anchor/publisher');
const { supersededBySeq } = require('../../../src/anchor/checkpoint_engine/superseded_rule.js');
const { getLogger } = require('../../../src/observability');
const { memDb } = require('../../helpers/anchor_mesh_db.js');

const ROOTS = ['state_root', 'state_root_version', 'block_merkle_root', 'block_merkle_version'];
let db;
let pub;

function cp(chain, network, seq, snapshotBlock, over) {
    return Object.assign({ chain, network, checkpoint_seq: seq, snapshot_block: snapshotBlock, block_index: 1000 + seq * 10,
                           supersedes_from: null, rules_digest: null, anchor_txid: null, state_root: 'aa',
                           state_root_version: 1, block_merkle_root: 'bb', block_merkle_version: 1 }, over || {});
}

async function insert(rows) {
    for (const r of rows) {
        await db.doQuery(
            'INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, ' +
            'checkpoint_seq, snapshot_block, supersedes_from, rules_digest, state_root, state_root_version, block_merkle_root, ' +
            "block_merkle_version, validator_signatures, anchor_txid) VALUES (?, ?, ?, 'h', 'l', 'a', 'c', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)",
            [r.chain, r.network, r.block_index, r.checkpoint_seq, r.snapshot_block, r.supersedes_from, r.rules_digest,
             r.state_root, r.state_root_version, r.block_merkle_root, r.block_merkle_version, r.anchor_txid]);
    }
}

function asMap(rows) {
    const out = {};
    for (const r of rows) out[r.chain] = Number(r.oldest_block);
    return out;
}

async function ages(network, step, everyN) {
    const eligible = await db.findOldestBundleEligibleCheckpointBlocksByNetwork(step, everyN, network, pub.commitmentFloorBlock(network));
    const loose = await db.findOldestUnanchoredCheckpointBlocksByNetwork(step, everyN, network);
    return { eligible: asMap(eligible), loose: asMap(loose) };
}

// The bundle rules in JS, the reference the SQL must match.
function reference(rows, network, step, everyN) {
    const out = {};
    for (const chain of new Set(rows.map(r => r.chain))) {
        const mine = rows.filter(r => r.network === network && r.chain === chain);
        const anchored = mine.filter(r => r.anchor_txid != null).reduce((m, r) => Math.max(m, r.checkpoint_seq), -1);
        for (const r of mine) {
            if (r.anchor_txid != null || r.checkpoint_seq <= anchored) continue;
            if (Math.floor(r.checkpoint_seq / step) % everyN !== 0) continue;
            if (pub.groupSectionsByNetwork([r]).size !== 1 || supersededBySeq(r, rows) != null) continue;
            if (out[chain] == null || r.snapshot_block < out[chain]) out[chain] = r.snapshot_block;
        }
    }
    return out;
}

function registerDbLifecycle() {
    let warn;
    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            if (Object.prototype.hasOwnProperty.call(process.env, 'TEST_DB_PASS')) throw e;
            console.warn('MariaDB unavailable; skipping the bundle-eligible ladder age test');
            this.skip();
        }
        pub = new StateAnchorPublisher({ db: {}, p2pConfig: {} });
        warn = getLogger().warn;
        getLogger().warn = () => {};
    });
    beforeEach(async function () { await db.doQuery('DELETE FROM state_checkpoints'); });
    after(async function () {
        if (warn) getLogger().warn = warn;
        await testDb.teardown();
    });
}

describe('Integration: bundle-eligible ladder age on MariaDB', function () {
    this.timeout(60000);
    registerDbLifecycle();
    registerKindCases();
    registerDifferentialCase();
    registerPlanCase();
});

function registerKindCases() {
    const KINDS = [
        ['a row below the commitment floor', 'testnet', cp('BTC', 'testnet', 10, 145990)],
        ['a rootless row', 'regtest', cp('BTC', 'regtest', 10, 110, { block_merkle_root: null })],
        ['a rules_digest-only marker', 'regtest', cp('BTC', 'regtest', 10, 110, { rules_digest: 'd'.repeat(64) })],
        ['a supersedes_from marker', 'regtest', cp('BTC', 'regtest', 10, 110, { supersedes_from: 5000 })],
        ['a plain row a later marker supersedes', 'regtest', cp('BTC', 'regtest', 10, 110, { block_index: 1500 })]
    ];
    for (const [label, network, bad] of KINDS) {
        it('skips ' + label + ' that the follower age still counts', async function () {
            const base = network === 'testnet' ? 146000 : 120;
            const rows = [bad, cp('BTC', network, 11, base), cp('BTC', network, 12, base + 3)];
            if (label.startsWith('a plain row')) rows.push(cp('BTC', network, 13, base + 6, { supersedes_from: 1400, block_index: 1130 }));
            await insert(rows);
            const got = await ages(network, 1, 1);
            expect(got.loose, 'the follower age counts it').to.deep.equal({ BTC: bad.snapshot_block });
            expect(got.eligible, 'the leader age starts at the first carriable row').to.deep.equal({ BTC: base });
            expect(got.eligible).to.deep.equal(reference(rows, network, 1, 1));
        });
    }

    it('counts a never-anchored chain from its first eligible row and an anchored one from above the anchor', async function () {
        const rows = [cp('BTC', 'regtest', 1, 100), cp('BTC', 'regtest', 2, 103),
                      cp('LTC', 'regtest', 1, 100), cp('LTC', 'regtest', 2, 103, { anchor_txid: 'ee'.repeat(32) }),
                      cp('LTC', 'regtest', 3, 106)];
        await insert(rows);
        const got = await ages('regtest', 1, 1);
        expect(got.eligible).to.deep.equal({ BTC: 100, LTC: 106 });
        expect(got.loose).to.deep.equal({ BTC: 100, LTC: 106 });
    });
}

// Deterministic generator so a failure replays.
function lcg(seed) {
    let s = seed >>> 0;
    return n => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

function genRows(rnd) {
    const rows = [];
    for (const [network, floor] of [['testnet', 146000], ['regtest', 0]]) {
        for (const chain of ['BTC', 'LTC', 'DOGE']) {
            let seq = rnd(4), bi = 1000;
            const base = Math.max(0, floor - 40 + rnd(60));
            for (let i = 0, n = 3 + rnd(20); i < n; i++) {
                seq += 1 + rnd(2);
                bi = rnd(5) === 0 ? Math.max(1, bi - rnd(30)) : bi + 10;
                const r = cp(chain, network, seq, base + seq * 3, { block_index: bi, anchor_txid: rnd(9) === 0 ? 'tx' + seq : null });
                const k = rnd(12);
                if (k === 0) r.supersedes_from = Math.max(1, bi - rnd(80));
                if (k === 1) r.rules_digest = 'd'.repeat(64);
                if (k === 2) r[ROOTS[rnd(4)]] = null;
                rows.push(r);
            }
        }
    }
    return rows;
}

function registerDifferentialCase() {
    it('matches the JS bundle rules over generated tables and never runs younger than the follower age', async function () {
        const rnd = lcg(17550);
        let compared = 0, followerDiffers = 0;
        for (let round = 0; round < 40; round++) {
            await db.doQuery('DELETE FROM state_checkpoints');
            const rows = genRows(rnd);
            await insert(rows);
            const step = 1 + rnd(3), everyN = 1 + rnd(2);
            const fake = memDb();
            fake.checkpoints.push(...rows);
            for (const network of ['testnet', 'regtest']) {
                const got = await ages(network, step, everyN);
                expect(got.eligible, 'round ' + round + ' ' + network).to.deep.equal(reference(rows, network, step, everyN));
                const floor = pub.commitmentFloorBlock(network);
                expect(asMap(await fake.findOldestBundleEligibleCheckpointBlocksByNetwork(step, everyN, network, floor)),
                       'mesh fake, eligible').to.deep.equal(got.eligible);
                expect(asMap(await fake.findOldestUnanchoredCheckpointBlocksByNetwork(step, everyN, network)),
                       'mesh fake, follower').to.deep.equal(got.loose);
                for (const chain of Object.keys(got.eligible)) expect(got.loose[chain]).to.be.at.most(got.eligible[chain]);
                if (JSON.stringify(got.loose) !== JSON.stringify(got.eligible)) followerDiffers++;
                compared++;
            }
        }
        expect(compared).to.equal(80);
        expect(followerDiffers, 'the generator reaches rows the two ages disagree on').to.be.above(10);
    });
}

function registerPlanCase() {
    it('plans the marker exclusion without a dependent subquery, unlike a correlated NOT EXISTS', async function () {
        await db.doQuery("INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, " +
            "contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, " +
            "validator_signatures) SELECT 'BTC', 'regtest', 1000 + seq, 'h', 'l', 'a', 'c', seq, 100 + seq, 'aa', 1, 'bb', 1, '[]' " +
            'FROM seq_1_to_16000');
        let q;
        await db.findOldestBundleEligibleCheckpointBlocksByNetwork.call({ doQuery: async (sql, params) => { q = { sql, params }; return []; } },
                                                                        1, 1, 'regtest', 0);
        const types = sql => db.doQuery('EXPLAIN ' + sql, q.params).then(rows => rows.map(r => r.select_type));
        expect(await types(q.sql)).to.not.include('DEPENDENT SUBQUERY');
        const correlated = q.sql.replace(' AND m.chain IS NULL', ' AND NOT EXISTS (SELECT 1 FROM state_checkpoints x ' +
            'WHERE x.chain = sc.chain AND x.network = sc.network AND x.checkpoint_seq > sc.checkpoint_seq)');
        expect(await types(correlated), 'the control shape is caught').to.include('DEPENDENT SUBQUERY');
        const started = Date.now();
        expect(asMap(await db.doQuery(q.sql, q.params))).to.deep.equal({ BTC: 101 });
        expect(Date.now() - started, '16000 rows read in one linear pass').to.be.below(5000);
    });
}
