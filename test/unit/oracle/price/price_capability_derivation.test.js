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
// Derived capability snapshots on a hub that does NOT run oracle consensus
// (oracle PRICE batching, derivation ruling 2026-09-09; widened to all four
// capabilities by the operator's dq 2 option (a) ruling, same day).
//
// The bug these pin: the only writer of a `price` capability snapshot was
// OracleConsensus._persistCapabilitySnapshot on the round-FINALIZATION path, so a
// chain-only node's hub mirrored an EMPTY capability_snapshots and its indexer, which
// off BTC resolves the price set from that mirrored table alone, recorded every landed
// batch `invalid: insufficient signer stake`.
//
// The FIRST build of this pass derived `price` alone, which left the same hole open on
// every other capability the consensus path persists. Measured on the real testnet
// chain-only node 2026-09-09: its HubMirror held 1,148 capability_snapshots rows over
// BTC [151560..151723] and EVERY ONE was `price`. Of 13 verdict divergences against
// origin, five were ATTEST actions refused `invalid: insufficient signer stake` (no
// `attestation` snapshot) and one was an ANCHOR archive head stored `unverified` (no
// `oracle_publish` snapshot: xchain-indexer actions/anchor.js:384-387, `oracleN === 0`).
//
// The ordering is the whole difficulty and it is what `derives before any batch
// arrives` below exists to pin: the indexer validates a parsed batch BEFORE it pushes
// it, so a fix triggered by a VALID batch can never fire. The trigger here is the hub's
// own clock and the Bitcoin view, and NOTHING on the receive path.

const crypto          = require('crypto');
const sinon           = require('sinon');
const proxyquire      = require('proxyquire');
const { expect }      = require('chai');
const PriceAggregator = require('../../../../src/oracle/price_aggregator');
const swq             = require('../../../../src/stake_weighted_quorum.js');
const { createMockHub } = require('../../../helpers/mockHub');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const TIP    = 151800;
const ANCHOR = 151797;
const CAPS   = ['price', 'oracle_publish', 'cross_chain', 'attestation'];
const WINDOW = 4;
const GRID   = WINDOW * CAPS.length;

let hub, agg, db, capSnapshot, broadcaster, envSaved;

