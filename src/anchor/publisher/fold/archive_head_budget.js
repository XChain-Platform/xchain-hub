/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const ar = require('../../../consensus/gates/anchor_reward_gate.js');
const { ANCHOR_BUNDLE_MAX_BYTES } = require('../constants.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();
const NO_HEAD_ROOM = 'FOLD_ARCHIVE_NO_HEAD_ROOM';
const NO_HEAD_ROOM_ALARM_EVERY = 3;

function fixedSignatures(count){
    return Array.from({ length: Math.max(0, Number(count) || 0) }, () => ({
        pubkey: '0'.repeat(64), sig: '0'.repeat(128)
    }));
}

function noteNoHeadRoom(ctx, batchSeq, network, baseBytes){
    ctx._foldArchiveNoHeadRoom++;
    logger.warn('StateAnchorPublisher: folded archive batch ' + batchSeq + ' for ' + network +
                ' has no chunk-0 room: its worst-case v3 head is ' + baseBytes +
                ' bytes before archive data against the ' + ANCHOR_BUNDLE_MAX_BYTES + '-byte budget');
    escalateNoHeadRoomStreak(ctx, network);
}

// With the legacy archive leg suppressed the fold is the only archive route, so
// consecutive misses on one network leave its rows unarchived until the signing set
// or the group shrinks. The error repeats every NO_HEAD_ROOM_ALARM_EVERY misses.
function escalateNoHeadRoomStreak(ctx, network){
    if(!ctx._foldArchiveNoHeadRoomStreak) ctx._foldArchiveNoHeadRoomStreak = {};
    const streak = (ctx._foldArchiveNoHeadRoomStreak[network] || 0) + 1;
    ctx._foldArchiveNoHeadRoomStreak[network] = streak;
    if(streak % NO_HEAD_ROOM_ALARM_EVERY !== 0) return;
    logger.error('StateAnchorPublisher: ' + streak + ' consecutive folded archive head measurements for ' +
                 network + ' found no head room; its archive rows stay unarchived until the signing set or the bundle group shrinks');
}

function clearNoHeadRoomStreak(ctx, network){
    if(ctx._foldArchiveNoHeadRoomStreak) delete ctx._foldArchiveNoHeadRoomStreak[network];
}

// The streak clears only once a split fits, because the chunk-count miss below
// happens after the head measurement already returned a splitter.
function sizedSplitter(ctx, availableBytes, onNoHeadRoom, onFit){
    const splitter = b64 => {
        let headChars = Math.min(ctx.chunkMaxBytes, availableBytes);
        let chunks;
        while(true){
            chunks = ctx.splitFoldChunks(b64, headChars);
            const next = Math.min(ctx.chunkMaxBytes,
                availableBytes - (String(chunks.length).length - 1));
            if(next === headChars) break;
            if(next < 1){
                onNoHeadRoom();
                const error = new RangeError('fold archive chunk count leaves no head room');
                error.code = NO_HEAD_ROOM;
                throw error;
            }
            headChars = next;
        }
        splitter.headChars = headChars;
        onFit();
        return chunks;
    };
    splitter.headChars = Math.min(ctx.chunkMaxBytes, availableBytes);
    return splitter;
}

async function foldArchiveSplitter(ctx, group, network, batchSeq, wrapperSectionIndex, signingSet, publisher){
    const snapshotBlock = group.reduce((max, section) =>
        Math.max(max, Number(section.snapshot_block)), 0);
    const eligible = (await ctx.getActiveOraclePublishPubkeys(snapshotBlock)) || [];
    const attestCount = ar.isAnchorRewardActive(snapshotBlock, network) ? eligible.length : 0;
    const countDigits = String(Math.max(0, Number(ctx.maxBatch) || 0)).length;
    const archive = {
        wrapperSectionIndex, batchSeq, count: '9'.repeat(countDigits), crc: '00000000',
        chunks: [''],
        signatures: fixedSignatures(signingSet.length)
    };
    const payload = ctx.buildV3Payload({ network, snapshot_block: snapshotBlock }, group,
        archive, publisher, fixedSignatures(attestCount));
    const baseBytes = Buffer.byteLength(payload, 'utf8');
    const availableBytes = ANCHOR_BUNDLE_MAX_BYTES - baseBytes;
    const headChars = Math.min(ctx.chunkMaxBytes, availableBytes);
    if(headChars < 1){
        noteNoHeadRoom(ctx, batchSeq, network, baseBytes);
        return null;
    }
    const splitter = sizedSplitter(ctx, availableBytes,
        () => noteNoHeadRoom(ctx, batchSeq, network, baseBytes),
        () => clearNoHeadRoomStreak(ctx, network));
    splitter.baseBytes = baseBytes;
    return splitter;
}

module.exports = { foldArchiveSplitter, NO_HEAD_ROOM };
