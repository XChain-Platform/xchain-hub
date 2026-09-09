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
//
// Derived `price` capability snapshots on a hub that does NOT run oracle consensus
// (oracle PRICE batching, derivation ruling 2026-09-09).
//
// The bug these pin: the only writer of a `price` capability snapshot was
// OracleConsensus._persistCapabilitySnapshot on the round-FINALIZATION path, so a
// chain-only node's hub mirrored an EMPTY capability_snapshots and its indexer, which
// off BTC resolves the price set from that mirrored table alone, recorded every landed
// batch `invalid: insufficient signer stake`.
//
// The ordering is the whole difficulty and it is what `derives before any batch
// arrives` below exists to pin: the indexer validates a parsed batch BEFORE it pushes
// it, so a fix triggered by a VALID batch can never fire. The trigger here is the hub's
// own clock and the Bitcoin view, and NOTHING on the receive path.

const crypto          = require('crypto');
const sinon           = require('sinon');
const proxyquire      = require('proxyquire');
const { expect }      = require('chai');
const PriceAggregator = require('../../src/PriceAggregator');
const OracleConsensus = require('../../src/OracleConsensus');
const swq             = require('../../src/stake_weighted_quorum.js');
const { createMockHub } = require('../helpers/mockHub');

// A real Ed25519 validator key, in the 64-hex lowercase shape the BTC indexer serves
// and capability_snapshots.signing_pubkey stores.
function makePubkey() {
    let { publicKey } = crypto.generateKeyPairSync('ed25519');
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

// The real shape `getstakeweightsbycapability` returns: one row per effective signer
// key, each carrying its staking ADDRESS (source) and that source's aggregate weight.
function makeWeightSet(n) {
    let out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            pubkey: makePubkey(),
            source: 'tb1qderivedstake' + i,
            weight: '250000.00000000'
        });
    }
    return out;
}

// A capability_snapshots table that behaves like the real one for what matters here:
// the natural key (snapshot_block, capability, signing_pubkey, source) and INSERT
// IGNORE's first-write-wins. Every statement is recorded so the parity test can compare
// the SQL and the bound arguments the two writers emit.
function makeFakeDb() {
    let store   = new Map();
    let queries = [];
    return {
        store,
        queries,
        getChainTip: async () => ({ chainId: 'ff'.repeat(32), blockHeight: 1 }),
        doQuery: async (sql, args) => {
            queries.push({ sql: sql, args: (args || []).slice() });
            if (/^INSERT IGNORE INTO capability_snapshots/.test(sql)) {
                for (let i = 0; i < args.length; i += 6) {
                    let row = {
                        snapshot_block: args[i],
                        capability:     args[i + 1],
                        signing_pubkey: args[i + 2],
                        amount:         args[i + 3],
                        source:         args[i + 4],
                        btc_chain_id:   args[i + 5]
                    };
                    let k = [row.snapshot_block, row.capability, row.signing_pubkey, row.source].join('|');
                    if (!store.has(k)) store.set(k, row);
                }
                return { affectedRows: 0 };
            }
            if (/^SELECT \* FROM capability_snapshots/.test(sql)) {
                let k = [args[0], args[1], args[2], args[3]].join('|');
                return store.has(k) ? [store.get(k)] : [];
            }
            return [];
        }
    };
}

