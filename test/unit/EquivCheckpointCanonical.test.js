'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header (WI-2 bump 2): checkpoint engine round-trip and collision-fix.
// CONSENSUS-CRITICAL: the XCHECKPOINT canonical is rebuilt by the hub
// (StateCheckpointEngine / StateAnchorPublisher), the indexer (anchor.js /
// recovery.js), the SDK (checkpoint.js) and the explorer. They MUST produce
// byte-identical bytes at every gate state, and the per-block checkpoint canonical
// and the archive (v1/v6) canonical (which legitimately share checkpoint_seq) MUST
// carry DISTINCT equivocation keys. Otherwise an honest validator that signs both is
// falsely slashable (R-4). A mismatch here forks the chain.
const { expect } = require('chai');
const eq   = require('../../src/equivocation_header.js');
const ckpt = require('../../src/checkpoint_commitment_activation.js');
const SCE  = require('../../src/StateCheckpointEngine.js');
const SAP  = require('../../src/StateAnchorPublisher.js');
// The frozen ANCHOR v7 wire vector, vendored byte-identically from
// xchain-documentation/protocol/test-vectors/anchor_canonical.json and guarded by
// anchor-golden-vectors.test.js. Driving the section parity off these bytes means the
// three canonical builders meet a real bundle, not three transcriptions of one literal.
const GOLDEN = require('../fixtures/anchor_canonical_vectors.json');

// The cross-service parity checks require the sibling SDK and indexer sources,
// which only exist in the monorepo layout. In single-repo CI (hub checked out
// alone) they are absent, so require them optionally and skip the cross-service
// blocks rather than crashing the whole suite.
//
// A bare skip is NOT enough (item 2435). This file is the only place the three
// XCHECKPOINT canonical builders are compared against each other, and the only
// place the v0/v1 distinct-equivocation-key property (R-4) is asserted; the shared
// conformance vectors cover equivocation_header/stake_weighted_quorum and the
// ANCHOR wire bytes, not this gate. A mis-resolved sibling path in the
// required-siblings CI lane (bin/ci-all.sh sets XCHAIN_REQUIRE_SIBLINGS=1) would
// otherwise turn both blocks into permanent pendings on a green run. So there the
// missing sibling is a hard failure, matching ConsensusPrimitiveConformance.test.js
// and the indexer's coins-conformance / anchorRewardActivationParity guards.
let sdkCheckpoint = null, sdkLight = null, Anchor = null, AnchorRecovery = null;
let sdkErr = null, lightErr = null, anchorErr = null, recoveryErr = null;
try { sdkCheckpoint = require('../../../xchain-sdk/src/checkpoint.js'); } catch (e) { sdkErr = e; }
try { sdkLight = require('../../../xchain-sdk/src/light.js'); } catch (e) { lightErr = e; }
try { Anchor = require('../../../xchain-indexer/src/actions/anchor.js'); } catch (e) { anchorErr = e; }
try { AnchorRecovery = require('../../../xchain-indexer/src/recovery.js'); } catch (e) { recoveryErr = e; }
const haveSiblings = Boolean(sdkCheckpoint && sdkLight && Anchor && AnchorRecovery);

// before() hook shared by every sibling-gated block: escalate to a throw when the
// required-siblings lane is active, otherwise skip. Named so the failure message
// says which sibling failed to load and why.
function requireSiblings() {
    if (haveSiblings) return;
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
        const missing = [];
        if (!sdkCheckpoint)  missing.push('xchain-sdk/src/checkpoint.js (' + (sdkErr && sdkErr.message) + ')');
        if (!sdkLight)       missing.push('xchain-sdk/src/light.js (' + (lightErr && lightErr.message) + ')');
        if (!Anchor)         missing.push('xchain-indexer/src/actions/anchor.js (' + (anchorErr && anchorErr.message) + ')');
        if (!AnchorRecovery) missing.push('xchain-indexer/src/recovery.js (' + (recoveryErr && recoveryErr.message) + ')');
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the XCHECKPOINT cross-service parity siblings are unloadable: '
            + missing.join('; '));
    }
    this.skip();
}

