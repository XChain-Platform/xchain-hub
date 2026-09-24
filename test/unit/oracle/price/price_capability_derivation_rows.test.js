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

const crypto          = require('crypto');
const sinon           = require('sinon');
const { expect }      = require('chai');
const PriceAggregator = require('../../../../src/oracle/price_aggregator');
const OracleConsensus = require('../../../../src/oracle/consensus');
const swq             = require('../../../../src/consensus/stake_weighted_quorum.js');
const { createMockHub } = require('../../../helpers/mockHub');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const TIP    = 151800;
const ANCHOR = 151797;
const CAPS   = ['price', 'oracle_publish', 'cross_chain', 'attestation'];
const WINDOW = 4;
const GRID   = WINDOW * CAPS.length;

let hub, agg, db, capSnapshot, broadcaster, envSaved;

function makePubkey() {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

function makeWeightSet(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ pubkey: makePubkey(), source: 'tb1qderivedstake' + i,
                   weight: '250000.00000000' });
    }
    return out;
}

function makeFakeDb() {
    const store   = new Map();
    const queries = [];
    return { ...DB_METHODS, store, queries,
        getChainTip: async () => ({ chainId: 'ff'.repeat(32), blockHeight: 1 }),
        doQuery: async (sql, args) => {
            queries.push({ sql: sql, args: (args || []).slice() });
            if (/^INSERT IGNORE INTO capability_snapshots/.test(sql)) {
                for (let i = 0; i < args.length; i += 6) {
                    const row = {
                        snapshot_block: args[i], capability: args[i + 1],
                        signing_pubkey: args[i + 2], amount: args[i + 3],
                        source: args[i + 4], btc_chain_id: args[i + 5]
                    };
                    const key = [row.snapshot_block, row.capability, row.signing_pubkey, row.source].join('|');
                    if (!store.has(key)) store.set(key, row);
                }
                return { affectedRows: 0 };
            }
            if (/^SELECT \* FROM capability_snapshots/.test(sql)) {
                const key = [args[0], args[1], args[2], args[3]].join('|');
                return store.has(key) ? [store.get(key)] : [];
            }
            return [];
        }
    };
}

