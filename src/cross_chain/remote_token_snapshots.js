/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

const MAX_TOKEN_DECIMALS = 18;
const MESSAGE_TYPES = Object.freeze({
    PROPOSE: 'XREMOTE_TOKEN_PROPOSE',
    PREPARE: 'XREMOTE_TOKEN_PREPARE',
    COMMIT: 'XREMOTE_TOKEN_COMMIT',
    VIEW_CHANGE: 'XREMOTE_TOKEN_VIEW_CHANGE',
    NEW_VIEW: 'XREMOTE_TOKEN_NEW_VIEW',
    FINAL_SYNC: 'XREMOTE_TOKEN_FINAL_SYNC'
});

function stringField(value){
    return value === null || value === undefined ? '' : String(value);
}

function canonicalInteger(value){
    if(value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && String(number) === String(value)
        ? number : null;
}

function tokenObservation(coin, offer){
    if(!offer || typeof offer !== 'object') return null;
    const tick = stringField(offer.give_tick);
    const owner = stringField(offer.give_owner || offer.source);
    const decimals = Number(offer.give_decimals);
    const sourceActionIndex = Number(offer.action_index);
    if(!coin || !tick || !owner || !Number.isInteger(decimals) ||
       decimals < 0 || decimals > MAX_TOKEN_DECIMALS ||
       !Number.isSafeInteger(sourceActionIndex) || sourceActionIndex < 0) return null;
    return {
        coin: String(coin).toUpperCase(),
        tick,
        decimals,
        owner,
        source_action_index: sourceActionIndex
    };
}

function remoteTokenContent(row){
    return [
        stringField(row.network),
        stringField(row.coin).toUpperCase(),
        stringField(row.tick),
        String(Number(row.decimals)),
        stringField(row.owner),
        String(Number(row.source_action_index)),
        String(Number(row.snapshot_block))
    ].join('|');
}

function deriveRemoteTokenSnapshotId(row){
    return crypto.createHash('sha256').update(remoteTokenContent(row), 'utf8').digest('hex');
}

function buildRemoteTokenSnapshot(network, snapshotBlock, coin, offer){
    const observation = tokenObservation(coin, offer);
    const block = Number(snapshotBlock);
    if(!observation || !network || !Number.isSafeInteger(block) || block < 0) return null;
    const row = Object.assign({
        network: String(network),
        snapshot_block: block
    }, observation);
    row.snapshot_id = deriveRemoteTokenSnapshotId(row);
    return row;
}

function canonicalRemoteTokenSnapshot(row, view){
    return [
        'XREMOTE', stringField(row.snapshot_id), String(Number(view) || 0),
        remoteTokenContent(row)
    ].join('|');
}

function remoteTokenRowShapeOk(row){
    if(!row || typeof row !== 'object') return false;
    if(!/^[0-9a-f]{64}$/.test(stringField(row.snapshot_id))) return false;
    if(!stringField(row.network) || !stringField(row.coin) ||
       !stringField(row.tick) || !stringField(row.owner)) return false;
    const decimals = canonicalInteger(row.decimals);
    const actionIndex = canonicalInteger(row.source_action_index);
    const snapshotBlock = canonicalInteger(row.snapshot_block);
    if(decimals === null || decimals > MAX_TOKEN_DECIMALS ||
       actionIndex === null || snapshotBlock === null) return false;
    return deriveRemoteTokenSnapshotId(row) === row.snapshot_id;
}

function remoteTokenProposalAgrees(row, offer){
    if(!remoteTokenRowShapeOk(row)) return false;
    const observed = buildRemoteTokenSnapshot(
        row.network,
        row.snapshot_block,
        row.coin,
        offer
    );
    return observed !== null &&
        canonicalRemoteTokenSnapshot(observed) === canonicalRemoteTokenSnapshot(row);
}

function remoteTokenRowsFromBooks(network, snapshotBlock, offersByCoin){
    const rows = new Map();
    for(const coin of Object.keys(offersByCoin || {}).sort()){
        for(const offer of (offersByCoin[coin] || [])){
            const row = buildRemoteTokenSnapshot(network, snapshotBlock, coin, offer);
            if(!row) continue;
            const key = row.coin + '|' + row.tick + '|' + row.decimals + '|' + row.owner;
            const held = rows.get(key);
            if(!held || row.source_action_index < held.source_action_index) rows.set(key, row);
        }
    }
    return [...rows.values()].sort((a, b) => {
        const left = remoteTokenContent(a);
        const right = remoteTokenContent(b);
        return left < right ? -1 : left > right ? 1 : 0;
    });
}

function createRemoteTokenConsensus(parent, Consensus){
    const adapter = {
        hub: parent.hub,
        peerManager: parent.peerManager,
        identity: parent.identity,
        capSnapshot: parent.capSnapshot,
        canonicalMatch: (row, view) => canonicalRemoteTokenSnapshot(row, view),
        validateProposedMatch: row => parent.validateRemoteTokenSnapshot(row),
        persistCapabilitySnapshot: (...args) => parent.persistCapabilitySnapshot(...args)
    };
    const consensus = new Consensus(adapter, {
        messageTypes: MESSAGE_TYPES,
        controlTags: { vc: 'XREMOTEV', nv: 'XREMOTEN' },
        idField: 'snapshot_id'
    });
    const bridge = new EventEmitter();
    consensus.on('match:finalized', event => {
        const bridged = Object.assign({}, event, { match: event.row });
        delete bridged.row;
        bridge.emit('match:finalized', bridged);
    });
    consensus.on('match:abandoned', event => bridge.emit('match:abandoned', event));
    bridge.propose = (snapshotId, context) => consensus.propose(snapshotId, {
        row: context.match,
        snapshot: context.snapshot
    });
    for(const method of ['start', 'stop', 'forgetFinalized'])
        bridge[method] = (...args) => consensus[method](...args);
    return bridge;
}

const enginePart = {
    initRemoteTokenSnapshots(){
        this._remoteTokenInflight = new Set();
        this._remoteTokenPublishing = false;
        this.remoteTokenConsensus = createRemoteTokenConsensus(
            this, this.consensus.constructor);
        this.remoteTokenConsensus.on('match:finalized', (event) => {
            this.writeFinalizedRemoteTokenSnapshot(event).catch(error =>
                logger.error(nodeUtil.format(
                    'CrossChainDex: write finalized remote token snapshot error:',
                    error && error.message)));
        });
        this.remoteTokenConsensus.on('match:abandoned', (event) => {
            this._remoteTokenInflight.delete(String(event.matchId));
        });
    },

    async publishRemoteTokenSnapshots(){
        if(this._remoteTokenPublishing) return;
        this._remoteTokenPublishing = true;
        try {
            const snapshotBlock = await this.resolveSnapshotBlock();
            if(snapshotBlock === null || snapshotBlock === undefined) return;

            const offersByCoin = {};
            await Promise.all(Object.keys(this.indexers).sort().map(async coin => {
                if(!this.indexers[coin] || !this.indexers[coin].url){
                    offersByCoin[coin] = [];
                    return;
                }
                try {
                    const answer = await this.fetchOpenOffers(coin, { limit: 500 });
                    offersByCoin[coin] = answer && answer.network === this.network
                        ? answer.orders : [];
                } catch(_error){
                    offersByCoin[coin] = [];
                }
            }));

            const rows = remoteTokenRowsFromBooks(
                this.network, Number(snapshotBlock), offersByCoin);
            if(rows.length === 0) return;
            const validators = await this.resolveCapabilityValidators(
                'cross_chain', Number(snapshotBlock), this.network);
            for(const row of rows) await this.proposeRemoteTokenSnapshot(row, validators);
        } finally {
            this._remoteTokenPublishing = false;
        }
    },

    async proposeRemoteTokenSnapshot(row, validators){
        if(this._remoteTokenInflight.has(row.snapshot_id)) return;
        const held = await this.db.getRemoteTokenSnapshotById(row.snapshot_id);
        if(held && held.length) return;
        this._remoteTokenInflight.add(row.snapshot_id);
        try {
            await this.remoteTokenConsensus.propose(row.snapshot_id, {
                match: row,
                snapshot: { validators, count: validators.length }
            });
        } catch(error){
            this._remoteTokenInflight.delete(row.snapshot_id);
            throw error;
        }
    },

    async validateRemoteTokenSnapshot(row){
        if(!remoteTokenRowShapeOk(row)) return false;
        if(String(row.network) !== String(this.network)) return false;
        const offer = await this.findOpenOffer(
            String(row.coin).toUpperCase(), Number(row.source_action_index));
        return remoteTokenProposalAgrees(row, offer);
    },

    async writeFinalizedRemoteTokenSnapshot(event){
        const row = event.match;
        row.validator_signatures = JSON.stringify(event.signatures || []);
        row.finalizing_view = event.view != null ? Number(event.view) : 0;
        row.status = 'finalized';
        try {
            const persisted = await this.persistCapabilitySnapshot(
                'cross_chain', Number(row.snapshot_block), row.network);
            if(!persisted) throw new Error('empty cross_chain capability snapshot');
            const result = await this.db.insertRemoteTokenSnapshot(
                row, await this.resolveBtcChainId(row.network));
            this._remoteTokenInflight.delete(row.snapshot_id);
            if(result && Number(result.affectedRows) > 0)
                await this.mirrorRemoteTokenSnapshot(row.snapshot_id);
        } catch(error){
            this._remoteTokenInflight.delete(row.snapshot_id);
            if(this.remoteTokenConsensus &&
               typeof this.remoteTokenConsensus.forgetFinalized === 'function')
                this.remoteTokenConsensus.forgetFinalized(row.snapshot_id);
            throw error;
        }
    },

    async mirrorRemoteTokenSnapshot(snapshotId){
        const broadcaster = this.broadcaster;
        if(!broadcaster) return;
        if(broadcaster.subscribers && broadcaster.subscribers.size === 0) return;
        try {
            const rows = await this.db.getRemoteTokenSnapshotById(snapshotId);
            if(rows && rows.length){
                broadcaster.broadcastRow({ table: 'remote_token_snapshots', row: rows[0] });
                return;
            }
        } catch(_error){}
        if(typeof broadcaster.dropAllForResync === 'function')
            broadcaster.dropAllForResync('remote_token_snapshots mirror gap');
    }
};

module.exports = {
    MAX_TOKEN_DECIMALS,
    MESSAGE_TYPES,
    buildRemoteTokenSnapshot,
    canonicalRemoteTokenSnapshot,
    createRemoteTokenConsensus,
    deriveRemoteTokenSnapshotId,
    remoteTokenProposalAgrees,
    remoteTokenRowShapeOk,
    remoteTokenRowsFromBooks,
    tokenObservation,
    enginePart
};