// A real Ed25519 validator key, in the 64-hex lowercase shape the BTC indexer serves
// and capability_snapshots.signing_pubkey stores.
function makePubkey() {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

// The real shape `getstakeweightsbycapability` returns: one row per effective signer
// key, each carrying its staking ADDRESS (source) and that source's aggregate weight.
function makeWeightSet(n) {
    const out = [];
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
    const store   = new Map();
    const queries = [];
    return { ...DB_METHODS,
        store,
        queries,
        getChainTip: async () => ({ chainId: 'ff'.repeat(32), blockHeight: 1 }),
        doQuery: async (sql, args) => {
            queries.push({ sql: sql, args: (args || []).slice() });
            if (/^INSERT IGNORE INTO capability_snapshots/.test(sql)) {
                for (let i = 0; i < args.length; i += 6) {
                    const row = {
                        snapshot_block: args[i],
                        capability:     args[i + 1],
                        signing_pubkey: args[i + 2],
                        amount:         args[i + 3],
                        source:         args[i + 4],
                        btc_chain_id:   args[i + 5]
                    };
                    const k = [row.snapshot_block, row.capability, row.signing_pubkey, row.source].join('|');
                    if (!store.has(k)) store.set(k, row);
                }
                return { affectedRows: 0 };
            }
            if (/^SELECT \* FROM capability_snapshots/.test(sql)) {
                const k = [args[0], args[1], args[2], args[3]].join('|');
                return store.has(k) ? [store.get(k)] : [];
            }
            return [];
        }
    };
}

// xchain-indexer db/index.js getCapabilitySnapshotWeights, verbatim in behaviour: off BTC
// this IS how a node resolves the price set, and it matches snapshot_block EXACTLY.
function indexerReadsWeights(targetDb, capability, snapshotBlock) {
    const rows = [...targetDb.store.values()]
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
function indexerVerdict(targetDb, anchor, signers, capability) {
    const validators = indexerReadsWeights(targetDb, capability || 'price', anchor);
    return swq.meetsStakeThreshold(validators, signers)
        ? 'valid'
        : 'invalid: insufficient signer stake';
}

// Restore whatever the surrounding process had, so a test never leaks a knob.
function saveEnv() {
    return {
        derive:   process.env.HUB_PRICE_CAPABILITY_DERIVE,
        lookback: process.env.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS,
        interval: process.env.HUB_PRICE_CAPABILITY_DERIVE_INTERVAL_S
    };
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
        // A four-height window keeps the driven output small and readable.
        process.env.HUB_PRICE_CAPABILITY_DERIVE_LOOKBACK_BLOCKS = '4';
        db          = makeFakeDb();
        broadcaster = { broadcastRow: sinon.stub(), broadcastDeletion: sinon.stub() };
        capSnapshot = {
            getWeightSnapshot: sinon.stub().callsFake(async (capability, block) => ({
                capability: capability, blockIndex: block, count: SET.length,
                truncated: false, validators: SET.map(v => ({ ...v }))
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
        hub.resolveBtcLatestBlock = sinon.stub().resolves(TIP);
        agg = new PriceAggregator(hub);
    });
    afterEach(function () {
        if (agg) agg.stopPriceCapabilityDerivation();
        restoreEnv(envSaved);
        sinon.restore();
    });
}

function orderingSuite() {
    it('derives the anchor BEFORE any batch arrives, and never touches the receive path', async function () {
        const receive = sinon.spy(agg, 'receiveValidatedBatch');
        // The state the measured node was in: mirror empty, so the indexer refuses.
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
            .to.equal('invalid: insufficient signer stake');
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.ran).to.be.true;
        expect(res.written).to.equal(GRID);         // TIP-3 .. TIP, every capability
        expect(res.tip).to.equal(TIP);
        // No batch was pushed, parsed or validated to get here: the indexer could not
        // have pushed one, because its own verdict above was a refusal.
        expect(receive.called).to.be.false;
        // The set came from the Bitcoin view, at BTC heights, through the hub's own
        // CapabilitySnapshot reads. Validator identity still goes through Bitcoin.
        expect(capSnapshot.getWeightSnapshot.callCount).to.equal(GRID);
        const asked = capSnapshot.getWeightSnapshot.getCalls().map(c => c.args[0] + '@' + c.args[1]).sort();
        const want  = [];
        for (const h of [TIP - 3, TIP - 2, TIP - 1, TIP]) for (const c of CAPS) want.push(c + '@' + h);
        expect(asked).to.deep.equal(want.sort());
    });
    it('covers the TIP for every capability before it walks any older height', async function () {
        // The per-tick cap is an RPC budget, so a cold hub whose window is wider than
        // one tick must still have the tip FULLY covered: an ATTEST or an archive head
        // landing now anchors nearest the tip, and covering price-at-tip while leaving
        // attestation-at-tip for a later tick is the same refusal in a smaller window.
        const order = [];
        capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => {
            order.push({ capability, block });
            return { capability, blockIndex: block, count: SET.length,
                     truncated: false, validators: SET.map(v => ({ ...v })) };
        });
        await agg.runPriceCapabilityDerivation();
        expect(order.slice(0, CAPS.length).every(o => o.block === TIP)).to.be.true;
        expect(order.slice(0, CAPS.length).map(o => o.capability).sort())
            .to.deep.equal(CAPS.slice().sort());
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
}

describe('PriceAggregator: derived capability snapshots (chain-only hub)', function () {
    registerFixtureHooks();
    describe('the ordering trap', orderingSuite);
});

describe('XChainHub.start() arms the price capability derivation', function () {
    let XChainHub, mockDb;
    before(function () {
        this.timeout(30000);
        XChainHub = proxyquire('../../../../src/XChainHub', { './db': function () { return mockDb; } });
    });
    beforeEach(function () {
        mockDb = { ...DB_METHODS,
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
        const targetHub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
        await targetHub.start();
        try {
            expect(targetHub.priceAggregator._priceCapDeriveTimer).to.not.equal(null);
        } finally {
            targetHub.priceAggregator.stopPriceCapabilityDerivation();
        }
    });
    it('disarms it on close, so no pass runs against a closed pool', async function () {
        const targetHub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
        await targetHub.start();
        await targetHub.close();
        expect(targetHub.priceAggregator._priceCapDeriveTimer).to.equal(null);
    });
});