function indexerReadsWeights(targetDb, capability, snapshotBlock) {
    const rows = [...targetDb.store.values()]
        .filter(row => row.capability === capability && Number(row.snapshot_block) === Number(snapshotBlock))
        .sort((a, b) => (a.signing_pubkey < b.signing_pubkey ? -1
                       : a.signing_pubkey > b.signing_pubkey ? 1
                       : a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    return rows.map(row => ({ pubkey: String(row.pubkey || row.signing_pubkey),
                              source: row.source == null ? '' : String(row.source),
                              weight: String(row.amount) }));
}

function indexerVerdict(targetDb, anchor, signers, capability) {
    const validators = indexerReadsWeights(targetDb, capability || 'price', anchor);
    return swq.meetsStakeThreshold(validators, signers)
        ? 'valid'
        : 'invalid: insufficient signer stake';
}

function saveEnv() {
    return { derive: process.env.HUB_PRICE_CAPABILITY_DERIVE,
        lookback: process.env.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS,
        interval: process.env.HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S };
}

function restoreEnv(saved) {
    for (const [key, value] of [['HUB_PRICE_CAPABILITY_DERIVE', saved.derive],
                              ['HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS', saved.lookback],
                              ['HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S', saved.interval]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
}

const SET = makeWeightSet(4);
const THREE_SIGNERS = SET.slice(0, 3).map(v => v.pubkey);

function registerFixtureHooks() {
    beforeEach(function () {
        envSaved = saveEnv();
        delete process.env.HUB_PRICE_CAPABILITY_DERIVE;
        process.env.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS = '4';
        db = makeFakeDb();
        broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() };
        capSnapshot = {
            getWeightSnapshot: sinon.stub().callsFake(async (capability, block) => ({
                capability, blockIndex: block, count: SET.length, truncated: false,
                validators: SET.map(v => ({ ...v }))
            })),
            getSnapshot: sinon.stub().resolves(null)
        };
        hub = createMockHub({ db });
        Object.assign(hub, { db, network: 'testnet', capabilitySnapshot: capSnapshot,
            hubDbBroadcaster: broadcaster, oracleConsensus: null });
        hub.getPeerManager = sinon.stub().returns(null);
        hub['resolveBtcLatestBlock'] = sinon.stub().resolves(TIP);
        agg = new PriceAggregator(hub);
    });
    afterEach(function () {
        if (agg) agg.stopPriceCapabilityDerivation();
        restoreEnv(envSaved);
        sinon.restore();
    });
}

function registerRowTests() {
    it('writes one row per effective signer key, keyed on the BTC height', async function () {
        await agg.runPriceCapabilityDerivation();
        const rows = indexerReadsWeights(db, 'price', ANCHOR);
        expect(rows).to.have.length(4);
        expect(rows.map(row => row.source).sort()).to.deep.equal(SET.map(value => value.source).sort());
        for (const row of rows) expect(row.weight).to.equal('250000.00000000');
    });
    it('is byte-identical to what the consensus writer emits for the same block', async function () {
        // The same capability set, the same block, through both writers. The rows a
        // chain-only hub mirrors must be indistinguishable from a validator hub's,
        // or the two mirrors disagree about who was price-capable at a BTC height.
        const consensusDb  = makeFakeDb();
        const consensusHub = createMockHub({ db: consensusDb });
        consensusHub.db                 = consensusDb;
        consensusHub.network            = 'testnet';
        consensusHub.capabilitySnapshot = capSnapshot;
        consensusHub.hubDbBroadcaster   = null;
        const oc = new OracleConsensus(consensusHub, null);
        oc.db = consensusDb;
        await oc.persistCapabilitySnapshot('price', ANCHOR);
        await agg.persistPriceCapabilitySnapshot(ANCHOR);
        const ocInsert  = consensusDb.queries.find(query => /^INSERT IGNORE INTO capability_snapshots/.test(query.sql));
        const aggInsert = db.queries.find(query => /^INSERT IGNORE INTO capability_snapshots/.test(query.sql));
        expect(ocInsert, 'consensus path wrote nothing').to.exist;
        expect(aggInsert, 'derivation path wrote nothing').to.exist;
        expect(aggInsert.sql).to.equal(ocInsert.sql);
        expect(aggInsert.args).to.deep.equal(ocInsert.args);
    });
    it('mirrors every committed row to hub-DB subscribers', async function () {
        await agg.persistPriceCapabilitySnapshot(ANCHOR);
        expect(broadcaster.broadcastRow.callCount).to.equal(4);
        for (const call of broadcaster.broadcastRow.getCalls()) {
            expect(call.args[0].table).to.equal('capability_snapshots');
            expect(call.args[0].row.capability).to.equal('price');
            expect(Number(call.args[0].row.snapshot_block)).to.equal(ANCHOR);
        }
    });
}

function registerRowCacheTest() {
    it('spends no second read on a (capability, height) it already covered, and picks up a new tip', async function () {
        await agg.runPriceCapabilityDerivation();
        expect(capSnapshot.getWeightSnapshot.callCount).to.equal(GRID);
        hub.resolveBtcLatestBlock.resolves(TIP + 1);
        const second = await agg.runPriceCapabilityDerivation();
        // One new height, every capability: nothing already covered is re-read.
        expect(second.written).to.equal(CAPS.length);
        expect(capSnapshot.getWeightSnapshot.callCount).to.equal(GRID + CAPS.length);
        expect(capSnapshot.getWeightSnapshot.getCalls().slice(-CAPS.length)
            .every(call => call.args[1] === TIP + 1)).to.be.true;
        // The window slid, so the height that fell out of it is forgotten rather than
        // accumulated: each capability's covered set is bounded by the lookback.
        for (const capability of CAPS)
            expect(agg._capDerivedBlocks.get(capability).size, capability).to.equal(WINDOW);
    });
}

function registerUnavailableTests() {
    it('refuses every height when HUB_NETWORK is unset without reading or writing a snapshot', async function () {
        const warn = sinon.stub(console, 'warn');
        hub.network = '';

        const refusal = await agg.persistPriceCapabilitySnapshot(ANCHOR);
        expect(refusal).to.deep.equal({ status: 'unresolved', rows: 0,
            detail: 'HUB_NETWORK is unset; capability snapshot derivation refused' });

        const res = await agg.runPriceCapabilityDerivation();
        expect(res.written).to.equal(0);
        expect(res.failed).to.equal(GRID);
        expect(capSnapshot.getSnapshot.called).to.be.false;
        expect(capSnapshot.getWeightSnapshot.called).to.be.false;
        expect(db.store.size).to.equal(0);
        expect(db.queries.filter(query => /INSERT/.test(query.sql))).to.have.length(0);
        expect(broadcaster.broadcastRow.called).to.be.false;
        expect(warn.getCalls().some(call => /HUB_NETWORK is unset; capability snapshot derivation refused/
            .test(call.args.join(' ')))).to.be.true;
        for (const capability of CAPS)
            expect(agg._capDerivedBlocks.get(capability).size, capability).to.equal(0);
    });
    it('writes NOTHING when the Bitcoin view is unreachable, and says so', async function () {
        const err = sinon.stub(console, 'warn');
        capSnapshot.getWeightSnapshot.resolves(null);   // CapabilitySnapshot's degraded sentinel
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.written).to.equal(0);
        expect(res.failed).to.equal(GRID);
        expect(db.store.size).to.equal(0);
        expect(db.queries.filter(query => /INSERT/.test(query.sql))).to.have.length(0);
        expect(err.called).to.be.true;
        expect(err.getCalls().some(call => /unreachable or degraded/.test(call.args.join(' ')))).to.be.true;
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
            .to.equal('invalid: insufficient signer stake');
    });
    it('retries an unresolved height on the next pass rather than marking it covered', async function () {
        sinon.stub(console, 'warn');
        capSnapshot.getWeightSnapshot.resolves(null);
        await agg.runPriceCapabilityDerivation();
        for (const capability of CAPS)
            expect(agg._capDerivedBlocks.get(capability).size, capability).to.equal(0);
        capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => ({
            capability, blockIndex: block, count: SET.length, truncated: false,
            validators: SET.map(value => ({ ...value }))
        }));
        const second = await agg.runPriceCapabilityDerivation();
        expect(second.written).to.equal(GRID);
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS)).to.equal('valid');
    });
}

