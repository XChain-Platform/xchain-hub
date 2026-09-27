'use strict';

function warnLookupFailure(logger, detail){
    try {
        if(logger && typeof logger.warn === 'function')
            logger.warn('StateAnchorPublisher: getarchiveanchor floor lookup failed: ' + detail);
    } catch(e) {}
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

    if(res && res.error){
        warnLookupFailure(logger, res.error);
        return null;
    }
    if(!res || !res.exists || res.match_batch_seq == null) return null;

    const seq = Number(res.match_batch_seq);
    return Number.isFinite(seq) && Number.isInteger(seq) && seq >= 0 ? seq : null;
}

module.exports = { readArchiveSeqFloor };
