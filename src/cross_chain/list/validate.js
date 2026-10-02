/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Shared List Proposal Validation
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const ah = require('../../lib/admission_height.js');
const registry = require('../../consensus/gate_registry.js');
const { SNAPSHOT_BLOCK_TOLERANCE } = require('../bridge/constants.js');
const { deriveListSnapshotId, foldListChain } = require('./canonical.js');
const { heldRowVerdict } = require('./held_checks.js');
const { ownReadVerdict } = require('./read_checks.js');
const { listRowShapeOk, listTransportOk } = require('./row_checks.js');

const LIST_META_GATE_KEY = 'list_meta_activation.LIST_META_ACTIVATION';

function listMetaActive(engine, snapshotBlock) {
    const reader = engine.activation && engine.activation.listMeta;
    if (typeof reader === 'function') {
        return reader(Number(snapshotBlock), engine.network, 'BTC') === true;
    }
    if (!engine.listConsensus) return false;
    return registry.activeAt(
        LIST_META_GATE_KEY,
        engine.network,
        'BTC',
        Number(snapshotBlock),
        null
    ) === true;
}

function parseHeldChain(rows){
    if(!Array.isArray(rows)) return null;
    try {
        return rows.map(row => ({
            seq: Number(row.seq),
            kind: row.kind,
            list_type: Number(row.list_type),
            added: Array.isArray(row.added) ? row.added : JSON.parse(row.added),
            removed: Array.isArray(row.removed) ? row.removed : JSON.parse(row.removed),
            members_hash: row.members_hash,
            origin_block: Number(row.origin_block)
        }));
    } catch(_e){
        return null;
    }
}

function homeTipFrom(answer){
    if(!answer || typeof answer !== 'object') return null;
    const raw = answer.block_index != null ? answer.block_index : answer.latest_block_index;
    if(raw === null || raw === undefined || raw === '') return null;
    const tip = Number(raw);
    return Number.isSafeInteger(tip) && tip >= 0 ? tip : null;
}

async function snapshotGuardsHold(engine, row){
    const snapshotBlock = Number(row.snapshot_block);
    const ownSnapshot = await engine.resolveSnapshotBlock();
    const ownSnapshotBlock = ownSnapshot === null || ownSnapshot === undefined ?
        NaN : Number(ownSnapshot);
    return Number.isFinite(ownSnapshotBlock) &&
        Math.abs(snapshotBlock - ownSnapshotBlock) <= SNAPSHOT_BLOCK_TOLERANCE &&
        engine.activation.producer(snapshotBlock, engine.network, 'BTC') &&
        ah.isAdmissionEra(engine.network, snapshotBlock);
}

async function readHeldState(engine, row){
    const key = [row.network, row.home_chain, Number(row.home_list_index)];
    const seq = Number(row.seq);
    const [heldAtSeq, latestHeldSeq, rawChain] = await Promise.all([
        engine.db.getListSnapshotAtSeq(...key, seq),
        engine.db.getLatestListSeq(...key),
        seq > 1 ? engine.db.findListSnapshotChain(...key, seq - 1) : Promise.resolve([])
    ]);
    const heldChain = parseHeldChain(rawChain);
    if(heldChain === null) return null;
    const previous = seq > 1 && heldChain.length ? heldChain[heldChain.length - 1] : null;
    if(heldRowVerdict({
        row: Object.assign({}, row, { seq }),
        heldAtSeq,
        latestHeldSeq,
        prevOriginBlock: previous && previous.seq === seq - 1 ? previous.origin_block : null
    }) !== 'pass') return null;

    let previousMembers = null;
    if(seq > 1){
        if(heldChain.length !== seq - 1) return null;
        previousMembers = foldListChain(heldChain);
        if(previousMembers === null) return null;
    }
    const heldListType = heldAtSeq && heldAtSeq.list_type != null ? heldAtSeq.list_type :
        (previous ? previous.list_type : null);
    return { previousMembers, heldListType };
}

async function ownReadsPass(engine, row, heldState, metaActive){
    const [sharedLists, latest, read] = await Promise.all([
        engine.indexerCall(row.home_chain, 'getsharedlists', { network: row.network }),
        engine.indexerCall(row.home_chain, 'getlatestblock', {}),
        engine.indexerCall(row.home_chain, 'getlistat', {
            list_index: Number(row.home_list_index),
            block: Number(row.origin_block)
        })
    ]);
    if(ownReadVerdict({
        row,
        sharedLists,
        homeTip: homeTipFrom(latest),
        confirmations: Number(engine.confirmations[row.home_chain]),
        read,
        heldListType: heldState.heldListType,
        metaActive
    }) !== 'pass') return false;
    return listTransportOk(row, read.members, heldState.previousMembers);
}

module.exports = {
    async indexerCall(coin, method, params){
        const indexer = this.indexers[coin];
        if(!indexer || !indexer.url) throw new Error('no indexer url for ' + coin);
        const headers = { 'Content-Type': 'application/json' };
        if(indexer.key) headers['x-api-key'] = indexer.key;
        const response = await axios.post(
            indexer.url,
            { jsonrpc: '2.0', method, params: params || {}, id: 1 },
            { headers, timeout: 15000 }
        );
        if(response.data && response.data.error)
            throw new Error('indexer RPC error: ' + JSON.stringify(response.data.error));
        return response.data ? response.data.result : null;
    },

    async validateProposedMatch(row){
        try {
            if(!listRowShapeOk(row, this.network)) return false;
            if(!await snapshotGuardsHold(this, row)) return false;
            const expectedId = deriveListSnapshotId(
                row.network,
                row.home_chain,
                row.home_list_index,
                row.seq,
                row.snapshot_block
            );
            if(row.snapshot_id !== expectedId) return false;
            const heldState = await readHeldState(this, row);
            const metaActive = listMetaActive(this, row.snapshot_block);
            return heldState !== null &&
                await ownReadsPass(this, row, heldState, metaActive);
        } catch(_e){
            return false;
        }
    }
};
