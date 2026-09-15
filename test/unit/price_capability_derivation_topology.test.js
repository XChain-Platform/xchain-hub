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
const PriceAggregator = require('../../src/oracle/price_aggregator');
const swq             = require('../../src/stake_weighted_quorum.js');
const { createMockHub } = require('../helpers/mockHub');
const { DB_METHODS } = require('../helpers/mockHub.js');

const TIP    = 151800;
const ANCHOR = 151797;
const CAPS   = ['price', 'oracle_publish', 'cross_chain', 'attestation'];
const WINDOW = 4;

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

function indexerArchiveHeadStatus(targetDb, snapshotBlock, signers) {
    const validators = indexerReadsWeights(targetDb, 'oracle_publish', snapshotBlock);
    if (validators.length === 0) return 'unverified';
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
const THREE_SIGNERS = SET.slice(0, 3).map(value => value.pubkey);

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
                validators: SET.map(value => ({ ...value }))
            })),
            getSnapshot: sinon.stub().resolves(null)
        };
        hub = createMockHub({ db });
        Object.assign(hub, { db, network: 'testnet', capabilitySnapshot: capSnapshot,
            hubDbBroadcaster: broadcaster, oracleConsensus: null });
        hub.getPeerManager = sinon.stub().returns(null);
        hub['_resolveBtcLatestBlock'] = sinon.stub().resolves(TIP);
        agg = new PriceAggregator(hub);
    });
    afterEach(function () {
        if (agg) agg.stopPriceCapabilityDerivation();
        restoreEnv(envSaved);
        sinon.restore();
    });
}

// The validator shape: a signing identity plus every capability's writer. Spelled
// out rather than imported, for the reason CAPS is.
function makeValidator(targetHub) {
    targetHub.identity                  = { getPubkeyHex: () => 'aa'.repeat(32) };
    targetHub.oracleConsensus           = { /* price, round finalization */ };
    targetHub.stateCheckpoints          = { /* oracle_publish, archive-head verifier */ };
    targetHub.crossChainCalls           = { /* cross_chain, XCALL dispatch */ };
    targetHub.attestationBatchPublisher = { /* attestation, v5 ATTEST head */ };
}

function registerValidatorTests() {
    it('writes nothing and disarms itself when all four writers run here', async function () {
        makeValidator(hub);
        agg.startPriceCapabilityDerivation();
        expect(agg._priceCapDeriveTimer).to.not.equal(null);
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.ran).to.be.false;
        expect(res.reason).to.equal('hub runs consensus for every derived capability');
        expect(hub._resolveBtcLatestBlock.called).to.be.false;
        expect(db.store.size).to.equal(0);
        expect(agg._priceCapDeriveTimer).to.equal(null);
    });
    it('disarms on a hub whose identity is reachable only through getIdentity()', async function () {
        // startP2P assigns `identity` directly, but every hub double in this repo
        // exposes it through the accessor, and reading only the field would make a
        // validator double derive rows its own writers own.
        makeValidator(hub);
        delete hub.identity;
        hub.getIdentity = sinon.stub().returns({ getPubkeyHex: () => 'aa'.repeat(32) });
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.reason).to.equal('hub runs consensus for every derived capability');
        expect(hub._resolveBtcLatestBlock.called).to.be.false;
    });
}

// The gate must ask its question per capability, off the signing identity.
// Asking ONE question for all four and answering it from the PEER MANAGER lets
// any hub in the mesh disarm the whole pass, and the mesh is the shape the public
// tier runs: a peer manager so federation frames arrive, no signing key, so
// nothing it sees is ever finalized under its key and NOTHING writes
// oracle_publish, cross_chain or attestation on it.
function registerMeshTests() {
    it('runs the pass instead of disarming, with a peer manager present', async function () {
        agg.startPriceCapabilityDerivation();
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.ran).to.be.true;
        expect(res.capabilities).to.deep.equal(CAPS);
        // Still armed: the next pass must keep the window covered as the tip moves.
        expect(agg._priceCapDeriveTimer).to.not.equal(null);
    });
    for (const capability of CAPS) {
        it('derives `' + capability + '` at the anchor, which nothing else wrote here', async function () {
            expect(indexerReadsWeights(db, capability, ANCHOR)).to.have.lengthOf(0);
            await agg.runPriceCapabilityDerivation();
            expect(indexerReadsWeights(db, capability, ANCHOR)).to.have.lengthOf(SET.length);
        });
    }
    it('flips the three refusals the measured node showed, on a peer-manager hub', async function () {
        await agg.runPriceCapabilityDerivation();
        // The five ATTEST actions refused `invalid: insufficient signer stake`.
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'attestation')).to.equal('valid');
        // The ANCHOR archive head stored `unverified`.
        expect(indexerArchiveHeadStatus(db, ANCHOR, THREE_SIGNERS)).to.equal('valid');
        // The cross-chain match verifier, on the same rail.
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'cross_chain')).to.equal('valid');
    });
    it('logs no unavailable-snapshot warning for any capability', async function () {
        const warn = sinon.stub(console, 'warn');
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.failed).to.equal(0);
        expect(warn.getCalls().some(call => /capability snapshot written/.test(call.args.join(' ')))).to.be.false;
    });
}

