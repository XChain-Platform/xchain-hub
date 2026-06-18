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
// byte-identical bytes at every gate state, and the v0 (per-block) and v1
// (archive) canonicals (which legitimately share checkpoint_seq) MUST carry
// DISTINCT equivocation keys. Otherwise an honest validator that signs both is falsely
// slashable (R-4). A mismatch here forks the chain.
const { expect } = require('chai');
const eq  = require('../../src/equivocation_header.js');
const SCE = require('../../src/StateCheckpointEngine.js');
const sdkCheckpoint = require('../../../xchain-sdk/src/checkpoint.js');
const Anchor = require('../../../xchain-indexer/src/actions/anchor.js');

// regtest activates at genesis (threshold 0) → gate ON; mainnet is placeholder-
// disabled at a far-future height → gate OFF for any realistic block.
const cpOn  = { chain:'BTC', network:'regtest', block_index:500, block_hash:'bh',
                ledger_hash:'lh', actions_hash:'ah', contract_hash:'ch',
                checkpoint_seq:7, snapshot_block:480 };
const cpOff = Object.assign({}, cpOn, { network:'mainnet', snapshot_block:5 });

const RAW_ON  = 'XCHECKPOINT|BTC|regtest|500|bh|lh|ah|ch|7|480';
const RAW_OFF = 'XCHECKPOINT|BTC|mainnet|500|bh|lh|ah|ch|7|5';

// Minimal indexer Anchor (constructor only assigns; _canonical uses `d` + eq).
const anchor = new Anchor({ config:{}, decoderDb:null, indexerDb:null, util:null, mapper:null });
const dV0 = { FORMAT:0, CHAIN:'BTC', NETWORK:'regtest', BLOCK_INDEX_CHECKPOINTED:500,
              BLOCK_HASH:'bh', LEDGER_HASH:'lh', ACTIONS_HASH:'ah', CONTRACT_HASH:'ch',
              CHECKPOINT_SEQ:7, SNAPSHOT_BLOCK:480 };
const dV1 = Object.assign({}, dV0, { FORMAT:1, MATCH_BATCH_SEQ:3, MATCH_COUNT:10,
              BATCH_CRC32:'cc', TOTAL_CHUNKS:2 });
const RAW_V1 = RAW_ON + '|3|10|cc|2';

// key = the slice between the literal "EQUIV|" and the "||" boundary.
function keyOf(canon){
    expect(canon.startsWith('EQUIV|')).to.equal(true);
    return canon.slice('EQUIV|'.length, canon.indexOf('||'));
}

describe('EQUIV checkpoint canonical (WI-2 bump 2)', function () {

    describe('gate behavior (v0)', function () {
        it('below the flag-day → bare raw bytes (regression-safe)', function () {
            expect(SCE.canonicalCheckpoint(cpOff)).to.equal(RAW_OFF);
        });
        it('at/above the flag-day → header-wrapped (TAG=XCHECKPOINT, v0 round id, VIEW=0)', function () {
            expect(SCE.canonicalCheckpoint(cpOn))
                .to.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|0||' + RAW_ON);
        });
        it('_rawCanonicalCheckpoint is always the bare bytes (used nested by the v1 archive)', function () {
            expect(SCE._rawCanonicalCheckpoint(cpOn)).to.equal(RAW_ON);
        });
    });

    describe('cross-service byte parity', function () {
        it('hub == sdk (above gate)', function () {
            expect(sdkCheckpoint.canonicalCheckpoint(cpOn)).to.equal(SCE.canonicalCheckpoint(cpOn));
        });
        it('hub == sdk (below gate)', function () {
            expect(sdkCheckpoint.canonicalCheckpoint(cpOff)).to.equal(SCE.canonicalCheckpoint(cpOff));
        });
        it('hub == indexer anchor._canonical (v0, above gate)', function () {
            expect(anchor._canonical(dV0)).to.equal(SCE.canonicalCheckpoint(cpOn));
        });
        it('indexer anchor._canonical v0 below gate == bare bytes', function () {
            const off = Object.assign({}, dV0, { NETWORK:'mainnet', SNAPSHOT_BLOCK:5 });
            expect(anchor._canonical(off)).to.equal(RAW_OFF);
        });
    });

    describe('v0/v1 collision fix (R-4)', function () {
        it('v1 archive canonical is header-wrapped with batch_seq in the round id', function () {
            expect(anchor._canonical(dV1))
                .to.equal('EQUIV|XCHECKPOINT|BTC|regtest|500|7|3|0||' + RAW_V1);
        });
        it('v0 and v1 carry DISTINCT equivocation keys (no false-slash)', function () {
            const k0 = keyOf(SCE.canonicalCheckpoint(cpOn));   // ...|7|0
            const k1 = keyOf(anchor._canonical(dV1));          // ...|7|3|0
            expect(k0).to.equal('XCHECKPOINT|BTC|regtest|500|7|0');
            expect(k1).to.equal('XCHECKPOINT|BTC|regtest|500|7|3|0');
            expect(k0).to.not.equal(k1);
        });
    });
});
