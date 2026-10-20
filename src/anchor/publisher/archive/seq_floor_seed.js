'use strict';

function warnLookupFailure(logger, detail){
    try {
        if(logger && typeof logger.warn === 'function')
            logger.warn('StateAnchorPublisher: getarchiveanchor floor lookup failed: ' + detail);
    } catch(e) {}
}

// Sort an author-only getarchiveanchor reply into one outcome: 'error' (the indexer
// answered with an error), 'none' (no archive under this author), 'invalid' (the seq is
// not a whole number >= 0) or 'ok' with the integer seq. Every floor reader uses this.
function classifyArchiveSeqFloorReply(res){
    if(res && res.error) return { kind: 'error', detail: String(res.error) };
    if(!res || !res.exists || res.match_batch_seq == null) return { kind: 'none' };
    const seq = Number(res.match_batch_seq);
    if(!Number.isSafeInteger(seq) || seq < 0) return { kind: 'invalid', raw: res.match_batch_seq };
    return { kind: 'ok', seq };
}

async function readArchiveSeqFloor({ indexerCall, dogeAddress, dogeIndexerUrl, logger }){
    if(!dogeAddress || !dogeIndexerUrl) return null;

    let res;
    try {
        res = await indexerCall('DOGE', 'getarchiveanchor', { author: dogeAddress });
    } catch(e) {
        warnLookupFailure(logger, e && e.message);
        return null;
    }

    const reply = classifyArchiveSeqFloorReply(res);
    if(reply.kind === 'error') warnLookupFailure(logger, reply.detail);
    return reply.kind === 'ok' ? reply.seq : null;
}

module.exports = { classifyArchiveSeqFloorReply, readArchiveSeqFloor };
