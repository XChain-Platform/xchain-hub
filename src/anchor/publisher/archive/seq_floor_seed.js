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

function warnLookupFailure(logger, detail){
    try {
        if(logger && typeof logger.warn === 'function')
            logger.warn('StateAnchorPublisher: getarchiveanchor floor lookup failed: ' + detail);
    } catch(e) {}
}

// Sort an author-only getarchiveanchor reply into one outcome: 'error' (the indexer
// answered with an error), 'none' (an explicit author miss), 'invalid' (a malformed
// reply or seq) or 'ok' with the integer seq. Every floor reader uses this.
function classifyArchiveSeqFloorReply(res){
    if(res && res.error) return { kind: 'error', detail: String(res.error) };
    if(res && res.exists === false && res.match_batch_seq == null) return { kind: 'none' };
    if(!res || res.exists !== true || res.match_batch_seq == null)
        return { kind: 'invalid', raw: res && res.match_batch_seq };
    const seq = Number(res.match_batch_seq);
    if(!Number.isSafeInteger(seq) || seq < 0) return { kind: 'invalid', raw: res.match_batch_seq };
    return { kind: 'ok', seq };
}

async function readArchiveSeqFloor({ indexerCall, dogeAddress, dogeIndexerUrl, logger }){
    const outcome = await readArchiveSeqFloorOutcome({
        indexerCall, dogeAddress, dogeIndexerUrl, logger
    });
    return outcome.kind === 'ok' ? outcome.seq : null;
}

// Preserve whether the indexer gave a definitive answer. A missing archive is known;
// a failed lookup or malformed seq is not and must not authorize a fresh leader draw.
async function readArchiveSeqFloorOutcome({ indexerCall, dogeAddress, dogeIndexerUrl, logger }){
    if(!dogeAddress || !dogeIndexerUrl) return { kind: 'unconfigured' };

    let res;
    try {
        res = await indexerCall('DOGE', 'getarchiveanchor', { author: dogeAddress });
    } catch(e) {
        warnLookupFailure(logger, e && e.message);
        return { kind: 'unknown', reason: 'lookup_failed' };
    }

    const reply = classifyArchiveSeqFloorReply(res);
    if(reply.kind === 'error'){
        warnLookupFailure(logger, reply.detail);
        return { kind: 'unknown', reason: 'indexer_error' };
    }
    if(reply.kind === 'invalid')
        return { kind: 'unknown', reason: 'invalid_seq', raw: reply.raw };
    return reply;
}

module.exports = {
    classifyArchiveSeqFloorReply, readArchiveSeqFloor, readArchiveSeqFloorOutcome
};