function registerClosedSetTests() {
    it('refuses a TRUNCATED set outright (SWQ-TRUNC-MIRROR)', async function () {
        const warn = sinon.stub(console, 'warn');
        capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => ({
            capability, blockIndex: block, count: 500,
            truncated: true,                       // over the source cap
            validators: SET.map(value => ({ ...value }))
        }));
        const res = await agg.persistPriceCapabilitySnapshot(ANCHOR);
        expect(res.status).to.equal('truncated');
        expect(res.rows).to.equal(0);
        // A partial set carries no completeness marker, so mirroring the capped rows
        // would let an off-BTC verifier clear the 2/3 bar over an under-counted S.
        expect(db.store.size).to.equal(0);
        expect(db.queries.filter(query => /INSERT/.test(query.sql))).to.have.length(0);
        expect(broadcaster.broadcastRow.called).to.be.false;
        expect(warn.getCalls().some(call => /TRUNCATED/.test(call.args.join(' ')))).to.be.true;
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
            .to.equal('invalid: insufficient signer stake');
    });
    it('writes NOTHING when the hub cannot resolve a BTC tip, and says so', async function () {
        const err = sinon.stub(console, 'error');
        hub.resolveBtcLatestBlock.resolves(null);
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.ran).to.be.false;
        expect(res.reason).to.equal('no btc tip');
        expect(capSnapshot.getWeightSnapshot.called).to.be.false;
        expect(db.store.size).to.equal(0);
        expect(err.called).to.be.true;
    });
    it('covers a height whose qualifying set is genuinely empty without writing a row', async function () {
        capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => ({
            capability, blockIndex: block, count: 0, truncated: false, validators: []
        }));
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.written).to.equal(0);
        expect(res.empty).to.equal(GRID);
        expect(res.failed).to.equal(0);
        expect(db.store.size).to.equal(0);
        // Nobody qualified, so an off-BTC verifier reading zero rows reaches the same
        // verdict this hub would: fail closed, not a hole to retry.
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
            .to.equal('invalid: insufficient signer stake');
    });
}

function registerDerivedCapabilitySuites() {
    describe('the rows', function () {
        registerFixtureHooks();
        registerRowTests();
        registerRowCacheTest();
    });

    describe('fails closed', function () {
        registerFixtureHooks();
        registerUnavailableTests();
        registerClosedSetTests();
    });
}

describe('PriceAggregator: derived capability snapshots (chain-only hub)', registerDerivedCapabilitySuites);
