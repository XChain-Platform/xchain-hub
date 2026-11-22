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

// The v0 bundle ladder age on the leader counts only checkpoints a bundle could carry,
// while followers keep the wider unanchored age, so a leader on either version never
// unlocks a rank a follower on either version declines. The SQL itself runs on MariaDB
// in test/integration/anchor/ladder_age_bundle_eligible.test.js.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ladderMethods = require('../../../../../src/anchor/publisher/ladder/bundle_content_age.js');
const checkpointForms = require('../../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const stateCheckpointMethods = require('../../../../../src/db/state_checkpoints.js');
const { getLogger } = require('../../../../../src/observability');

const COMMITMENT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
const SECTION = { chain: 'BTC', network: 'testnet', snapshot_block: 160, checkpoint_seq: 20, block_index: 920 };
const ELIGIBLE_OLDEST = 150;
const LOOSE_OLDEST = 90;

// The follower statement, pinned byte for byte: hubs on either side of a rollout must
// read the same follower age, and only the leader's own age is narrower.
const FOLLOWER_SQL =
    'SELECT sc.chain, MIN(sc.snapshot_block) AS oldest_block FROM state_checkpoints sc LEFT JOIN (' +
    '  SELECT chain, network, MAX(checkpoint_seq) AS anchored_seq FROM state_checkpoints' +
    '  WHERE anchor_txid IS NOT NULL AND network = ? GROUP BY chain, network' +
    ') a ON sc.chain = a.chain AND sc.network = a.network ' +
    'WHERE sc.network = ? AND sc.anchor_txid IS NULL ' +
    'AND (a.anchored_seq IS NULL OR sc.checkpoint_seq > a.anchored_seq) ' +
    'AND MOD(FLOOR(sc.checkpoint_seq / ?), ?) = 0 GROUP BY sc.chain';

function ageDb(opts) {
    const o = opts || {};
    const calls = { eligible: [], loose: [] };
    const db = {
        calls,
        async findOldestUnanchoredCheckpointBlocksByNetwork(...args) {
            calls.loose.push(args);
            return [{ chain: 'BTC', oldest_block: LOOSE_OLDEST }];
        },
        async findOldestBundleEligibleCheckpointBlocksByNetwork(...args) {
            calls.eligible.push(args);
            if (o.eligibleThrows) throw new Error('eligible read failed');
            return [{ chain: 'BTC', oldest_block: ELIGIBLE_OLDEST }];
        }
    };
    if (o.noEligible) delete db.findOldestBundleEligibleCheckpointBlocksByNetwork;
    return db;
}

function ladder(db, floor) {
    return Object.assign({}, ladderMethods, {
        db, checkpointIntervalBlocks: 1, anchorEveryNCheckpoints: 1,
        commitmentFloorBlock: () => floor
    });
}

async function quietly(fn) {
    const logger = getLogger();
    const warn = logger.warn;
    const warnings = [];
    logger.warn = message => warnings.push(String(message));
    try { return { value: await fn(), warnings }; } finally { logger.warn = warn; }
}

describe('v0 bundle ladder age: leader counts only bundle-eligible checkpoints', function () {
    registerRoutingCases();
    registerFallbackCases();
    registerLeaderPublishCase();
    registerFloorParityCases();
    registerStatementCases();
});

function registerRoutingCases() {
    it('reads the bundle-eligible age with the commitment floor when the leader asks', async function () {
        const db = ageDb();
        const block = await ladder(db, 146000).bundleContentBlock('testnet', [SECTION], true);
        expect(block).to.equal(ELIGIBLE_OLDEST);
        expect(db.calls.eligible).to.deep.equal([[1, 1, 'testnet', 146000]]);
        expect(db.calls.loose).to.deep.equal([]);
    });

    it('keeps the follower check on the wider unanchored age', async function () {
        const db = ageDb();
        const follower = Object.assign(ladder(db, 146000), {
            hub: { resolveBtcLatestBlock: async () => 300 },
            bundleElectionKey: () => 'k',
            rankUnlocked: (...args) => args[2]
        });
        const since = await follower.bundleSenderUnlocked('testnet', SECTION.snapshot_block, ['aa'], 'aa', [SECTION]);
        expect(since, 'measured from the wider age').to.equal(300 - LOOSE_OLDEST);
        expect(db.calls.eligible, 'followers never read the narrower age').to.deep.equal([]);
    });
}

function registerFallbackCases() {
    it('falls back to the wider age, not the sections, when the eligible read fails', async function () {
        const db = ageDb({ eligibleThrows: true });
        const out = await quietly(() => ladder(db, 146000).bundleContentBlock('testnet', [SECTION], true));
        expect(out.value).to.equal(LOOSE_OLDEST);
        expect(out.warnings.some(w => w.includes('bundle-eligible checkpoint age read failed'))).to.equal(true);
    });

    it('falls back to the wider age when no floor resolves or the db lacks the statement', async function () {
        const unpinned = ageDb();
        expect(await ladder(unpinned, null).bundleContentBlock('testnet', [SECTION], true)).to.equal(LOOSE_OLDEST);
        expect(unpinned.calls.eligible).to.deep.equal([]);
        const older = ageDb({ noEligible: true });
        expect(await ladder(older, 146000).bundleContentBlock('testnet', [SECTION], true)).to.equal(LOOSE_OLDEST);
    });
}

function registerLeaderPublishCase() {
    it('measures the leader publish ladder from the bundle-eligible age', async function () {
        const db = ageDb();
        const pub = new StateAnchorPublisher({ db, p2pConfig: {} });
        Object.assign(pub, { checkpointIntervalBlocks: 1, anchorEveryNCheckpoints: 1,
                             commitmentFloorBlock: () => 146000 });
        const ladderBlocks = [];
        pub.getActiveOraclePublishPubkeys = async () => ['aa'];
        pub.splitBundle = sections => ({ bundles: [sections], oversize: [] });
        pub.publishBundle = async (...args) => { ladderBlocks.push(args[3]); };
        await pub.publishNetworkBundles(null, 'testnet', [SECTION], 200, false, [], { rows: 0 });
        expect(ladderBlocks, 'btc 200 shifted by the eligible age only').to.deep.equal([200 + 160 - ELIGIBLE_OLDEST]);
        expect(db.calls.loose).to.deep.equal([]);
    });
}

function registerFloorParityCases() {
    it('puts the floor exactly where the commitment gate turns on, per network', function () {
        const networks = Object.keys(gateRegistry.get(COMMITMENT_KEY));
        expect(networks).to.include.members(['mainnet', 'testnet', 'regtest']);
        for (const network of networks) {
            const floor = checkpointForms.checkpointCommitmentFloor(network);
            expect(Number.isSafeInteger(floor), network).to.equal(true);
            expect(checkpointForms.isCheckpointCommitmentActive({ network, snapshot_block: floor }), network + ' at').to.equal(true);
            if (floor > 0)
                expect(checkpointForms.isCheckpointCommitmentActive({ network, snapshot_block: floor - 1 }), network + ' below').to.equal(false);
            expect(new StateAnchorPublisher({ db: {}, p2pConfig: {} }).commitmentFloorBlock(network)).to.equal(floor);
        }
    });

    it('resolves no floor for a network the gate does not name', function () {
        for (const network of ['nosuchnet', 'constructor', undefined]) {
            expect(checkpointForms.checkpointCommitmentFloor(network)).to.equal(null);
            expect(checkpointForms.isCheckpointCommitmentActive({ network, snapshot_block: 99999999 })).to.equal(false);
        }
    });
}

async function capture(method, args) {
    let out;
    await method.call({ doQuery: async (sql, params) => { out = { sql, params }; return []; } }, ...args);
    return out;
}

function registerStatementCases() {
    it('keeps the follower statement byte-identical to the one every hub already runs', async function () {
        const q = await capture(stateCheckpointMethods.findOldestUnanchoredCheckpointBlocksByNetwork, [3, 2, 'testnet']);
        expect(q.sql).to.equal(FOLLOWER_SQL);
        expect(q.params).to.deep.equal(['testnet', 'testnet', 3, 2]);
    });

    it('anti-joins markers in one grouped read instead of a correlated subquery per row', async function () {
        const q = await capture(stateCheckpointMethods.findOldestBundleEligibleCheckpointBlocksByNetwork, [3, 2, 'testnet', 146000]);
        expect(q.sql.startsWith(FOLLOWER_SQL.split(' WHERE sc.network')[0].split(') a ON')[0])).to.equal(true);
        expect(q.sql).to.not.include('NOT EXISTS');
        expect(q.sql).to.include('GROUP BY chain, checkpoint_seq) m ON').and.include('AND m.chain IS NULL');
        expect(q.params).to.deep.equal(['testnet', 'testnet', 'testnet', 3, 2, 146000]);
    });
}