// regtest activates at genesis (threshold 0) → gate ON; mainnet is placeholder-
// disabled at a far-future height → gate OFF for any realistic block.
const cpOn  = { chain:'BTC', network:'regtest', block_index:500, block_hash:'bh',
                ledger_hash:'lh', actions_hash:'ah', contract_hash:'ch',
                checkpoint_seq:7, snapshot_block:480 };
const cpOff = Object.assign({}, cpOn, { network:'mainnet', snapshot_block:5 });

const RAW_ON  = 'XCHECKPOINT|BTC|regtest|500|bh|lh|ah|ch|7|480';
const RAW_OFF = 'XCHECKPOINT|BTC|mainnet|500|bh|lh|ah|ch|7|5';

// Minimal indexer Anchor (constructor only assigns; _canonical uses `d` + eq).
const anchor = Anchor ? new Anchor({ config:{}, decoderDb:null, indexerDb:null, util:null, mapper:null }) : null;
// The rootless BASE _canonical builds for any format that adds no extension: it is what
// the archive canonical nests and what the hub's rootless checkpoint canonical must equal.
const dBase = { CHAIN:'BTC', NETWORK:'regtest', BLOCK_INDEX_CHECKPOINTED:500,
              BLOCK_HASH:'bh', LEDGER_HASH:'lh', ACTIONS_HASH:'ah', CONTRACT_HASH:'ch',
              CHECKPOINT_SEQ:7, SNAPSHOT_BLOCK:480 };
const dV1 = Object.assign({}, dBase, { FORMAT:1, MATCH_BATCH_SEQ:3, MATCH_COUNT:10,
              BATCH_CRC32:'cc', TOTAL_CHUNKS:2 });
const RAW_V1 = RAW_ON + '|3|10|cc|2';

// key = the slice between the literal "EQUIV|" and the "||" boundary.
function keyOf(canon){
    expect(canon.startsWith('EQUIV|')).to.equal(true);
    return canon.slice('EQUIV|'.length, canon.indexOf('||'));
}

