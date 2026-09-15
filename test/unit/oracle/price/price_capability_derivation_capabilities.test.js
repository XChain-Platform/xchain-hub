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
const swq             = require('../../../../src/stake_weighted_quorum.js');
const { createMockHub } = require('../../../helpers/mockHub');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

// testnet: STAKE_WEIGHTED_QUORUM_ACTIVATION is 0, so every height resolves weighted,
// which is the mode the measured testnet node runs in.
const TIP    = 151800;
const ANCHOR = 151797;      // a batch anchor inside the lookback window

// Every capability the consensus path persists, and the number the window/capability
// grid produces. Spelled out here rather than imported so a silent narrowing of the
// module's own list (the exact regression this row fixes) fails these tests instead
// of agreeing with itself.
const CAPS   = ['price', 'oracle_publish', 'cross_chain', 'attestation'];
const WINDOW = 4;                       // HUB_..._LOOKBACK_BLOCKS below
const GRID   = WINDOW * CAPS.length;    // (capability, height) pairs in one pass

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
        .filter(r => r.capability === capability && Number(r.snapshot_block) === Number(snapshotBlock))
        .sort((a, b) => (a.signing_pubkey < b.signing_pubkey ? -1
                       : a.signing_pubkey > b.signing_pubkey ? 1
                       : a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    return rows.map(r => ({ pubkey: String(r.pubkey || r.signing_pubkey),
                            source: r.source == null ? '' : String(r.source),
                            weight: String(r.amount) }));
}

// `capability` selects which rail's verdict is being asked for: actions/price.js reads
// the `price` set, actions/attest/index.js (via getStakeWeightsByCapability('attestation',
// anchor)) reads the `attestation` set, and the cross-chain verifiers read `cross_chain`.
// The predicate is the same in all three; only the rows differ.
function indexerVerdict(targetDb, anchor, signers, capability) {
    const validators = indexerReadsWeights(targetDb, capability || 'price', anchor);
    return swq.meetsStakeThreshold(validators, signers)
        ? 'valid'
        : 'invalid: insufficient signer stake';
}

// The status xchain-indexer actions/anchor.js stamps on an ARCHIVE HEAD whose payload
// declares SNAPSHOT_BLOCK. Its shape is NOT the price/attest one: an empty
// `oracle_publish` set is not a refusal, it is `unverified` (anchor.js:384-387,
// `if(oracleN === 0){ data['STATUS'] = 'unverified'; }`), which is the divergence the
// measured node actually showed. Only once the set is non-empty does the quorum
// predicate decide valid vs refused.
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
        hub['_resolveBtcLatestBlock'] = sinon.stub().resolves(TIP);
        agg = new PriceAggregator(hub);
    });
    afterEach(function () {
        if (agg) agg.stopPriceCapabilityDerivation();
        restoreEnv(envSaved);
        sinon.restore();
    });
}

function registerCapabilityVerdictTests() {
    it('derives ALL FOUR, not `price` alone: the measured node held only `price`', async function () {
        await agg.runPriceCapabilityDerivation();
        // The shape the real chain-only node was in (1,148 rows, one capability).
        const written = [...new Set([...db.store.values()].map(r => r.capability))].sort();
        expect(written).to.deep.equal(CAPS.slice().sort());
        // Every capability covers the whole window, not just the tip.
        for (const capability of CAPS) {
            for (const height of [TIP - 3, TIP - 2, TIP - 1, TIP])
                expect(indexerReadsWeights(db, capability, height), capability + '@' + height).to.have.length(SET.length);
        }
    });
    it('flips the ATTEST refusal the node showed five times, from refused to valid', async function () {
        // xchain-indexer judges a v5 ATTEST head by getStakeWeightsByCapability
        // ('attestation', anchor), which off BTC is the hub-mirrored table alone. With
        // nobody writing those rows the node refused five ATTEST actions origin called
        // valid in the measured deployment.
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'attestation'))
            .to.equal('invalid: insufficient signer stake');
        await agg.runPriceCapabilityDerivation();
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'attestation')).to.equal('valid');
    });
    it('flips the ANCHOR archive head from `unverified` to a real verdict', async function () {
        // anchor.js:384-387: oracleN === 0 is not a refusal, it is `unverified`, which
        // is why this assertion is not the ATTEST one with a different capability.
        expect(indexerArchiveHeadStatus(db, ANCHOR, THREE_SIGNERS)).to.equal('unverified');
        await agg.runPriceCapabilityDerivation();
        expect(indexerArchiveHeadStatus(db, ANCHOR, THREE_SIGNERS)).to.equal('valid');
    });
    it('flips the cross_chain verdict, so a match verifier resolves a real set', async function () {
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'cross_chain'))
            .to.equal('invalid: insufficient signer stake');
        await agg.runPriceCapabilityDerivation();
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'cross_chain')).to.equal('valid');
    });
    it('still fails a capability closed when its own signers do not clear the bar', async function () {
        // The point of deriving is not to make everything valid: it is to give the
        // verifier the real set. One signer out of four sources cannot clear 3S > 2T,
        // and the derived rows must not change that.
        await agg.runPriceCapabilityDerivation();
        for (const capability of CAPS)
            expect(indexerVerdict(db, ANCHOR, [SET[0].pubkey], capability), capability)
                .to.equal('invalid: insufficient signer stake');
    });
}

