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

// : pins the DERIVATION behind the ANCHOR sizing/timing constants, so the
// prose in StateAnchorPublisher's constructor, xchain-hub/CONFIGURATION.md and
// protocol/actions/ANCHOR.md ("Where the publisher constants come from") cannot
// drift away from the values. None of these knobs is consensus data, but two of
// them sit under a hard on-chain ceiling and one encodes a timing ORDER; a
// retune that breaks a bound should fail here rather than on-chain, where an
// oversize anchor is dropped silently by every decoder.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

// LOCAL COPY of the canonical ceiling in xchain-documentation/protocol/
// constants.js (MAX_ACTION_DATA_LENGTH). The decoder is the arbiter: it drops a
// transaction whose compiled ACTION push exceeds this, so the hub must keep its
// largest anchor under it.
const MAX_ACTION_DATA_LENGTH = 8192;

// Bytes one (PUBKEY, SIG) pair adds to a payload: 64-hex pubkey + 128-hex
// Ed25519 signature + the two '|' delimiters.
const SIG_PAIR_BYTES = 64 + 128 + 2;

const ENV_KEYS = ['ANCHOR_CHUNK_MAX_BYTES', 'ANCHOR_MATCH_BATCH_SIZE', 'ANCHOR_MAX_BATCH',
    'ANCHOR_ELECTION_TOLERANCE_BLOCKS', 'ANCHOR_INTERVAL_MS', 'ANCHOR_ROUND_TIMEOUT_MS'];

function mkPub(){
    return new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } });
}

function hex(n){ return 'a'.repeat(n); }

// The v1/v6 archive head exactly as _publishArchive assembles it (same field
// order as the indexer parser, anchor.js formats[1]/formats[6]). Mirrored rather
// than called because the real builder is inline in a DB-bound publish path;
// the field list is the contract this test measures against.
function archiveHead(version, chunk0Len, wrapperSigs, attestSigs){
    let parts = ['ANCHOR', String(version), 'BTC', 'mainnet', '962500',
        hex(64), hex(64), hex(64), hex(64),      // block/ledger/actions/contract hashes
        '4171', '962500',                        // checkpoint_seq, snapshot_block
        '42', '1000', '1a2b3c4d', '93',          // batch_seq, match_count, crc32, total_chunks
        'A'.repeat(chunk0Len), String(wrapperSigs)];
    for(let i = 0; i < wrapperSigs; i++) parts.push(hex(64), hex(128));
    if(version === 6){
        parts.push(hex(64), String(attestSigs));
        for(let i = 0; i < attestSigs; i++) parts.push(hex(64), hex(128));
    }
    return parts.join('|');
}

