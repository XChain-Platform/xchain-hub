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
// StateAnchorPublisher: ANCHOR v0/v1/batch payload construction, the archive
// signing round (followers co-sign only archives matching their own DB),
// chunking round-trips, re-archival of retracted matches, and back-fill via
// XANC_FINALIZED. Mesh harness mirrors StateCheckpointEngine.test.js.
//
// This file keeps the v0 wire shape (field order and the frozen producer-side
// vectors) and the single-node publish flow (the v0 + v1 round trip, a null
// archive txid, the checkpoint-ordinal cadence); every other family of the
// suite is a state_anchor_publisher_* sibling beside this file.
// The mesh harness lives in test/helpers/anchor_mesh.js.

const { expect }            = require('chai');
const zlib                  = require('zlib');
const StateAnchorPublisher  = require('../../../../src/anchor/publisher');
const ValidatorIdentity     = require('../../../../src/validators/identity');
const { waitUntil }         = require('../../../helpers/waitUntil');
const { CP_ROW, parseV7Sections, buildMesh, startAll, registerMeshHooks } = require('../../../helpers/anchor_mesh.js');

describe('StateAnchorPublisher', function () {
    registerMeshHooks();

    registerBundleWireCases();
    registerFrozenWireVectors();
    registerArchiveTxidCases();
    registerCadenceCases();
});

// The v0 field order by hand, then the single-node v0 + v1 round trip.
function registerBundleWireCases() {
    it('v0 bundle payload matches the ANCHOR spec field order', function () {
        let bus = buildMesh(1);
        let row = Object.assign({}, CP_ROW, { validator_signatures: '[{"pubkey":"pk1","sig":"sg1"}]' });
        let payload = bus.nodes[0].pub._buildV7Payload([row], 'pub1', [{ pubkey: 'ap1', sig: 'as1' }]);
        expect(payload).to.equal(['ANCHOR', '0', 'regtest', '100', '1',
            'BTC', '494', CP_ROW.block_hash, CP_ROW.ledger_hash, CP_ROW.actions_hash, CP_ROW.contract_hash,
            '7', '100', CP_ROW.state_root, '1', CP_ROW.block_merkle_root, '1',
            '1', 'pk1', 'sg1',
            'pub1', '1', 'ap1', 'as1'].join('|'));
    });

    it('single-node: flush publishes v0 + v1, archive round-trips, batch back-filled', async function () {
        // Count-path archive mechanics: a mainnet record below the 961000 SWQ activation
        // takes the legacy count snapshot the getSnapshot stub serves (weighted has its own suite).
        let bus = buildMesh(1, { network: 'mainnet' });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.length >= 2, { label: 'the v0 bundle and v1 archive to both be broadcast' });

        expect(nd.published.length).to.equal(2);                       // v0 bundle + v1 archive
        let v7 = nd.published[0].split('|');
        expect(v7[1]).to.equal('0');
        expect(nd.db.checkpoints[0].anchor_txid).to.equal('txid1');

        let v1 = nd.published[1].split('|');
        expect(v1[1]).to.equal('1');
        expect(v1[11]).to.equal('0');                                  // MATCH_BATCH_SEQ
        expect(v1[12]).to.equal('1');                                  // MATCH_COUNT
        expect(v1[14]).to.equal('1');                                  // TOTAL_CHUNKS
        let json = zlib.gunzipSync(Buffer.from(v1[15], 'base64url')).toString('utf8');
        expect(nd.pub.crc32Hex(json)).to.equal(v1[13]);               // BATCH_CRC32 binds the blob
        let archive = JSON.parse(json);
        expect(archive.matches.length).to.equal(1);
        expect(archive.matches[0].match_id).to.equal('m1');
        expect(archive.matches[0].b_tick).to.equal(null);
        // Resolved via capabilitySnapshot (1 mesh validator) for BOTH capabilities:
        // cross_chain at the match's snapshot_block + oracle_publish at the wrapper's.
        expect(archive.capability_snapshots.length).to.equal(2);
        expect(archive.capability_snapshots.some(s => s.capability === 'cross_chain')).to.equal(true);
        expect(archive.capability_snapshots.some(s => s.capability === 'oracle_publish')).to.equal(true);

        // The v1 signature verifies over the extended canonical.
        let sigCount = Number(v1[16]);
        expect(sigCount).to.equal(1);
        let canonical = nd.pub.archiveCanonical(nd.pub.cpFromRow(nd.db.checkpoints[0]), 0, 1, v1[13], 1);
        expect(ValidatorIdentity.verify(canonical, v1[18], v1[17])).to.be.true;

        expect(nd.db.matches[0].batch_seq).to.equal(0);
        expect(nd.db.matches[0].archived_status).to.equal('finalized');
    });
}

