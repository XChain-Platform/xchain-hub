'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// PRICE CAPABILITY MIRROR. No hub ever wrote a `price` row into
// capability_snapshots, so the hub-mirrored table every non-BTC indexer reads to
// resolve validator capabilities held only cross_chain and oracle_publish rows.
// A four-validator federation published fifteen PRICE actions to DOGE regtest and
// all fifteen recorded 'invalid: insufficient signer stake' with four verifying
// signatures each. These tests drive the oracle finalization path and assert the
// rows are actually WRITTEN, at the round's BTC anchor.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');

const ROUND      = 5;              // deliberately NOT the anchor: a local round number
const BTC_ANCHOR = 900000;         // the BTC-anchored snapshot block the round resolves at

describe('OracleConsensus: price capability snapshot mirroring', function () {
    let hub, oc, oracleRound, db, broadcasts;

    // Minimal capability_snapshots table: honours the INSERT IGNORE dedupe on the
    // natural key (snapshot_block, capability, signing_pubkey, source) and answers
    // the select-back, so a test can read the rows the code really wrote.
    function makeDb() {
        let rows  = [];
        let calls = [];
        return {
            rows: rows,
            calls: calls,
            doQuery: async function (sql, params) {
                calls.push({ sql: sql, params: params });
                if (/INSERT IGNORE INTO capability_snapshots/i.test(sql)) {
                    // One multi-row statement carries the whole set, so walk the flattened
                    // params in groups of five rather than destructuring a single row.
                    let inserted = 0;
                    for (let i = 0; i + 4 < params.length; i += 5) {
                        let [snapshot_block, capability, signing_pubkey, amount, source] = params.slice(i, i + 5);
                        let dup = rows.some(r => r.snapshot_block === snapshot_block && r.capability === capability
                            && r.signing_pubkey === signing_pubkey && r.source === source);
                        if (!dup) { rows.push({ id: rows.length + 1, snapshot_block, capability, signing_pubkey, amount, source }); inserted++; }
                    }
                    return { affectedRows: inserted };
                }
                if (/FROM capability_snapshots/i.test(sql)) {
                    let [block, capability, pubkey, source] = params;
                    return rows.filter(r => r.snapshot_block === block && r.capability === capability
                        && r.signing_pubkey === pubkey && r.source === source).slice(0, 1);
                }
                return [];
            }
        };
    }

    function makePending(overrides) {
        return Object.assign({
            prepares:       new Set(['pkA', 'pkB', 'pkC']),
            commits:        new Set(['pkA', 'pkB', 'pkC']),
            signatures:     new Map([['pkA', 'sigA'], ['pkB', 'sigB']]),
            prices:         [{ coinPair: 'BTC/USD', price: '100000' }],
            btcBlockHeight: BTC_ANCHOR,
            btcBlockTime:   1700000000,
            finalized:      true                      // set by _checkCommitQuorum before the store
        }, overrides || {});
    }

    // Source-keyed weight snapshot, the shape regtest/testnet resolve (STAKE_WEIGHTED_QUORUM
    // activates at block 0 on both). 'AA...' upper-cased on purpose: rows are stored lowercase.
    function weightSnapshot(extra) {
        return Object.assign({
            blockIndex: BTC_ANCHOR,
            truncated:  false,
            validators: [
                { pubkey: 'AA'.repeat(32), source: 'bc1qsrca', weight: '5000000000' },
                { pubkey: 'bb'.repeat(32), source: 'bc1qsrcb', weight: '4000000000' }
            ]
        }, extra || {});
    }

    function priceRows(dbUsed) {
        return dbUsed.rows.filter(r => r.capability === 'price');
    }

    beforeEach(function () {
        hub         = createMockHub();
        db          = makeDb();
        hub.db      = db;
        hub.network = 'regtest';
        broadcasts  = [];
        hub.hubDbBroadcaster = {
            broadcastRow:     row => broadcasts.push(row),
            dropAllForResync: sinon.stub()
        };
        hub.capabilitySnapshot = {
            getWeightSnapshot: sinon.stub().resolves(weightSnapshot()),
            getSnapshot:       sinon.stub().resolves({ blockIndex: BTC_ANCHOR, truncated: false, validators: [] }),
            getQuorum:         sinon.stub().returns(2)
        };
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc          = new OracleConsensus(hub, oracleRound);
        oc.db       = db;
    });

    afterEach(function () {
        for (let [, p] of oc.pendingRounds) if (p && p.timer) clearTimeout(p.timer);
        oc.pendingRounds.clear();
        sinon.restore();
    });

    it('writes a price row per validator at the BTC anchor when a quorum-signed round finalizes', async function () {
        oc.pendingRounds.set(ROUND, makePending());

        await oc._finalizeCommittedRound(ROUND);

        let written = priceRows(db);
        expect(written).to.have.length(2);
        expect(written.map(r => r.signing_pubkey).sort()).to.deep.equal(['aa'.repeat(32), 'bb'.repeat(32)]);
        for (let r of written) {
            expect(r.capability).to.equal('price');
            expect(r.snapshot_block).to.equal(BTC_ANCHOR);
        }
        expect(written.find(r => r.signing_pubkey === 'aa'.repeat(32)))
            .to.include({ amount: '5000000000', source: 'bc1qsrca' });
        expect(written.find(r => r.signing_pubkey === 'bb'.repeat(32)))
            .to.include({ amount: '4000000000', source: 'bc1qsrcb' });
        // The round itself still finalized: the mirror write is a precondition, not a detour.
        expect(oc.finalized.has(ROUND)).to.be.true;
    });

    it('anchors the rows at the BTC block, never at the round number or a local height', async function () {
        oc.pendingRounds.set(ROUND, makePending());

        await oc._finalizeCommittedRound(ROUND);

        expect(priceRows(db)).to.have.length(2);
        expect(priceRows(db).every(r => r.snapshot_block === BTC_ANCHOR)).to.be.true;
        expect(priceRows(db).some(r => r.snapshot_block === ROUND)).to.be.false;
        // And the set was resolved at that same BTC block, not at anything else.
        expect(hub.capabilitySnapshot.getWeightSnapshot.calledWith('price', BTC_ANCHOR)).to.be.true;
    });

    it('persists BEFORE the price_snapshots round insert, so no unverifiable round streams first', async function () {
        oc.pendingRounds.set(ROUND, makePending());

        await oc._finalizeCommittedRound(ROUND);

        let capIdx   = db.calls.findIndex(c => /INSERT IGNORE INTO capability_snapshots/i.test(c.sql));
        let priceIdx = db.calls.findIndex(c => /INSERT INTO price_snapshots/i.test(c.sql));
        expect(capIdx).to.be.greaterThan(-1);
        expect(priceIdx).to.be.greaterThan(-1);
        expect(capIdx).to.be.lessThan(priceIdx);
    });

    it('mirrors each persisted row to hub-DB subscribers', async function () {
        oc.pendingRounds.set(ROUND, makePending());

        await oc._finalizeCommittedRound(ROUND);

        let capRows = broadcasts.filter(b => b.table === 'capability_snapshots');
        expect(capRows).to.have.length(2);
        expect(capRows.every(b => b.row.capability === 'price' && b.row.snapshot_block === BTC_ANCHOR)).to.be.true;
    });

    it('is idempotent: re-finalizing the same round writes no duplicate rows', async function () {
        oc.pendingRounds.set(ROUND, makePending());
        await oc._finalizeCommittedRound(ROUND);
        expect(priceRows(db)).to.have.length(2);

        // A replayed COMMIT re-driving the store for the same round (the retry path).
        oc.finalized.delete(ROUND);
        oc.pendingRounds.set(ROUND, makePending());
        await oc._finalizeCommittedRound(ROUND);

        expect(priceRows(db)).to.have.length(2);
    });

    it('refuses to mirror a TRUNCATED snapshot (no partial set read back as complete)', async function () {
        hub.capabilitySnapshot.getWeightSnapshot.resolves(weightSnapshot({ truncated: true }));
        oc.pendingRounds.set(ROUND, makePending());

        await oc._finalizeCommittedRound(ROUND);

        expect(priceRows(db)).to.have.length(0);
    });

    it('below STAKE_WEIGHTED_QUORUM activation, mirrors the legacy count set (source empty)', async function () {
        // mainnet activates at 961000, so a lower anchor takes the count path.
        hub.network = 'mainnet';
        let legacyAnchor = 900000;
        hub.capabilitySnapshot.getSnapshot.resolves({
            blockIndex: legacyAnchor,
            truncated:  false,
            validators: [{ pubkey: 'cc'.repeat(32), amount: '7000000000' }]
        });
        oc.pendingRounds.set(ROUND, makePending({ btcBlockHeight: legacyAnchor }));

        await oc._finalizeCommittedRound(ROUND);

        expect(priceRows(db)).to.have.length(1);
        expect(priceRows(db)[0]).to.include({
            capability:     'price',
            snapshot_block: legacyAnchor,
            signing_pubkey: 'cc'.repeat(32),
            amount:         '7000000000',
            source:         ''
        });
        expect(hub.capabilitySnapshot.getWeightSnapshot.called).to.be.false;
    });

    it('fails closed: a persist failure skips the price_snapshots write and retains the round', async function () {
        this.timeout(5000);
        let real = db.doQuery;
        db.doQuery = async function (sql, params) {
            if (/INSERT IGNORE INTO capability_snapshots/i.test(sql)) throw new Error('db down');
            return real.call(db, sql, params);
        };
        oc.pendingRounds.set(ROUND, makePending());
        let events = [];
        oc.on('round:finalized', e => events.push(e));

        await oc._finalizeCommittedRound(ROUND);

        expect(db.calls.some(c => /INSERT INTO price_snapshots/i.test(c.sql))).to.be.false;
        expect(oc.finalized.has(ROUND)).to.be.false;
        expect(oc.pendingRounds.has(ROUND)).to.be.true;     // re-drivable, not dropped
        expect(events).to.have.length(0);
    });

    it('single-node self-finalize path also mirrors the price set at the BTC anchor', async function () {
        // finalizeRound's quorum===0 branch stores the round directly, with no PBFT.
        hub.capabilitySnapshot.getQuorum.returns(0);
        oc.minSubmissions = 1;
        let submissions = new Map([['ws://validator-1:10001', {
            prices: [{ coinPair: 'BTC/USD', price: '100000' }]
        }]]);
        oracleRound.getSubmissions.returns(submissions);
        oracleRound.priceFetcher = null;
        // The single-node branch aggregates locally; stub the aggregate so the test
        // exercises the store path rather than the trimmed-median math.
        sinon.stub(oc, '_aggregateAll').returns([{ coinPair: 'BTC/USD', price: '100000' }]);
        sinon.stub(oc, '_memberPubkeySet').returns(null);

        await oc.finalizeRound(ROUND, BTC_ANCHOR, 1700000000);

        let written = priceRows(db);
        expect(written).to.have.length(2);
        expect(written.every(r => r.capability === 'price' && r.snapshot_block === BTC_ANCHOR)).to.be.true;
    });
});