// xchain-indexer db.js getCapabilitySnapshotWeights, verbatim in behaviour: off BTC
// this IS how a node resolves the price set, and it matches snapshot_block EXACTLY.
function indexerReadsWeights(db, capability, snapshotBlock) {
    let rows = [...db.store.values()]
        .filter(r => r.capability === capability && Number(r.snapshot_block) === Number(snapshotBlock))
        .sort((a, b) => (a.signing_pubkey < b.signing_pubkey ? -1
                       : a.signing_pubkey > b.signing_pubkey ? 1
                       : a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    return rows.map(r => ({ pubkey: String(r.pubkey || r.signing_pubkey),
                            source: r.source == null ? '' : String(r.source),
                            weight: String(r.amount) }));
}

// The verdict xchain-indexer actions/price.js reaches for a batch anchored at
// `anchor`, signed by `signers`. src/stake_weighted_quorum.js is byte-identical in
// the hub and the indexer (md5 825b15d71eb9972df6a3915e4e6a08b3 in both), so this is
// the indexer's own arithmetic, not a re-implementation of it.
function indexerVerdict(db, anchor, signers) {
    let validators = indexerReadsWeights(db, 'price', anchor);
    return swq.meetsStakeThreshold(validators, signers)
        ? 'valid'
        : 'invalid: insufficient signer stake';
}

describe('PriceAggregator: derived `price` capability snapshots (chain-only hub)', function () {

    // testnet: STAKE_WEIGHTED_QUORUM_ACTIVATION is 0, so every height resolves weighted,
    // which is the mode the measured testnet node runs in.
    const TIP    = 151800;
    const ANCHOR = 151797;      // a batch anchor inside the lookback window

    let hub, agg, db, capSnapshot, broadcaster, envSaved;

    // Restore whatever the surrounding process had, so a test never leaks a knob.
    function saveEnv() {
        return {
            derive:   process.env.HUB_PRICE_CAPABILITY_DERIVE,
            lookback: process.env.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS,
            interval: process.env.HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S
        };
    }
    function restoreEnv(s) {
        for (let [k, v] of [['HUB_PRICE_CAPABILITY_DERIVE', s.derive],
                            ['HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS', s.lookback],
                            ['HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S', s.interval]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }

    const SET = makeWeightSet(4);
    const THREE_SIGNERS = SET.slice(0, 3).map(v => v.pubkey);

    beforeEach(function () {
        envSaved = saveEnv();
        delete process.env.HUB_PRICE_CAPABILITY_DERIVE;
        // A four-height window keeps the driven output small and readable.
        process.env.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS = '4';

        db          = makeFakeDb();
        broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() };
        capSnapshot = {
            getWeightSnapshot: sinon.stub().callsFake(async (capability, block) => ({
                capability: capability,
                blockIndex: block,
                count:      SET.length,
                truncated:  false,
                validators: SET.map(v => ({ ...v }))
            })),
            getSnapshot: sinon.stub().resolves(null)
        };
        hub = createMockHub({ db: db });
        hub.db                     = db;
        hub.network                = 'testnet';
        hub.capabilitySnapshot     = capSnapshot;
        hub.hubDbBroadcaster       = broadcaster;
        hub.oracleConsensus        = null;
        // A chain-only hub has no peer manager: startP2P never ran.
        hub.getPeerManager         = sinon.stub().returns(null);
        hub._resolveBtcLatestBlock = sinon.stub().resolves(TIP);

        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        if (agg) agg.stopPriceCapabilityDerivation();
        restoreEnv(envSaved);
        sinon.restore();
    });

    describe('the ordering trap', function () {

        it('derives the anchor BEFORE any batch arrives, and never touches the receive path', async function () {
            let receive = sinon.spy(agg, 'receiveValidatedBatch');

            // The state the measured node was in: mirror empty, so the indexer refuses.
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
                .to.equal('invalid: insufficient signer stake');

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.ran).to.be.true;
            expect(res.written).to.equal(4);            // TIP-3 .. TIP
            expect(res.tip).to.equal(TIP);
            // No batch was pushed, parsed or validated to get here: the indexer could not
            // have pushed one, because its own verdict above was a refusal.
            expect(receive.called).to.be.false;
            // The set came from the Bitcoin view, at BTC heights, through the hub's own
            // CapabilitySnapshot reads. Validator identity still goes through Bitcoin.
            expect(capSnapshot.getWeightSnapshot.callCount).to.equal(4);
            expect(capSnapshot.getWeightSnapshot.getCalls().map(c => c.args[1]).sort())
                .to.deep.equal([TIP - 3, TIP - 2, TIP - 1, TIP]);
        });

        it('flips the indexer verdict on the batch anchor from refused to valid', async function () {
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
                .to.equal('invalid: insufficient signer stake');
            await agg.runPriceCapabilityDerivation();
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS)).to.equal('valid');
        });

        it('leaves a height OUTSIDE the window refused, so coverage is the window and not a blanket', async function () {
            await agg.runPriceCapabilityDerivation();
            expect(indexerVerdict(db, TIP - 9, THREE_SIGNERS))
                .to.equal('invalid: insufficient signer stake');
        });
    });

    describe('the rows', function () {

        it('writes one row per effective signer key, keyed on the BTC height', async function () {
            await agg.runPriceCapabilityDerivation();
            let rows = indexerReadsWeights(db, 'price', ANCHOR);
            expect(rows).to.have.length(4);
            expect(rows.map(r => r.source).sort())
                .to.deep.equal(SET.map(v => v.source).sort());
            for (let r of rows) expect(r.weight).to.equal('250000.00000000');
        });

        it('is byte-identical to what the consensus writer emits for the same block', async function () {
            // The same capability set, the same block, through both writers. The rows a
            // chain-only hub mirrors must be indistinguishable from a validator hub's,
            // or the two mirrors disagree about who was price-capable at a BTC height.
            let consensusDb  = makeFakeDb();
            let consensusHub = createMockHub({ db: consensusDb });
            consensusHub.db                 = consensusDb;
            consensusHub.network            = 'testnet';
            consensusHub.capabilitySnapshot = capSnapshot;
            consensusHub.hubDbBroadcaster   = null;
            let oc = new OracleConsensus(consensusHub, null);
            oc.db = consensusDb;

            await oc._persistCapabilitySnapshot('price', ANCHOR);
            await agg._persistPriceCapabilitySnapshot(ANCHOR);

            let ocInsert  = consensusDb.queries.find(q => /^INSERT IGNORE INTO capability_snapshots/.test(q.sql));
            let aggInsert = db.queries.find(q => /^INSERT IGNORE INTO capability_snapshots/.test(q.sql));
            expect(ocInsert, 'consensus path wrote nothing').to.exist;
            expect(aggInsert, 'derivation path wrote nothing').to.exist;
            expect(aggInsert.sql).to.equal(ocInsert.sql);
            expect(aggInsert.args).to.deep.equal(ocInsert.args);
        });

        it('mirrors every committed row to hub-DB subscribers', async function () {
            await agg._persistPriceCapabilitySnapshot(ANCHOR);
            expect(broadcaster.broadcastRow.callCount).to.equal(4);
            for (let call of broadcaster.broadcastRow.getCalls()) {
                expect(call.args[0].table).to.equal('capability_snapshots');
                expect(call.args[0].row.capability).to.equal('price');
                expect(Number(call.args[0].row.snapshot_block)).to.equal(ANCHOR);
            }
        });

        it('spends no second read on a height it already covered, and picks up a new tip', async function () {
            await agg.runPriceCapabilityDerivation();
            expect(capSnapshot.getWeightSnapshot.callCount).to.equal(4);

            hub._resolveBtcLatestBlock.resolves(TIP + 1);
            let second = await agg.runPriceCapabilityDerivation();
            expect(second.written).to.equal(1);
            expect(capSnapshot.getWeightSnapshot.callCount).to.equal(5);
            expect(capSnapshot.getWeightSnapshot.lastCall.args[1]).to.equal(TIP + 1);
            // The window slid, so the height that fell out of it is forgotten rather than
            // accumulated: the covered set is bounded by the lookback.
            expect(agg._priceCapDerivedBlocks.size).to.equal(4);
        });
    });

    describe('fails closed', function () {

        it('writes NOTHING when the Bitcoin view is unreachable, and says so', async function () {
            let err = sinon.stub(console, 'warn');
            capSnapshot.getWeightSnapshot.resolves(null);   // CapabilitySnapshot's degraded sentinel

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.written).to.equal(0);
            expect(res.failed).to.equal(4);
            expect(db.store.size).to.equal(0);
            expect(db.queries.filter(q => /INSERT/.test(q.sql))).to.have.length(0);
            expect(err.called).to.be.true;
            expect(err.getCalls().some(c => /unreachable or degraded/.test(c.args.join(' ')))).to.be.true;
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
                .to.equal('invalid: insufficient signer stake');
        });

        it('retries an unresolved height on the next pass rather than marking it covered', async function () {
            sinon.stub(console, 'warn');
            capSnapshot.getWeightSnapshot.resolves(null);
            await agg.runPriceCapabilityDerivation();
            expect(agg._priceCapDerivedBlocks.size).to.equal(0);

            capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => ({
                capability: capability, blockIndex: block, count: SET.length,
                truncated: false, validators: SET.map(v => ({ ...v }))
            }));
            let second = await agg.runPriceCapabilityDerivation();
            expect(second.written).to.equal(4);
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS)).to.equal('valid');
        });

        it('refuses a TRUNCATED set outright (SWQ-TRUNC-MIRROR)', async function () {
            let warn = sinon.stub(console, 'warn');
            capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => ({
                capability: capability, blockIndex: block, count: 500,
                truncated:  true,                       // over the source cap
                validators: SET.map(v => ({ ...v }))
            }));

            let res = await agg._persistPriceCapabilitySnapshot(ANCHOR);

            expect(res.status).to.equal('truncated');
            expect(res.rows).to.equal(0);
            // A partial set carries no completeness marker, so mirroring the capped rows
            // would let an off-BTC verifier clear the 2/3 bar over an under-counted S.
            expect(db.store.size).to.equal(0);
            expect(db.queries.filter(q => /INSERT/.test(q.sql))).to.have.length(0);
            expect(broadcaster.broadcastRow.called).to.be.false;
            expect(warn.getCalls().some(c => /TRUNCATED/.test(c.args.join(' ')))).to.be.true;
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
                .to.equal('invalid: insufficient signer stake');
        });

        it('writes NOTHING when the hub cannot resolve a BTC tip, and says so', async function () {
            let err = sinon.stub(console, 'error');
            hub._resolveBtcLatestBlock.resolves(null);

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.ran).to.be.false;
            expect(res.reason).to.equal('no btc tip');
            expect(capSnapshot.getWeightSnapshot.called).to.be.false;
            expect(db.store.size).to.equal(0);
            expect(err.called).to.be.true;
        });

        it('covers a height whose qualifying set is genuinely empty without writing a row', async function () {
            capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => ({
                capability: capability, blockIndex: block, count: 0,
                truncated: false, validators: []
            }));
            let res = await agg.runPriceCapabilityDerivation();
            expect(res.written).to.equal(0);
            expect(res.empty).to.equal(4);
            expect(res.failed).to.equal(0);
            expect(db.store.size).to.equal(0);
            // Nobody qualified, so an off-BTC verifier reading zero rows reaches the same
            // verdict this hub would: fail closed, not a hole to retry.
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
                .to.equal('invalid: insufficient signer stake');
        });
    });

    describe('a hub that DOES run oracle consensus is untouched', function () {

        it('writes nothing and disarms itself once oracleConsensus exists', async function () {
            hub.oracleConsensus = { /* the round-finalization writer owns these rows */ };
            agg.startPriceCapabilityDerivation();
            expect(agg._priceCapDeriveTimer).to.not.equal(null);

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.ran).to.be.false;
            expect(res.reason).to.equal('hub runs oracle consensus');
            expect(hub._resolveBtcLatestBlock.called).to.be.false;
            expect(db.store.size).to.equal(0);
            expect(agg._priceCapDeriveTimer).to.equal(null);
        });

        it('treats a peer manager as the same answer, closing the boot race', async function () {
            // startOracle()'s ONLY precondition is a peer manager, and it runs a few awaits
            // after start() arms the timer. Without this arm a slow boot would let one pass
            // fire on a validator hub.
            hub.oracleConsensus = null;
            hub.getPeerManager  = sinon.stub().returns({ validatorAddr: 'ws://validator-1:10001' });

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.reason).to.equal('hub runs oracle consensus');
            expect(hub._resolveBtcLatestBlock.called).to.be.false;
        });
    });

    describe('the kill switch', function () {

        it('HUB_PRICE_CAPABILITY_DERIVE=off arms nothing and derives nothing', async function () {
            let warn = sinon.stub(console, 'warn');
            process.env.HUB_PRICE_CAPABILITY_DERIVE = 'off';

            expect(agg.startPriceCapabilityDerivation()).to.be.false;
            expect(agg._priceCapDeriveTimer).to.equal(null);
            let res = await agg.runPriceCapabilityDerivation();
            expect(res.reason).to.equal('disabled');
            expect(db.store.size).to.equal(0);
            // Silence here would be the failure this whole path closes, so the hub says
            // what the operator has just turned off.
            expect(warn.getCalls().some(c => /insufficient signer stake/.test(c.args.join(' ')))).to.be.true;
        });

        it('anything else leaves it armed', function () {
            process.env.HUB_PRICE_CAPABILITY_DERIVE = 'on';
            expect(agg.startPriceCapabilityDerivation()).to.be.true;
            expect(agg._priceCapDeriveTimer).to.not.equal(null);
        });
    });
});

describe('XChainHub.start() arms the price capability derivation', function () {

    let XChainHub, mockDb;

    before(function () {
        this.timeout(30000);
        XChainHub = proxyquire('../../src/XChainHub', { './db': function () { return mockDb; } });
    });

    beforeEach(function () {
        mockDb = {
            doQuery:        sinon.stub().resolves([]),
            createDatabase: sinon.stub().resolves(true),
            verifyTables:   sinon.stub().resolves(true),
            runMigrations:  sinon.stub().resolves(true),
            close:          sinon.stub().resolves()
        };
    });

    afterEach(function () { sinon.restore(); });

    it('arms it on a STANDALONE hub, where nothing else writes a price snapshot', async function () {
        // No p2pConfig: the topology every non-validator xchain-node install runs.
        let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
        await hub.start();
        try {
            expect(hub.priceAggregator._priceCapDeriveTimer).to.not.equal(null);
        } finally {
            hub.priceAggregator.stopPriceCapabilityDerivation();
        }
    });

    it('disarms it on close, so no pass runs against a closed pool', async function () {
        let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
        await hub.start();
        await hub.close();
        expect(hub.priceAggregator._priceCapDeriveTimer).to.equal(null);
    });
});