describe('StateAnchorPublisher : ANCHOR constant derivations', function () {

    let saved;
    before(function () {
        saved = {};
        for(const k of ENV_KEYS){ saved[k] = process.env[k]; delete process.env[k]; }
    });
    after(function () {
        for(const k of ENV_KEYS){
            if(saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('carries the documented defaults', function () {
        const pub = mkPub();
        expect(pub.chunkMaxBytes).to.equal(6000);
        expect(pub.batchSize).to.equal(200);
        expect(pub.maxBatch).to.equal(1000);
        expect(pub.electionToleranceBlocks).to.equal(36);
        expect(pub.intervalMs).to.equal(86400000);
        expect(pub.roundTimeoutMs).to.equal(120000);
    });

    describe('ANCHOR_CHUNK_MAX_BYTES: head room under MAX_ACTION_DATA_LENGTH', function () {

        it('the v1/v6 fixed prefix costs about 322 bytes', function () {
            // Chunk 0 shares its action with the checkpoint prefix; that prefix is
            // the ~322 B the derivation note subtracts before counting signatures.
            const prefix = archiveHead(1, 0, 0, 0).length;
            expect(prefix).to.be.within(300, 340);
        });

        it('leaves room for about nine signature pairs on a v1', function () {
            const pub    = mkPub();
            const budget = MAX_ACTION_DATA_LENGTH - pub.chunkMaxBytes - archiveHead(1, 0, 0, 0).length;
            expect(Math.floor(budget / SIG_PAIR_BYTES)).to.equal(9);
            expect(archiveHead(1, pub.chunkMaxBytes, 9, 0).length).to.be.at.most(MAX_ACTION_DATA_LENGTH);
            expect(archiveHead(1, pub.chunkMaxBytes, 10, 0).length).to.be.above(MAX_ACTION_DATA_LENGTH);
        });

        it('leaves room for a 4+4 v6 quorum, and no more (the grow-the-federation cliff)', function () {
            const pub = mkPub();
            expect(archiveHead(6, pub.chunkMaxBytes, 4, 4).length).to.be.at.most(MAX_ACTION_DATA_LENGTH);
            expect(archiveHead(6, pub.chunkMaxBytes, 5, 5).length).to.be.above(MAX_ACTION_DATA_LENGTH);
        });

        it('pins the lowered chunk sizes a 5+5 and a 7+7 v6 federation would need', function () {
            // The tuner rule in the derivation note: shrink chunk 0 by exactly the
            // overflow, so the documented ~5860 / ~5080 stay honest.
            for(const [quorum, documented] of [[5, 5860], [7, 5080]]){
                const over = archiveHead(6, 6000, quorum, quorum).length - MAX_ACTION_DATA_LENGTH;
                const fits = 6000 - over;
                expect(fits).to.be.at.least(documented);          // the doc figure is never too generous
                expect(fits - documented).to.be.below(60);        // and is not needlessly pessimistic
                expect(archiveHead(6, fits, quorum, quorum).length).to.equal(MAX_ACTION_DATA_LENGTH);
            }
        });

        it('splits the payload at exactly chunkMaxBytes, so chunk 0 is the binding case', function () {
            const pub    = mkPub();
            const chunks = pub._splitChunks('B'.repeat(pub.chunkMaxBytes * 2 + 17));
            expect(chunks.length).to.equal(3);
            expect(chunks[0].length).to.equal(pub.chunkMaxBytes);
            expect(chunks[1].length).to.equal(pub.chunkMaxBytes);
            expect(chunks[2].length).to.equal(17);
        });
    });

    describe('ANCHOR_ELECTION_TOLERANCE_BLOCKS: the failover ladder ordering', function () {

        const BTC_BLOCK_MS   = 10 * 60 * 1000;         // BTC target spacing
        const DOGE_BURIAL_MS = 60 * 60 * 1000;         // 60 DOGE confirmations at ~1 min

        it('unlocks one rank per tolerance window and no sooner', function () {
            const pub   = mkPub();
            const order = ['aa', 'bb', 'cc', 'dd'];
            expect(pub._rankUnlocked(order, 'aa', 0)).to.equal(true);            // rank 0 always
            expect(pub._rankUnlocked(order, 'bb', 35)).to.equal(false);
            expect(pub._rankUnlocked(order, 'bb', 36)).to.equal(true);
            expect(pub._rankUnlocked(order, 'cc', 71)).to.equal(false);
            expect(pub._rankUnlocked(order, 'cc', 72)).to.equal(true);
            expect(pub._rankUnlocked(order, 'dd', 108)).to.equal(true);
        });

        it('sits above the leader publish latency it must not pre-empt', function () {
            const pub         = mkPub();
            const toleranceMs = pub.electionToleranceBlocks * BTC_BLOCK_MS;
            expect(toleranceMs).to.be.above(pub.roundTimeoutMs + DOGE_BURIAL_MS);
            // "much larger", not merely larger: a slow-but-healthy leader is never
            // overtaken, so the federation does not pay DOGE twice for one checkpoint.
            expect(toleranceMs).to.be.at.least(4 * (pub.roundTimeoutMs + DOGE_BURIAL_MS));
        });

        it('still gives ranks 1-3 a slot inside one publishing cycle', function () {
            const pub         = mkPub();
            const toleranceMs = pub.electionToleranceBlocks * BTC_BLOCK_MS;
            expect(3 * toleranceMs).to.be.at.most(pub.intervalMs);
            // and the whole ladder is short enough that a dead rank 0 cannot cost a
            // full anchor interval.
            expect(toleranceMs).to.be.below(pub.intervalMs);
        });
    });

    describe('ANCHOR_MAX_BATCH: the per-cycle DOGE spend bound', function () {

        it('bounds one archive to roughly a hundred DOGE transactions', function () {
            const pub = mkPub();
            // Archived rows are dominated by validator signatures and do not
            // compress; the derivation note measures ~0.55 KB of gzip+base64 per
            // settled match. That is what turns maxBatch into a spend bound.
            const B64_PER_ROW = 550;
            const chunks      = Math.ceil((pub.maxBatch * B64_PER_ROW) / pub.chunkMaxBytes);
            expect(chunks).to.be.within(80, 110);
            const earlyFlush = Math.ceil((pub.batchSize * B64_PER_ROW) / pub.chunkMaxBytes);
            expect(earlyFlush).to.be.within(15, 25);
            // The early-flush trigger is a latency knob under the hard cap, never above it.
            expect(pub.batchSize).to.be.below(pub.maxBatch);
        });
    });
});