function registerCapabilityParityTest() {
    it('is byte-identical to the consensus writer for EVERY capability, not just price', async function () {
        // OracleConsensus._persistCapabilitySnapshot(capability, block) is the shared
        // consensus writer's four-argument shape (StateCheckpointEngine and
        // AttestationBatchPublisher call snapWrite the same way). If the derived rows
        // differ for any capability, the two mirrors disagree about who was capable at
        // a BTC height, which is the fork this pass exists to avoid.
        for (const capability of CAPS) {
            const consensusDb  = makeFakeDb();
            const consensusHub = createMockHub({ db: consensusDb });
            consensusHub.db                 = consensusDb;
            consensusHub.network            = 'testnet';
            consensusHub.capabilitySnapshot = capSnapshot;
            consensusHub.hubDbBroadcaster   = null;
            const oc = new OracleConsensus(consensusHub, null);
            oc.db = consensusDb;
            const derivedDb  = makeFakeDb();
            const derivedHub = createMockHub({ db: derivedDb });
            derivedHub.db                 = derivedDb;
            derivedHub.network            = 'testnet';
            derivedHub.capabilitySnapshot = capSnapshot;
            derivedHub.hubDbBroadcaster   = null;
            const derived = new PriceAggregator(derivedHub);
            await oc._persistCapabilitySnapshot(capability, ANCHOR);
            await derived.persistDerivedCapabilitySnapshot(capability, ANCHOR);
            const ocInsert  = consensusDb.queries.find(q => /^INSERT IGNORE INTO capability_snapshots/.test(q.sql));
            const devInsert = derivedDb.queries.find(q => /^INSERT IGNORE INTO capability_snapshots/.test(q.sql));
            expect(ocInsert, capability + ': consensus path wrote nothing').to.exist;
            expect(devInsert, capability + ': derivation path wrote nothing').to.exist;
            expect(devInsert.sql, capability).to.equal(ocInsert.sql);
            expect(devInsert.args, capability).to.deep.equal(ocInsert.args);
            // And the capability really is the one asked for, not `price` under a label.
            expect(devInsert.args[1], capability).to.equal(capability);
        }
    });
}

function registerCapabilityReportingTests() {
    it('mirrors every capability to hub-DB subscribers under its own name', async function () {
        await agg.runPriceCapabilityDerivation();
        const seen = new Set();
        for (const call of broadcaster.broadcastRow.getCalls()) {
            expect(call.args[0].table).to.equal('capability_snapshots');
            seen.add(call.args[0].row.capability);
        }
        expect([...seen].sort()).to.deep.equal(CAPS.slice().sort());
        expect(broadcaster.broadcastRow.callCount).to.equal(GRID * SET.length);
    });
    it('reports per-capability tallies so one stuck capability names itself', async function () {
        // A single `written` number would hide three healthy capabilities behind a
        // fourth that never resolves, which is exactly how `price`-only shipped
        // unnoticed. attestation is the one made to fail here.
        sinon.stub(console, 'warn');
        capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => {
            if (capability === 'attestation') return null;   // degraded read
            return { capability, blockIndex: block, count: SET.length,
                     truncated: false, validators: SET.map(v => ({ ...v })) };
        });
        const res = await agg.runPriceCapabilityDerivation();
        expect(res.byCapability.attestation.written).to.equal(0);
        expect(res.byCapability.attestation.failed).to.equal(WINDOW);
        for (const capability of ['price', 'oracle_publish', 'cross_chain']) {
            expect(res.byCapability[capability].written, capability).to.equal(WINDOW);
            expect(res.byCapability[capability].failed, capability).to.equal(0);
        }
        // The healthy three are covered, the stuck one is not, and it is retried.
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS)).to.equal('valid');
        expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'attestation'))
            .to.equal('invalid: insufficient signer stake');
        expect(agg._capDerivedBlocks.get('attestation').size).to.equal(0);
    });
    it('names the capability in the once-per-height warning', async function () {
        const warn = sinon.stub(console, 'warn');
        capSnapshot.getWeightSnapshot.callsFake(async capability =>
            (capability === 'oracle_publish' ? null : { capability, count: 0, truncated: false, validators: [] }));
        await agg.runPriceCapabilityDerivation();
        const lines = warn.getCalls().map(call => call.args.join(' '));
        expect(lines.some(line => /`oracle_publish` capability snapshot/.test(line))).to.be.true;
        expect(lines.some(line => /`price` capability snapshot/.test(line))).to.be.false;
    });
}

function registerDerivedCapabilitySuites() {
    // The `every capability` block below drives each of those refusals to its flip.
    describe('every capability the consensus path persists', function () {
        registerFixtureHooks();
        registerCapabilityVerdictTests();
        registerCapabilityParityTest();
        registerCapabilityReportingTests();
    });
}

describe('PriceAggregator: derived capability snapshots (chain-only hub)', registerDerivedCapabilitySuites);
