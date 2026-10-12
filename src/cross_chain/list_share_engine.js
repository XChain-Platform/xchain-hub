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
 * XChain Hub - Shared List Engine
 *
 ********************************************************************/

'use strict';

const EventEmitter = require('events');

const registry               = require('../consensus/gate_registry.js');
const ah                     = require('../lib/admission_height.js');
const CrossChainDexConsensus = require('./dex_consensus.js');
const coins                  = require('../coins');
const hubConfig              = require('../config');
const { resolveRegtestSnapshotSeams } = require('../lib/regtest_snapshot_seams.js');
const nodeUtil               = require('node:util');
const { getLogger }          = require('../observability');
const logger                 = getLogger();
const { installParts }       = require('./prototype_parts.js');
const { ALLOWED_CHAINS, DEFAULT_POLL_MS } = require('./bridge/constants.js');
const { listSnapshotCanonical } = require('./list/canonical.js');
const plumbingPart = require('./bridge/plumbing.js');
const pollPart     = require('./list/poll.js');
const validatePart = require('./list/validate.js');
const persistPart  = require('./list/persist.js');

const PRODUCER_GATE_KEY = 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION';

function loadProducerActivation(){
    registry.get(PRODUCER_GATE_KEY);
    return (block, network, coin) =>
        registry.activeAt(PRODUCER_GATE_KEY, network, coin, block, null);
}

class ListShareEngine extends EventEmitter {

    constructor(hub){
        super();
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.capSnapshot = hub.capabilitySnapshot || null;

        const cfg = hub.p2pConfig || {};
        this.network = (hub && hub.network) ? hub.network : '';
        this.pollMs = parseInt(hubConfig.XBRIDGE_POLL_MS || cfg.XBRIDGE_POLL_MS || DEFAULT_POLL_MS);
        this.confirmations = coins.resolveConfirmations(cfg, this.network);

        const seams = resolveRegtestSnapshotSeams(this.network, cfg);
        this._snapshotBlockOverride = seams.snapshotBlockOverride;
        this._seedLocalValidator    = seams.seedLocalValidator;

        this.indexers = {};
        for(const coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: hubConfig.env()[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: hubConfig.env()[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        this._inflight = new Set();
        this.activation = { producer: loadProducerActivation() };
        this._idleLogged = {};
        this.createListConsensus();
        this._pollTimer = null;
        this._polling = false;
    }

    createListConsensus(){
        this.listConsensus = new CrossChainDexConsensus(this, {
            messageTypes: {
                PROPOSE:     'XLISTSHARE_SNAPSHOT_PROPOSE',
                PREPARE:     'XLISTSHARE_SNAPSHOT_PREPARE',
                COMMIT:      'XLISTSHARE_SNAPSHOT_COMMIT',
                VIEW_CHANGE: 'XLISTSHARE_SNAPSHOT_VIEW_CHANGE',
                NEW_VIEW:    'XLISTSHARE_SNAPSHOT_NEW_VIEW',
                FINAL_SYNC:  'XLISTSHARE_SNAPSHOT_FINAL_SYNC'
            },
            controlTags: { vc: 'XLISTSHAREVC', nv: 'XLISTSHARENV' },
            idField: 'snapshot_id'
        });
        this.listConsensus.on('match:finalized', (ev) => {
            this.writeFinalizedList(ev).catch(err =>
                logger.error(nodeUtil.format('ListShare: write finalized snapshot error:', err && err.message)));
        });
        this.listConsensus.on('match:abandoned', (ev) => {
            this._inflight.delete(String(ev.matchId));
        });
    }

    async start(){
        if(this.hub && typeof this.hub.resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers)){
                if(this.indexers[coin].url) continue;
                try {
                    const url = await this.hub.resolveIndexerUrl(coin);
                    if(url) this.indexers[coin].url = url;
                } catch(_e){}
            }
        }
        await this.listConsensus.start();
        this._pollTimer = setInterval(() => {
            this.poll().catch(err =>
                logger.error(nodeUtil.format('ListShare: poll error:', err && err.message)));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        logger.info('ListShare: engine started (poll ' + this.pollMs + 'ms)');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        await this.listConsensus.stop();
    }

    async poll(){
        if(this._polling) return;
        this._polling = true;
        try {
            const snapshotBlock = await this.resolveSnapshotBlock();
            if(snapshotBlock === null || snapshotBlock === undefined) return;
            if(!this.activation.producer(snapshotBlock, this.network, 'BTC')) return;
            if(!ah.isAdmissionEra(this.network, snapshotBlock)){
                if(!this._idleLogged.admission){
                    this._idleLogged.admission = true;
                    logger.warn('ListShare: producer active outside the mirror admission era; polling is disabled');
                }
                return;
            }
            await this.pollSharedLists(snapshotBlock);
        } finally {
            this._polling = false;
        }
    }

    canonicalMatch(row, view){
        return listSnapshotCanonical(row, view);
    }

    admissionScope(row){
        return {
            table: 'list_snapshots',
            readSet: ah.admissionReadSet('list_snapshots', row, ah.ADMIT_COLUMN_CHAINS)
        };
    }
}

installParts(ListShareEngine.prototype, [plumbingPart, pollPart, validatePart, persistPart]);

ListShareEngine.PRODUCER_GATE_KEY = PRODUCER_GATE_KEY;

module.exports = ListShareEngine;
