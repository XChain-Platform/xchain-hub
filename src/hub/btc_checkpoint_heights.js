'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const nodeUtil = require('node:util');
const { axiosFor } = require('./indexer_http.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');

const logger = getLogger();

function lagRefusal(lag){
    let maxLag = Number(hubConfig.MAX_INDEXER_LAG_BLOCKS);
    if(!Number.isFinite(maxLag) || maxLag < 0) maxLag = 200;
    if(lag == null || lag === '' || !Number.isFinite(Number(lag)))
        return 'reported no usable lag (' + JSON.stringify(lag) + '); cannot date the committed tip';
    return Number(lag) > maxLag
        ? 'lag ' + lag + ' exceeds MAX_INDEXER_LAG_BLOCKS (' + maxLag + '); ignoring stale tip'
        : null;
}

function chainHeight(value){
    if(value === null || value === undefined || value === '') return null;
    const height = Number(value);
    return Number.isSafeInteger(height) && height >= 0 ? height : null;
}

// Read the committed and chain clocks from one indexer response. No general tip
// freshness gate belongs here because callers separately require the checkpoint
// block to be committed before reading and signing its state root.
async function resolveBtcCheckpointHeights(hub){
    const url = await hub.resolveBtcIndexerUrl();
    if(!url){
        logger.warn('XChainHub: no BTC indexer URL resolves; no BTC checkpoint heights');
        return null;
    }
    try {
        const res = await axiosFor(hub).post(url, {
            jsonrpc: '2.0', id: Date.now(),
            method: 'getlatestblock', params: {}
        }, { timeout: 5000 });
        const result = res && res.data && res.data.result;
        if(!result || result.error){
            logger.warn('XChainHub: BTC indexer getlatestblock returned ' +
                (result ? 'an error (' + JSON.stringify(result.error) + ')' : 'no result') +
                '; no BTC checkpoint heights');
            return null;
        }
        const committedHeight = chainHeight(result.block_index);
        const decoderHeight = chainHeight(result.decoder_block);
        if(committedHeight === null || decoderHeight === null){
            logger.warn('XChainHub: BTC indexer getlatestblock returned unusable checkpoint heights ' +
                '(block_index ' + JSON.stringify(result.block_index) + ', decoder_block ' +
                JSON.stringify(result.decoder_block) + ')');
            return null;
        }
        return { committedHeight, chainHeight: decoderHeight };
    } catch (err) {
        logger.error(nodeUtil.format(
            'XChainHub: failed to resolve BTC checkpoint heights from indexer:', err));
        return null;
    }
}

module.exports = { lagRefusal, resolveBtcCheckpointHeights };
