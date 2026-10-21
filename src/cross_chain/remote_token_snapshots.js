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
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const { SNAPSHOT_BLOCK_TOLERANCE } = require('./bridge/constants.js');
const gateRegistry = require('../consensus/gate_registry');
const ah = require('../lib/admission_height.js');
const logger = getLogger();

const MAX_TOKEN_DECIMALS = 18;
const REMOTE_TOKEN_TABLE = 'remote_token_snapshots';
const REMOTE_TOKEN_ADMISSION_KEY = 'remote_token_admission_activation.REMOTE_TOKEN_ADMISSION_ACTIVATION';
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

// Whether a row is in the admission era: the bare network entry at the row's own BTC
// snapshot_block, so the bytes a row is signed over are fixed when it is produced and every
// indexer rebuilds them from the row alone.
function remoteTokenAdmissionEra(row){
    return gateRegistry.activeAt(REMOTE_TOKEN_ADMISSION_KEY, row.network, null, Number(row.snapshot_block), null);
}

// The admission field of the XREMOTE canonical: '' below the era, else '|' and the canonical
// encoding of the row's admission map. A row in the era with no map throws, so it is never
// signed and never verified. MUST byte-match the indexer's remoteTokenAdmissionField.
function remoteTokenAdmissionField(row){
    if(!remoteTokenAdmissionEra(row)) return '';
    const map = ah.rowAdmitBlocks(row);
    if(map === null)
        throw new Error('remote token snapshot ' + stringField(row.snapshot_id) + ' is in the admission era and carries no admission map');
    return '|' + ah.encodeAdmitBlocks(map);
}

function canonicalRemoteTokenSnapshot(row, view){
    return [
        'XREMOTE', stringField(row.snapshot_id), String(Number(view) || 0),
        remoteTokenContent(row)
    ].join('|') + remoteTokenAdmissionField(row);
}

// The follower's admission scope: null below the era, where a row carries no map; every
// chain otherwise, because any chain's ORDER or SWAP create can read the pin.
function remoteTokenAdmissionScope(row){
    if(!remoteTokenAdmissionEra(row || {})) return null;
    return { table: REMOTE_TOKEN_TABLE, readSet: ah.admissionReadSet(REMOTE_TOKEN_TABLE, row, ah.ADMIT_COLUMN_CHAINS) };
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
    if(observed === null) return false;
    // The offer cannot reproduce the leader's admission map; the follower bounds that map on
    // its own (CrossChainDexConsensus.admissionBoundHolds), so the compare carries it over.
    if(remoteTokenAdmissionEra(row)){
        try { Object.assign(observed, ah.admitBlocksToColumns(ah.rowAdmitBlocks(row))); }
        catch(_error){ return false; }
    }
    try { return canonicalRemoteTokenSnapshot(observed) === canonicalRemoteTokenSnapshot(row); }
    catch(_error){ return false; }
}

function remoteTokenSnapshotBlockOk(snapshotBlock, followerSnapshotBlock){
    const proposed = canonicalInteger(snapshotBlock);
    const observed = canonicalInteger(followerSnapshotBlock);
    return proposed !== null && observed !== null &&
        Math.abs(proposed - observed) <= SNAPSHOT_BLOCK_TOLERANCE;
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
        admissionScope: row => remoteTokenAdmissionScope(row),
        persistCapabilitySnapshot: (...args) => parent.persistCapabilitySnapshot(...args)
    };
    return new Consensus(adapter, {
        messageTypes: MESSAGE_TYPES,
        controlTags: { vc: 'XREMOTEV', nv: 'XREMOTEN' },
        idField: 'snapshot_id'
    });
}

const enginePart = {
    initRemoteTokenSnapshots(Consensus){
        this._remoteTokenInflight = new Set();
        this._remoteTokenPublishing = false;
        this.remoteTokenConsensus = createRemoteTokenConsensus(
            this, Consensus || this.consensus.constructor);
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
            if(!(await this.stampRemoteTokenAdmission(row))){
                this._remoteTokenInflight.delete(row.snapshot_id);
                return;
            }
            await this.remoteTokenConsensus.propose(row.snapshot_id, {
                match: row,
                snapshot: { validators, count: validators.length }
            });
        } catch(error){
            this._remoteTokenInflight.delete(row.snapshot_id);
            throw error;
        }
    },

    // In the admission era, stamp the row's admission map (this hub's admission tip plus the
    // table margin on every chain) before it is proposed. With no fresh tip for a chain the
    // round is not opened: a guessed height forks the federation, a refusal stalls one pin.
    // Below the era the row is proposed exactly as before.
    async stampRemoteTokenAdmission(row){
        const scope = remoteTokenAdmissionScope(row);
        if(scope === null) return true;
        const map = this.hub && typeof this.hub.resolveAdmitBlocks === 'function'
            ? await this.hub.resolveAdmitBlocks(REMOTE_TOKEN_TABLE, scope.readSet) : null;
        if(!map){
            logger.error('CrossChainDex: not proposing remote token snapshot ' + String(row.snapshot_id).substring(0, 16) +
                '... at snapshot_block ' + row.snapshot_block + '; no fresh admission tip for ' + scope.readSet.join(' / '));
            return false;
        }
        Object.assign(row, ah.admitBlocksToColumns(map));
        return true;
    },

    async validateRemoteTokenSnapshot(row){
        if(!remoteTokenRowShapeOk(row)) return false;
        if(String(row.network) !== String(this.network)) return false;
        const followerSnapshotBlock = await this.resolveSnapshotBlock();
        if(!remoteTokenSnapshotBlockOk(row.snapshot_block, followerSnapshotBlock)) return false;
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
        let failure = null;
        try {
            const rows = await this.db.getRemoteTokenSnapshotById(snapshotId);
            if(rows && rows.length){
                broadcaster.broadcastRow({ table: 'remote_token_snapshots', row: rows[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(error){
            failure = (error && error.message) ? error.message : String(error);
        }
        // Name the cause before the fleet-wide resync (a thrown read vs an empty read-back).
        logger.error('RemoteToken: could not stream a committed remote_token_snapshots row to mirror subscribers (' +
                     failure + '); forcing subscriber resync');
        // Keep a broadcaster fault out of the caller's catch: the row is already committed.
        try {
            if(typeof broadcaster.dropAllForResync === 'function')
                broadcaster.dropAllForResync('remote_token_snapshots mirror gap');
        } catch(error){
            logger.error('RemoteToken: subscriber resync after the mirror gap failed: ' +
                         ((error && error.message) ? error.message : String(error)));
        }
    }
};

module.exports = {
    MAX_TOKEN_DECIMALS,
    MESSAGE_TYPES,
    REMOTE_TOKEN_ADMISSION_KEY,
    buildRemoteTokenSnapshot,
    canonicalRemoteTokenSnapshot,
    remoteTokenAdmissionField,
    remoteTokenAdmissionScope,
    createRemoteTokenConsensus,
    deriveRemoteTokenSnapshotId,
    remoteTokenProposalAgrees,
    remoteTokenRowShapeOk,
    remoteTokenRowsFromBooks,
    remoteTokenSnapshotBlockOk,
    tokenObservation,
    enginePart
};