function registerOwnedCapabilityTests() {
    // A validator that holds ONE capability's writer: the other three are still
    // uncovered on it, and a single global answer would have skipped all four.
    for (const owned of CAPS) {
        const engine = { price: 'oracleConsensus', oracle_publish: 'stateCheckpoints',
                       cross_chain: 'crossChainCalls', attestation: 'attestationBatchPublisher' }[owned];
        it('skips `' + owned + '` (its writer runs here) and derives the other three', async function () {
            hub.identity = { getPubkeyHex: () => 'aa'.repeat(32) };
            hub[engine]  = { /* the only consensus writer this hub holds */ };
            const res = await agg.runPriceCapabilityDerivation();
            expect(res.ran).to.be.true;
            expect(res.capabilities).to.deep.equal(CAPS.filter(capability => capability !== owned));
            // The consensus writer's own rows are its business: this pass wrote none.
            expect(indexerReadsWeights(db, owned, ANCHOR)).to.have.lengthOf(0);
            for (const other of CAPS.filter(capability => capability !== owned))
                expect(indexerReadsWeights(db, other, ANCHOR)).to.have.lengthOf(SET.length);
            expect(agg._priceCapDeriveTimer).to.equal(null);   // never armed in this test
        });
    }
    it('spends its per-tick budget on the uncovered capabilities only', async function () {
        hub.identity        = { getPubkeyHex: () => 'aa'.repeat(32) };
        hub.oracleConsensus = {};
        const res = await agg.runPriceCapabilityDerivation();
        // The grid is the window times the capabilities STILL uncovered, so a skipped
        // capability frees its share of the budget rather than wasting it.
        expect(res.considered).to.equal(WINDOW * (CAPS.length - 1));
    });
}

function registerKillSwitchTests() {
    it('HUB_PRICE_CAPABILITY_DERIVE=off arms nothing and derives nothing', async function () {
        const warn = sinon.stub(console, 'warn');
        process.env.HUB_PRICE_CAPABILITY_DERIVE = 'off';
        expect(agg.startPriceCapabilityDerivation()).to.be.false;
        expect(agg._priceCapDeriveTimer).to.equal(null);
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.reason).to.equal('disabled');
        expect(db.store.size).to.equal(0);
        // Silence here would be the failure this whole path closes, so the hub says
        // what the operator has just turned off.
        expect(warn.getCalls().some(call => /insufficient signer stake/.test(call.args.join(' ')))).to.be.true;
    });
    it('anything else leaves it armed', function () {
        process.env.HUB_PRICE_CAPABILITY_DERIVE = 'on';
        expect(agg.startPriceCapabilityDerivation()).to.be.true;
        expect(agg._priceCapDeriveTimer).to.not.equal(null);
    });
}

function registerDerivedCapabilitySuites() {
    describe('a hub whose consensus path writes every capability is untouched', function () {
        registerFixtureHooks();
        registerValidatorTests();
    });

    describe('a mesh hub that signs nothing derives every capability', function () {
        registerFixtureHooks();
        beforeEach(function () {
            // In the mesh, and holding no signing key: startP2P builds the peer manager
            // unconditionally but mints an identity only from SIGNING_PRIVKEY_HEX.
            hub.getPeerManager = sinon.stub().returns({ validatorAddr: 'ws://validator-1:10001' });
            hub.getIdentity    = sinon.stub().returns(null);
            hub.identity       = null;
        });
        registerMeshTests();
    });

    describe('one covered capability disarms nothing', function () {
        registerFixtureHooks();
        registerOwnedCapabilityTests();
    });

    describe('the kill switch', function () {
        registerFixtureHooks();
        registerKillSwitchTests();
    });
}

describe('PriceAggregator: derived capability snapshots (chain-only hub)', registerDerivedCapabilitySuites);