// Frozen wire-byte golden vectors: the PRODUCER half of the hub<->indexer ANCHOR
// byte-identity contract. The field-order test above hand-asserts one shape; this
// pins the full v0 wire bytes against a vendored fixture that the indexer parser
// asserts the OTHER half of (xchain-indexer test/unit/actions/anchor_golden_vectors.test.js,
// same anchor_canonical_vectors.json). A field reorder in either repo breaks its own
// side against the shared frozen string. The builder is invoked via the prototype
// with a _parseSigs stub so this needs no mesh/DB.
// See protocol/test-vectors/anchor_canonical.json.
function registerFrozenWireVectors() {
    describe('frozen ANCHOR canonical wire vectors (hub producer side)', function () {
        const GOLDEN = require('../../../fixtures/anchor_canonical_vectors.json');
        const stub = { _parseSigs: StateAnchorPublisher.prototype._parseSigs };
        // The builder reads validator_signatures as a JSON string off each row.
        const sections = GOLDEN.fixture.bundle.sections.map(sec =>
            Object.assign({}, sec, { validator_signatures: JSON.stringify(sec.validator_signatures) }));
        const pub = GOLDEN.fixture.bundle.publisher;
        const att = GOLDEN.fixture.bundle.attest_sigs;
        const build = (secs) => StateAnchorPublisher.prototype._buildV7Payload.call(stub, secs, pub, att);

        it('v0 builder reproduces the frozen vector byte-for-byte', function () {
            expect(build(sections)).to.equal(GOLDEN.vectors.v0);
        });

        // The fixture lists its sections LTC, BTC, DOGE and one signature list b,a on
        // purpose. Echoing fixture order would pass the byte test only by accident, so
        // these two assert the rules themselves: without the outer sort the section
        // order follows input, without the inner sort a failover race emits different
        // bytes for identical state and the attestation byte-match stops being
        // deterministic (D5).
        it('orders sections by CHAIN ascending regardless of input order', function () {
            expect(GOLDEN.fixture.bundle.sections.map(x => x.chain), 'the fixture really is out of order')
                .to.deep.equal(['LTC', 'BTC', 'DOGE']);
            expect(parseV7Sections(build(sections)).map(x => x.chain)).to.deep.equal(['BTC', 'DOGE', 'LTC']);
            // Reversing the input cannot change one byte.
            expect(build(sections.slice().reverse())).to.equal(GOLDEN.vectors.v0);
        });

        it('orders (PUBKEY, SIG) pairs by PUBKEY ascending within every section', function () {
            let btcIn = GOLDEN.fixture.bundle.sections.find(x => x.chain === 'BTC');
            expect(btcIn.validator_signatures.map(x => x.pubkey), 'the fixture BTC section really is out of order')
                .to.deep.equal(['bb'.repeat(32), 'aa'.repeat(32)]);
            for (let sec of parseV7Sections(build(sections))) {
                let keys = sec.sigs.map(x => x.pubkey);
                expect(keys, 'section ' + sec.chain).to.deep.equal(keys.slice().sort());
            }
        });

        it('takes SNAPSHOT_BLOCK as the MAX over the sections, not the first section', function () {
            let lagging = sections.map(sec => sec.chain === 'LTC'
                ? Object.assign({}, sec, { snapshot_block: 94 })   // a chain riding at an older block (D6)
                : sec);
            let f = build(lagging).split('|');
            expect(f[3], 'header block is the MAX').to.equal('100');
            expect(parseV7Sections(build(lagging)).find(x => x.chain === 'LTC').snapshot_block,
                'the lagging section keeps its own block').to.equal(94);
        });
    });
}