describe('EQUIV checkpoint canonical (WI-2 bump 2)', function () {

    describe('gate behavior (per-block checkpoint)', function () {
        it('below the flag-day → bare raw bytes (regression-safe)', function () {
            expect(SCE.canonicalCheckpoint(cpOff)).to.equal(RAW_OFF);
        });
        it('at/above the flag-day → header-wrapped (TAG=XCHECKPOINT, per-block round id, VIEW=0)', function () {
            expect(SCE.canonicalCheckpoint(cpOn))
                .to.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|0||' + RAW_ON);
        });
        it('_rawCanonicalCheckpoint is always the bare bytes (used nested by the v1 archive)', function () {
            expect(SCE._rawCanonicalCheckpoint(cpOn)).to.equal(RAW_ON);
        });
    });

    describe('cross-service byte parity', function () {
        before(requireSiblings);

        it('hub == sdk (above gate)', function () {
            expect(sdkCheckpoint.canonicalCheckpoint(cpOn)).to.equal(SCE.canonicalCheckpoint(cpOn));
        });
        it('hub == sdk (below gate)', function () {
            expect(sdkCheckpoint.canonicalCheckpoint(cpOff)).to.equal(SCE.canonicalCheckpoint(cpOff));
        });
        it('hub == indexer anchor._canonical (rootless base, above gate)', function () {
            expect(anchor._canonical(dBase)).to.equal(SCE.canonicalCheckpoint(cpOn));
        });
        it('indexer anchor._canonical rootless base below gate == bare bytes', function () {
            const off = Object.assign({}, dBase, { NETWORK:'mainnet', SNAPSHOT_BLOCK:5 });
            expect(anchor._canonical(off)).to.equal(RAW_OFF);
        });
    });

    // ── ANCHOR v7 SECTION canonical: the rooted shape mainnet signs today ──
    //
    // Every fixture above is ROOTLESS, and the indexer appends the SPV root suffix only
    // on its FORMAT 7 branch, so that branch is dead on both sides of every assertion in
    // the other blocks: the three builders are compared only where all three provably
    // emit the empty suffix, i.e. they agree for the wrong reason, and a one-sided edit
    // to the suffix (field order, the .toLowerCase(), the pipe count, either gate) ships
    // green. The two sides gate that suffix by DIFFERENT rules on purpose (the hub on
    // CHECKPOINT_COMMITMENT AND root presence, StateCheckpointEngine._checkpointRootSuffix;
    // the indexer on the wire VERSION being 7, anchor.js), which makes their equivalence
    // on a REAL v7 section exactly the property that needs asserting. Spec D41 records
    // that the difference is safe only because a v7 section is root-bearing by
    // construction: the engine computes roots at/above the same flag-day and the
    // publisher skips a null-root row (D8), so no v7 section below the
    // CHECKPOINT_COMMITMENT height can exist. The frozen-vector case below asserts that
    // invariant rather than resting on it.
    //
    // A section drops its own NETWORK on the wire, so the canonical the indexer rebuilds
    // takes the BUNDLE HEADER's network and the section's own SECTION_SNAPSHOT_BLOCK
    // (spec 2.1). CHECKPOINT_COMMITMENT and the EQUIV header both arm mainnet at 961000,
    // so a high-snapshot mainnet section is simultaneously rooted and header-wrapped; the
    // hub is the producer of the bytes validators sign and the indexer is their on-chain
    // verifier, and those are the two copies nothing else pins on this shape (the SDK,
    // sync and explorer copies are each pinned elsewhere).
    describe('ANCHOR v7 section canonical: hub == sdk == indexer', function () {
        before(requireSiblings);

        const SR = 'd4'.repeat(32), BMR = 'e5'.repeat(32);
        const cpRootsOn   = Object.assign({}, cpOn, {
            state_root: SR, state_root_version: 1,
            block_merkle_root: BMR, block_merkle_version: 1 });
        const cpRootsMain = Object.assign({}, cpRootsOn, { network:'mainnet', snapshot_block:961000 });

        // ONE fixture, projected into the indexer's field naming, so a transcription
        // slip cannot make the two sides agree for the wrong reason. `headerNetwork`
        // is the bundle header's NETWORK, which _parseBundle stamps onto every section
        // before handing it to _canonical; SNAPSHOT_BLOCK is the section's own block,
        // never the bundle MAX, because that is what the signatures were made over.
        function indexerSection(cp, headerNetwork) {
            return anchor._canonical({
                FORMAT: 7, CHAIN: cp.chain, NETWORK: headerNetwork || cp.network,
                BLOCK_INDEX_CHECKPOINTED: cp.block_index, BLOCK_HASH: cp.block_hash,
                LEDGER_HASH: cp.ledger_hash, ACTIONS_HASH: cp.actions_hash,
                CONTRACT_HASH: cp.contract_hash, CHECKPOINT_SEQ: cp.checkpoint_seq,
                SNAPSHOT_BLOCK: cp.snapshot_block,
                STATE_ROOT: cp.state_root, STATE_ROOT_VERSION: cp.state_root_version,
                BLOCK_MERKLE_ROOT: cp.block_merkle_root, BLOCK_MERKLE_VERSION: cp.block_merkle_version
            });
        }

        it('regtest, roots present: hub == sdk == indexer(v7 section)', function () {
            const hub = SCE.canonicalCheckpoint(cpRootsOn);
            expect(sdkCheckpoint.canonicalCheckpoint(cpRootsOn), 'SDK checkpoint.js drifted from the hub root suffix')
                .to.equal(hub);
            expect(indexerSection(cpRootsOn), 'indexer Anchor._canonical(FORMAT=7) drifted from the hub root suffix')
                .to.equal(hub);
            // Pinned literal reconstructed from the spec parts, not read off a builder, so
            // a THREE-sided edit still fails (the same reason the v1/v6 block below gives).
            // Same construction as xchain-sync/test/unit/checkpoint.twin.test.js.
            expect(hub).to.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|0||' + RAW_ON +
                '|' + SR + '|1|' + BMR + '|1');
        });

        it('mainnet at/above 961000: rooted AND header-wrapped, all three agree', function () {
            const hub = SCE.canonicalCheckpoint(cpRootsMain);
            expect(sdkCheckpoint.canonicalCheckpoint(cpRootsMain)).to.equal(hub);
            expect(indexerSection(cpRootsMain)).to.equal(hub);
            expect(hub).to.equal('EQUIV|XCHECKPOINT|BTC|mainnet|500|7|0||' +
                'XCHECKPOINT|BTC|mainnet|500|bh|lh|ah|ch|7|961000|' + SR + '|1|' + BMR + '|1');
        });

        it('binds the root field ORDER identically in all three (a root swap diverges everywhere)', function () {
            // Without this, swapping state_root and block_merkle_root on ONE side would
            // still satisfy the equalities above for any fixture whose two roots matched.
            const swapped = Object.assign({}, cpRootsOn, { state_root: BMR, block_merkle_root: SR });
            const hub = SCE.canonicalCheckpoint(swapped);
            expect(hub).to.not.equal(SCE.canonicalCheckpoint(cpRootsOn));
            expect(sdkCheckpoint.canonicalCheckpoint(swapped)).to.equal(hub);
            expect(indexerSection(swapped)).to.equal(hub);
        });

        it('every section of the frozen v7 vector: hub == sdk == indexer, through the SDK parser', function () {
            // The three literal-driven cases above bind the builders to a hand-written
            // fixture. This one binds them to the bytes the protocol froze: the SDK's own
            // entry points (parseAnchorV7 + anchorBundleSection) turn the wire into the
            // section shape a light client verifies, and that shape must produce the same
            // canonical as the hub producer and the indexer verifier for every chain.
            const bundle = GOLDEN.fixture.bundle;
            const parsed = sdkLight.parseAnchorV7(GOLDEN.vectors.v7);
            expect(parsed.network).to.equal(bundle.network);
            expect(parsed.sections.length).to.equal(bundle.sections.length);
            for (const src of bundle.sections) {
                const sec = sdkLight.anchorBundleSection(parsed, src.chain);
                expect(sec, 'the frozen bundle carries no section for ' + src.chain).to.not.equal(null);
                // A parsed section already carries the header network, so the same object
                // drives all three builders with no per-service transcription.
                expect(sec.network).to.equal(parsed.network);
                expect(sec.snapshot_block).to.equal(src.snapshot_block);
                // D41's invariant, asserted rather than assumed: the section's own block is
                // at/above CHECKPOINT_COMMITMENT for the header network, which is the only
                // reason the hub's presence-and-flag-day gate and the indexer's
                // unconditional v7 suffix can agree.
                expect(ckpt.isCheckpointCommitmentActive(sec.snapshot_block, parsed.network),
                    src.chain + ' section sits below CHECKPOINT_COMMITMENT, which no v7 section may do')
                    .to.equal(true);
                const hub = SCE.canonicalCheckpoint(sec);
                expect(sdkCheckpoint.canonicalCheckpoint(sec),
                    'SDK checkpoint.js drifted from the hub on the frozen ' + src.chain + ' section').to.equal(hub);
                expect(indexerSection(sec, parsed.network),
                    'indexer Anchor._canonical(FORMAT=7) drifted from the hub on the frozen ' + src.chain + ' section')
                    .to.equal(hub);
                // The suffix is genuinely in the signed bytes, so the equalities above are
                // not three builders agreeing on an empty tail.
                expect(hub.endsWith('|' + src.state_root + '|' + src.state_root_version +
                    '|' + src.block_merkle_root + '|' + src.block_merkle_version)).to.equal(true);
            }
        });

        it('a null-root row keeps the rootless canonical on both sides (the base the archive leg nests)', function () {
            // The complement, and the reason the two gates may legitimately differ: the hub
            // withholds the suffix when a root is absent, and the indexer's shared base (the
            // string the v1/v6 archive canonical nests) carries no suffix whatever the
            // flag-day says, so signatures over rootless rows still verify.
            expect(SCE.canonicalCheckpoint(cpOn)).to.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|0||' + RAW_ON);
            expect(sdkCheckpoint.canonicalCheckpoint(cpOn)).to.equal(SCE.canonicalCheckpoint(cpOn));
            expect(anchor._canonical(dBase)).to.equal(SCE.canonicalCheckpoint(cpOn));
        });
    });

    describe('checkpoint/archive equivocation-key split (R-4)', function () {
        before(requireSiblings);

        it('v1 archive canonical is header-wrapped with batch_seq in the round id', function () {
            expect(anchor._canonical(dV1))
                .to.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|3|0||' + RAW_V1);
        });
        it('the checkpoint and archive canonicals carry DISTINCT equivocation keys (no false-slash)', function () {
            const k0 = keyOf(SCE.canonicalCheckpoint(cpOn));   // ...|7|0
            const k1 = keyOf(anchor._canonical(dV1));          // ...|7|3|0
            expect(k0).to.equal('XCHECKPOINT|BTC|regtest|500|7|0');
            expect(k1).to.equal('XCHECKPOINT|BTC|regtest|500|7|3|0');
            expect(k0).to.not.equal(k1);
        });
    });

    // ── v1/v6 archive canonical: three-way byte parity (item 2461) ───────────
    //
    // The archive extension is an independent three-way agreement, and until now
    // nothing executed all three producers against one fixture:
    //   producer  xchain-hub      StateAnchorPublisher._archiveCanonical
    //   verifier  xchain-indexer  Anchor._canonical, FORMAT 1|6
    //   recovery  xchain-indexer  AnchorRecovery._wrapperCanonical
    // Every existing test is self-referential: the hub verifies its own published
    // sigs with its own builder, the indexer fixture (anchor-archive.js) signs with
    // a FOURTH inline reimplementation, and the golden vector covers the v7 bundle
    // only. A one-sided edit to the batch segment (field order, the crc position, or
    // the `|batch_seq` ROUND_ID suffix) therefore ships with every suite green and
    // forks archive verification: recovery.js:229 throws 'wrapper signatures fail
    // quorum' and the full-parse recoverability guarantee is silently broken while
    // the base checkpoint string still agrees.
    //
    // These cases call the three REAL implementations. All three methods are pure
    // string builders over their argument plus module-level helpers, so they are
    // invoked off the prototype with a null receiver: no hub, indexer, DB or
    // identity is constructed, and nothing about the unit under test is stubbed.
    describe('v1/v6 archive canonical: hub == indexer anchor == recovery', function () {
        before(requireSiblings);

        // ONE fixture, projected into each service's own field naming, so a
        // transcription slip cannot make the three agree for the wrong reason.
        const ARCHIVE = { batch_seq: 3, count: 10, crc: 'cc', total_chunks: 2 };

        function hubCanonical(cp) {
            return SAP.prototype._archiveCanonical.call(null, cp, ARCHIVE.batch_seq,
                ARCHIVE.count, ARCHIVE.crc, ARCHIVE.total_chunks);
        }
        function indexerCanonical(cp, format) {
            return Anchor.prototype._canonical.call(null, {
                FORMAT: format, CHAIN: cp.chain, NETWORK: cp.network,
                BLOCK_INDEX_CHECKPOINTED: cp.block_index, BLOCK_HASH: cp.block_hash,
                LEDGER_HASH: cp.ledger_hash, ACTIONS_HASH: cp.actions_hash,
                CONTRACT_HASH: cp.contract_hash, CHECKPOINT_SEQ: cp.checkpoint_seq,
                SNAPSHOT_BLOCK: cp.snapshot_block,
                MATCH_BATCH_SEQ: ARCHIVE.batch_seq, MATCH_COUNT: ARCHIVE.count,
                BATCH_CRC32: ARCHIVE.crc, TOTAL_CHUNKS: ARCHIVE.total_chunks
            });
        }
        function recoveryCanonical(cp) {
            return AnchorRecovery.prototype._wrapperCanonical.call(null, {
                chain: cp.chain, network: cp.network, block_index: cp.block_index,
                block_hash: cp.block_hash, ledger_hash: cp.ledger_hash,
                actions_hash: cp.actions_hash, contract_hash: cp.contract_hash,
                checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block,
                match_batch_seq: ARCHIVE.batch_seq, match_count: ARCHIVE.count,
                batch_crc32: ARCHIVE.crc, total_chunks: ARCHIVE.total_chunks
            });
        }

        // Above the flag day the header wrapper and the `|batch_seq` ROUND_ID suffix
        // are both in play, so this is the case that pins the suffix across all three.
        it('above the EQUIV flag day: all three produce identical bytes (v1)', function () {
            const hub = hubCanonical(cpOn);
            expect(indexerCanonical(cpOn, 1)).to.equal(hub, 'indexer Anchor._canonical(FORMAT=1) drifted from hub _archiveCanonical');
            expect(recoveryCanonical(cpOn)).to.equal(hub, 'recovery._wrapperCanonical drifted from hub _archiveCanonical');
            // Pinned literal so a THREE-sided edit (all copies changed together) still fails.
            expect(hub).to.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|3|0||' + RAW_V1);
        });

        // v6 is the publisher-bearing archive; its wrapper sigs are produced over the
        // UNCHANGED v1 archive canonical (the publisher tail is attested separately).
        it('above the EQUIV flag day: v6 canonical is byte-identical to v1', function () {
            expect(indexerCanonical(cpOn, 6)).to.equal(indexerCanonical(cpOn, 1));
            expect(indexerCanonical(cpOn, 6)).to.equal(hubCanonical(cpOn));
        });

        // Below the flag day the bytes are bare and the ROUND_ID suffix is absent, so
        // this branch exercises code the regtest-only archive suites never reach.
        it('below the EQUIV flag day: all three produce identical bare bytes (v1 and v6)', function () {
            const hub = hubCanonical(cpOff);
            expect(hub).to.equal(RAW_OFF + '|3|10|cc|2');
            expect(indexerCanonical(cpOff, 1)).to.equal(hub);
            expect(indexerCanonical(cpOff, 6)).to.equal(hub);
            expect(recoveryCanonical(cpOff)).to.equal(hub);
        });

        // Field ORDER, not just field presence: a swap inside the batch segment keeps
        // the same characters and would slip past a set-equality style check.
        it('binds the archive field ORDER identically in all three (crc/count swap diverges)', function () {
            const swapped = Object.assign({}, ARCHIVE);
            const orig    = { count: ARCHIVE.count, crc: ARCHIVE.crc };
            ARCHIVE.count = orig.crc; ARCHIVE.crc = orig.count;
            try {
                const hub = hubCanonical(cpOn);
                expect(hub).to.not.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|3|0||' + RAW_V1);
                expect(indexerCanonical(cpOn, 1)).to.equal(hub);
                expect(recoveryCanonical(cpOn)).to.equal(hub);
            } finally {
                ARCHIVE.count = swapped.count; ARCHIVE.crc = swapped.crc;
            }
        });

        // The archive round id must carry batch_seq in all three, or two archive
        // batches of the same checkpoint collide into one equivocation key.
        it('all three derive the same equivocation key, and it includes batch_seq', function () {
            const k = keyOf(hubCanonical(cpOn));
            expect(k).to.equal('XCHECKPOINT|BTC|regtest|500|7|3|0');
            expect(keyOf(indexerCanonical(cpOn, 1))).to.equal(k);
            expect(keyOf(recoveryCanonical(cpOn))).to.equal(k);
            // A different batch_seq must yield a DIFFERENT key in all three.
            const prev = ARCHIVE.batch_seq;
            ARCHIVE.batch_seq = 4;
            try {
                expect(keyOf(hubCanonical(cpOn))).to.not.equal(k);
                expect(keyOf(indexerCanonical(cpOn, 1))).to.equal(keyOf(hubCanonical(cpOn)));
                expect(keyOf(recoveryCanonical(cpOn))).to.equal(keyOf(hubCanonical(cpOn)));
            } finally { ARCHIVE.batch_seq = prev; }
        });
    });
});
