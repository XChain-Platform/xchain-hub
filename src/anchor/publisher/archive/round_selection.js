'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { getLogger } = require('../../../observability');
const logger = getLogger();

async function selectArchiveRoundInput(pub){
    let cps = null;
    let network = String(pub.network || '');
    let rows = await pub.gatherUnpublishedArchiveRows(network);
    if(!network){
        cps = await pub.latestArchiveWrapperRows();
        if(!cps || cps.length === 0){
            if(!rows) return { status: pub.archiveFlushStatus('none', 'no_pending_rows') };
            logger.info('StateAnchorPublisher: no state checkpoint yet; archive deferred');
            return { status: pub.archiveFlushStatus('none', 'no_wrapper_checkpoint') };
        }
        network = String(cps[0].network);
        rows = await pub.gatherUnpublishedArchiveRows(network);
    }
    if(!rows) return { status: pub.archiveFlushStatus('none', 'no_pending_rows') };
    if(!cps) cps = await pub.latestArchiveWrapperRows();
    if(!cps || cps.length === 0){
        logger.info('StateAnchorPublisher: no state checkpoint yet; archive deferred');
        return { status: pub.archiveFlushStatus('none', 'no_wrapper_checkpoint') };
    }
    if(!network) network = String(cps[0].network);
    if(String(cps[0].network) !== network){
        network = String(cps[0].network);
        rows = await pub.gatherUnpublishedArchiveRows(network);
        if(!rows) return { status: pub.archiveFlushStatus('none', 'no_pending_rows') };
    }
    return { cps, network, rows };
}

module.exports = { selectArchiveRoundInput };
