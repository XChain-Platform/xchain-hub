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
// The `every capability` block below drives each of those refusals to its flip.
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
//
// `capability` selects which rail's verdict is being asked for: actions/price.js reads
// the `price` set, actions/attest.js (via getStakeWeightsByCapability('attestation',
// anchor)) reads the `attestation` set, and the cross-chain verifiers read `cross_chain`.
// The predicate is the same in all three; only the rows differ.
function indexerVerdict(db, anchor, signers, capability) {
    let validators = indexerReadsWeights(db, capability || 'price', anchor);
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
function indexerArchiveHeadStatus(db, snapshotBlock, signers) {
    let validators = indexerReadsWeights(db, 'oracle_publish', snapshotBlock);
    if (validators.length === 0) return 'unverified';
    return swq.meetsStakeThreshold(validators, signers)
        ? 'valid'
        : 'invalid: insufficient signer stake';
}

describe('PriceAggregator: derived capability snapshots (chain-only hub)', function () {

    // testnet: STAKE_WEIGHTED_QUORUM_ACTIVATION is 0, so every height resolves weighted,
    // which is the mode the measured testnet node runs in.
    const TIP    = 151800;
    const ANCHOR = 151797;      // a batch anchor inside the lookback window

    // Every capability the consensus path persists, and the number the window/capability
    // grid produces. Spelled out here rather than imported so a silent narrowing of the
    // module's own list (the exact regression this row fixes) fails these tests instead
    // of agreeing with itself.
    const CAPS       = ['price', 'oracle_publish', 'cross_chain', 'attestation'];
    const WINDOW     = 4;                       // HUB_..._LOOKBACK_BLOCKS below
    const GRID       = WINDOW * CAPS.length;    // (capability, height) pairs in one pass

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
            expect(res.written).to.equal(GRID);         // TIP-3 .. TIP, every capability
            expect(res.tip).to.equal(TIP);
            // No batch was pushed, parsed or validated to get here: the indexer could not
            // have pushed one, because its own verdict above was a refusal.
            expect(receive.called).to.be.false;
            // The set came from the Bitcoin view, at BTC heights, through the hub's own
            // CapabilitySnapshot reads. Validator identity still goes through Bitcoin.
            expect(capSnapshot.getWeightSnapshot.callCount).to.equal(GRID);
            let asked = capSnapshot.getWeightSnapshot.getCalls().map(c => c.args[0] + '@' + c.args[1]).sort();
            let want  = [];
            for (let h of [TIP - 3, TIP - 2, TIP - 1, TIP]) for (let c of CAPS) want.push(c + '@' + h);
            expect(asked).to.deep.equal(want.sort());
        });

        it('covers the TIP for every capability before it walks any older height', async function () {
            // The per-tick cap is an RPC budget, so a cold hub whose window is wider than
            // one tick must still have the tip FULLY covered: an ATTEST or an archive head
            // landing now anchors nearest the tip, and covering price-at-tip while leaving
            // attestation-at-tip for a later tick is the same refusal in a smaller window.
            let order = [];
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
    });

    describe('every capability the consensus path persists', function () {

        it('derives ALL FOUR, not `price` alone: the measured node held only `price`', async function () {
            await agg.runPriceCapabilityDerivation();

            // The shape the real chain-only node was in (1,148 rows, one capability).
            let written = [...new Set([...db.store.values()].map(r => r.capability))].sort();
            expect(written).to.deep.equal(CAPS.slice().sort());
            // Every capability covers the whole window, not just the tip.
            for (let c of CAPS) {
                for (let h of [TIP - 3, TIP - 2, TIP - 1, TIP])
                    expect(indexerReadsWeights(db, c, h), c + '@' + h).to.have.length(SET.length);
            }
        });

        it('flips the ATTEST refusal the node showed five times, from refused to valid', async function () {
            // xchain-indexer judges a v5 ATTEST head by getStakeWeightsByCapability
            // ('attestation', anchor), which off BTC is the hub-mirrored table alone. With
            // nobody writing those rows the node refused five ATTEST actions origin called
            // valid (measured 2026-09-09).
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
            for (let c of CAPS)
                expect(indexerVerdict(db, ANCHOR, [SET[0].pubkey], c), c)
                    .to.equal('invalid: insufficient signer stake');
        });

        it('is byte-identical to the consensus writer for EVERY capability, not just price', async function () {
            // OracleConsensus._persistCapabilitySnapshot(capability, block) is the shared
            // consensus writer's four-argument shape (StateCheckpointEngine and
            // AttestationBatchPublisher call snapWrite the same way). If the derived rows
            // differ for any capability, the two mirrors disagree about who was capable at
            // a BTC height, which is the fork this pass exists to avoid.
            for (let capability of CAPS) {
                let consensusDb  = makeFakeDb();
                let consensusHub = createMockHub({ db: consensusDb });
                consensusHub.db                 = consensusDb;
                consensusHub.network            = 'testnet';
                consensusHub.capabilitySnapshot = capSnapshot;
                consensusHub.hubDbBroadcaster   = null;
                let oc = new OracleConsensus(consensusHub, null);
                oc.db = consensusDb;

                let derivedDb  = makeFakeDb();
                let derivedHub = createMockHub({ db: derivedDb });
                derivedHub.db                 = derivedDb;
                derivedHub.network            = 'testnet';
                derivedHub.capabilitySnapshot = capSnapshot;
                derivedHub.hubDbBroadcaster   = null;
                let derived = new PriceAggregator(derivedHub);

                await oc._persistCapabilitySnapshot(capability, ANCHOR);
                await derived._persistDerivedCapabilitySnapshot(capability, ANCHOR);

                let ocInsert  = consensusDb.queries.find(q => /^INSERT IGNORE INTO capability_snapshots/.test(q.sql));
                let devInsert = derivedDb.queries.find(q => /^INSERT IGNORE INTO capability_snapshots/.test(q.sql));
                expect(ocInsert,  capability + ': consensus path wrote nothing').to.exist;
                expect(devInsert, capability + ': derivation path wrote nothing').to.exist;
                expect(devInsert.sql, capability).to.equal(ocInsert.sql);
                expect(devInsert.args, capability).to.deep.equal(ocInsert.args);
                // And the capability really is the one asked for, not `price` under a label.
                expect(devInsert.args[1], capability).to.equal(capability);
            }
        });

        it('mirrors every capability to hub-DB subscribers under its own name', async function () {
            await agg.runPriceCapabilityDerivation();
            let seen = new Set();
            for (let call of broadcaster.broadcastRow.getCalls()) {
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

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.byCapability.attestation.written).to.equal(0);
            expect(res.byCapability.attestation.failed).to.equal(WINDOW);
            for (let c of ['price', 'oracle_publish', 'cross_chain']) {
                expect(res.byCapability[c].written, c).to.equal(WINDOW);
                expect(res.byCapability[c].failed, c).to.equal(0);
            }
            // The healthy three are covered, the stuck one is not, and it is retried.
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS)).to.equal('valid');
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS, 'attestation'))
                .to.equal('invalid: insufficient signer stake');
            expect(agg._capDerivedBlocks.get('attestation').size).to.equal(0);
        });

        it('names the capability in the once-per-height warning', async function () {
            let warn = sinon.stub(console, 'warn');
            capSnapshot.getWeightSnapshot.callsFake(async (capability) =>
                (capability === 'oracle_publish' ? null : { capability, count: 0, truncated: false, validators: [] }));

            await agg.runPriceCapabilityDerivation();

            let lines = warn.getCalls().map(c => c.args.join(' '));
            expect(lines.some(l => /`oracle_publish` capability snapshot/.test(l))).to.be.true;
            expect(lines.some(l => /`price` capability snapshot/.test(l))).to.be.false;
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

        it('spends no second read on a (capability, height) it already covered, and picks up a new tip', async function () {
            await agg.runPriceCapabilityDerivation();
            expect(capSnapshot.getWeightSnapshot.callCount).to.equal(GRID);

            hub._resolveBtcLatestBlock.resolves(TIP + 1);
            let second = await agg.runPriceCapabilityDerivation();
            // One new height, every capability: nothing already covered is re-read.
            expect(second.written).to.equal(CAPS.length);
            expect(capSnapshot.getWeightSnapshot.callCount).to.equal(GRID + CAPS.length);
            expect(capSnapshot.getWeightSnapshot.getCalls().slice(-CAPS.length)
                .every(c => c.args[1] === TIP + 1)).to.be.true;
            // The window slid, so the height that fell out of it is forgotten rather than
            // accumulated: each capability's covered set is bounded by the lookback.
            for (let c of CAPS)
                expect(agg._capDerivedBlocks.get(c).size, c).to.equal(WINDOW);
        });
    });

    describe('fails closed', function () {

        it('writes NOTHING when the Bitcoin view is unreachable, and says so', async function () {
            let err = sinon.stub(console, 'warn');
            capSnapshot.getWeightSnapshot.resolves(null);   // CapabilitySnapshot's degraded sentinel

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.written).to.equal(0);
            expect(res.failed).to.equal(GRID);
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
            for (let c of CAPS)
                expect(agg._capDerivedBlocks.get(c).size, c).to.equal(0);

            capSnapshot.getWeightSnapshot.callsFake(async (capability, block) => ({
                capability: capability, blockIndex: block, count: SET.length,
                truncated: false, validators: SET.map(v => ({ ...v }))
            }));
            let second = await agg.runPriceCapabilityDerivation();
            expect(second.written).to.equal(GRID);
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
            expect(res.empty).to.equal(GRID);
            expect(res.failed).to.equal(0);
            expect(db.store.size).to.equal(0);
            // Nobody qualified, so an off-BTC verifier reading zero rows reaches the same
            // verdict this hub would: fail closed, not a hole to retry.
            expect(indexerVerdict(db, ANCHOR, THREE_SIGNERS))
                .to.equal('invalid: insufficient signer stake');
        });
    });

    describe('a hub whose consensus path writes every capability is untouched', function () {

        // The validator shape: a signing identity plus every capability's writer. Spelled
        // out rather than imported, for the reason CAPS is.
        function makeValidator(h) {
            h.identity                 = { getPubkeyHex: () => 'aa'.repeat(32) };
            h.oracleConsensus          = { /* price, round finalization */ };
            h.stateCheckpoints         = { /* oracle_publish, archive-head verifier */ };
            h.crossChainCalls          = { /* cross_chain, XCALL dispatch */ };
            h.attestationBatchPublisher = { /* attestation, v5 ATTEST head */ };
        }

        it('writes nothing and disarms itself when all four writers run here', async function () {
            makeValidator(hub);
            agg.startPriceCapabilityDerivation();
            expect(agg._priceCapDeriveTimer).to.not.equal(null);

            let res = await agg.runPriceCapabilityDerivation();

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

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.reason).to.equal('hub runs consensus for every derived capability');
            expect(hub._resolveBtcLatestBlock.called).to.be.false;
        });
    });

    // The gate must ask its question per capability, off the signing identity.
    // Asking ONE question for all four and answering it from the PEER MANAGER lets
    // any hub in the mesh disarm the whole pass, and the mesh is the shape the public
    // tier runs: a peer manager so federation frames arrive, no signing key, so
    // nothing it sees is ever finalized under its key and NOTHING writes
    // oracle_publish, cross_chain or attestation on it.
    describe('a mesh hub that signs nothing derives every capability', function () {

        beforeEach(function () {
            // In the mesh, and holding no signing key: startP2P builds the peer manager
            // unconditionally but mints an identity only from SIGNING_PRIVKEY_HEX.
            hub.getPeerManager = sinon.stub().returns({ validatorAddr: 'ws://validator-1:10001' });
            hub.getIdentity    = sinon.stub().returns(null);
            hub.identity       = null;
        });

        it('runs the pass instead of disarming, with a peer manager present', async function () {
            agg.startPriceCapabilityDerivation();

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.ran).to.be.true;
            expect(res.capabilities).to.deep.equal(CAPS);
            // Still armed: the next pass must keep the window covered as the tip moves.
            expect(agg._priceCapDeriveTimer).to.not.equal(null);
        });

        for (let capability of CAPS) {
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
            let warn = sinon.stub(console, 'warn');

            let res = await agg.runPriceCapabilityDerivation();

            expect(res.failed).to.equal(0);
            expect(warn.getCalls().some(c => /capability snapshot written/.test(c.args.join(' ')))).to.be.false;
        });
    });

    describe('one covered capability disarms nothing', function () {

        // A validator that holds ONE capability's writer: the other three are still
        // uncovered on it, and a single global answer would have skipped all four.
        for (let owned of CAPS) {
            let engine = { price: 'oracleConsensus', oracle_publish: 'stateCheckpoints',
                           cross_chain: 'crossChainCalls', attestation: 'attestationBatchPublisher' }[owned];

            it('skips `' + owned + '` (its writer runs here) and derives the other three', async function () {
                hub.identity = { getPubkeyHex: () => 'aa'.repeat(32) };
                hub[engine]  = { /* the only consensus writer this hub holds */ };

                let res = await agg.runPriceCapabilityDerivation();

                expect(res.ran).to.be.true;
                expect(res.capabilities).to.deep.equal(CAPS.filter(c => c !== owned));
                // The consensus writer's own rows are its business: this pass wrote none.
                expect(indexerReadsWeights(db, owned, ANCHOR)).to.have.lengthOf(0);
                for (let other of CAPS.filter(c => c !== owned))
                    expect(indexerReadsWeights(db, other, ANCHOR)).to.have.lengthOf(SET.length);
                expect(agg._priceCapDeriveTimer).to.equal(null);   // never armed in this test
            });
        }

        it('spends its per-tick budget on the uncovered capabilities only', async function () {
            hub.identity        = { getPubkeyHex: () => 'aa'.repeat(32) };
            hub.oracleConsensus = {};

            let res = await agg.runPriceCapabilityDerivation();

            // The grid is the window times the capabilities STILL uncovered, so a skipped
            // capability frees its share of the budget rather than wasting it.
            expect(res.considered).to.equal(WINDOW * (CAPS.length - 1));
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