// A null archive txid keeps the rows pending and records no reward.
function registerArchiveTxidCases() {
    it('archive v1 broadcast returning a null txid keeps rows pending and records no reward', async function () {
        // Mirrors the v0 null-txid guard for the archive path: a false/incomplete
        // broadcast success ({ txid: null }) must NOT dequeue the rows with their final
        // status (which would strand them in an unrecoverable hole) and must NOT credit
        // the anchor_archive reward for an anchor that never landed on-chain.
        let bus = buildMesh(1, { network: 'mainnet' });   // count-path archive mechanics (SWQ off below 961000)
        let nd = bus.nodes[0];
        // The v0 bundle still gets a txid; only the v1 archive broadcast returns none.
        nd.pub.setBroadcastHook(async (payload) => {
            nd.published.push(payload);
            let isArchiveV1 = payload.split('|')[1] === '1';
            return { txid: isArchiveV1 ? null : ('txid' + nd.published.length) };
        });
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.published.length >= 2, { label: 'the v0 bundle and the txid-less v1 archive to both be attempted' });

        expect(nd.published.length).to.equal(2);                       // v0 + v1 both attempted
        expect(nd.published[1].split('|')[1]).to.equal('1');           // the archive v1
        // Row stays eligible: archived_status is the __partial__ sentinel (!= status),
        // so the next flush re-archives it under a fresh batch seq rather than leaving a hole.
        expect(nd.db.matches[0].archived_status).to.equal('__partial__');
        expect(nd.db.matches[0].archived_status).to.not.equal(nd.db.matches[0].status);
        // No phantom reward for an archive that never reached the chain.
        expect(nd.rewards.filter(r => r.type === 'anchor_archive').length).to.equal(0);
    });
}

// ANCHOR_CHECKPOINT_EVERY_N is applied to the checkpoint ORDINAL.
function registerCadenceCases() {
    it('ANCHOR_CHECKPOINT_EVERY_N sub-samples by checkpoint ORDINAL, so an odd-seeded cadence still anchors (#6127)', async function () {
        // Decouple on-chain anchoring from checkpoint production. checkpoint_seq is
        // the round's BTC snapshot_block and the cadence latch advances it by exactly
        // CHECKPOINT_INTERVAL_BLOCKS (6), so a `seq % 2` predicate is a residue class
        // pinned by the seed, not a 1-in-2 sample: seeded odd, as here, EVERY round is
        // ineligible and the federation anchors nothing, forever, with no row for the
        // stand-down log to mention. Eligibility is therefore FLOOR(seq / 6) % N.
        // Seeds (step 6, odd): 970001 already anchored, 970007 (ordinal 161667, odd ->
        // skipped), 970013 (ordinal 161668, even -> the latest eligible un-anchored).
        let bus = buildMesh(1, {
            cfg: { ANCHOR_CHECKPOINT_EVERY_N: '2' },
            mutate: (self, db) => {
                db.checkpoints.length = 0;
                db.checkpoints.push(Object.assign({}, CP_ROW, { id: 1, block_index: 493, checkpoint_seq: 970001, anchor_txid: 'old' }));
                db.checkpoints.push(Object.assign({}, CP_ROW, { id: 2, block_index: 494, checkpoint_seq: 970007, anchor_txid: null }));
                db.checkpoints.push(Object.assign({}, CP_ROW, { id: 3, block_index: 495, checkpoint_seq: 970013, anchor_txid: null }));
            }
        });
        let nd = bus.nodes[0];
        await startAll(bus);
        await nd.pub.flush();
        await waitUntil(() => nd.db.checkpoints.some(r => r.checkpoint_seq === 970013 && r.anchor_txid), { label: 'the latest eligible ordinal to be anchored' });

        let bundles = nd.published.filter(p => p.split('|')[1] === '0');
        expect(bundles.length, 'exactly one v0 bundle').to.equal(1);
        let secs = parseV7Sections(bundles[0]);
        expect(secs.length, 'one section: only the latest eligible ordinal is eligible').to.equal(1);
        expect(secs[0].block_index, 'block_index of anchored row').to.equal(495);   // seq 970013
        expect(secs[0].checkpoint_seq, 'checkpoint_seq anchored').to.equal(970013);

        let bySeq = s => nd.db.checkpoints.find(r => r.checkpoint_seq === s);
        expect(bySeq(970013).anchor_txid, 'the eligible ordinal anchored on-chain').to.be.a('string');
        expect(bySeq(970007).anchor_txid, 'the skipped ordinal stays off-chain').to.equal(null);
        expect(bySeq(970001).anchor_txid, 'the already-anchored round untouched').to.equal('old');
    });
}
