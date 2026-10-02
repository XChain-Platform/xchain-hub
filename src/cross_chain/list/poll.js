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
 * XChain Hub - Shared List Polling
 *
 * Filled by the shared-list discovery and proposal row.
 *
 ********************************************************************/

'use strict';

const ah = require('../../lib/admission_height.js');
const registry = require('../../consensus/gate_registry.js');
const { getLogger } = require('../../observability');
const { ALLOWED_CHAINS } = require('../bridge/constants.js');
const { foldListChain } = require('./chain.js');
const { createFoldCache, listsDue } = require('./fold_cache.js');
const { listOriginBlockFrom, buildListSnapshotRow } = require('./row_build.js');
const { planListVersion } = require('./version_plan.js');

const logger = getLogger();
const foldCacheKey = Symbol('listFoldCache');
const LIST_META_GATE_KEY = 'list_meta_activation.LIST_META_ACTIVATION';

function installListMetaActivation(engine) {
    if (typeof engine.activation.listMeta === 'function') return;
    registry.get(LIST_META_GATE_KEY);
    engine.activation.listMeta = (block, network, coin) =>
        registry.activeAt(LIST_META_GATE_KEY, network, coin, block, null);
}

function foldCacheFor(engine) {
    if (!engine[foldCacheKey]) engine[foldCacheKey] = createFoldCache();
    return engine[foldCacheKey];
}

function parseMembers(value) {
    if (Array.isArray(value)) return value;
    return JSON.parse(value);
}

function normalizeHeldRows(rows) {
    if (!Array.isArray(rows)) return null;
    try {
        return rows.map(row => ({
            ...row,
            seq: Number(row.seq),
            added: parseMembers(row.added),
            removed: parseMembers(row.removed)
        }));
    } catch (_) {
        return null;
    }
}

function listLabel(chain, rootIndex) {
    return chain + ':' + rootIndex;
}

async function readListAt(engine, chain, rootIndex, originBlock) {
    try {
        const read = await engine.indexerCall(chain, 'getlistat', {
            list_index: rootIndex,
            block: originBlock
        });
        return read && !read.error ? read : null;
    } catch (_) {
        return null;
    }
}

async function heldListState(engine, network, chain, rootIndex, lastSeq) {
    if (lastSeq === 0) return { latest: null, fold: () => null };

    let heldRows;
    try {
        heldRows = normalizeHeldRows(await engine.db.findListSnapshotChain(
            network,
            chain,
            rootIndex,
            lastSeq
        ));
    } catch (_) {
        heldRows = null;
    }
    const latest = heldRows && heldRows.find(row => row.seq === lastSeq);
    if (!latest) return null;

    return {
        latest,
        fold: () => foldCacheFor(engine).get(
            chain,
            rootIndex,
            lastSeq,
            latest.members_hash,
            () => foldListChain(heldRows)
        )
    };
}

async function stampAdmission(engine, row) {
    const readSet = ah.admissionReadSet(
        'list_snapshots',
        row,
        ah.ADMIT_COLUMN_CHAINS
    );
    const admitBlocks = engine.hub && typeof engine.hub.resolveAdmitBlocks === 'function'
        ? await engine.hub.resolveAdmitBlocks('list_snapshots', readSet)
        : null;
    if (!admitBlocks) return false;
    Object.assign(row, ah.admitBlocksToColumns(admitBlocks));
    return true;
}

async function proposeListRow(engine, row, snapshotBlock, network) {
    const validators = await engine.resolveCapabilityValidators(
        'cross_chain',
        Number(snapshotBlock),
        network
    );
    engine._inflight.add(row.snapshot_id);
    try {
        await engine.listConsensus.propose(row.snapshot_id, {
            row,
            snapshot: { validators, count: validators.length }
        });
    } catch (error) {
        engine._inflight.delete(row.snapshot_id);
        throw error;
    }
}

module.exports = {
    async listOriginBlock(chain) {
        let latest;
        try {
            latest = await this.indexerCall(chain, 'getlatestblock', {});
        } catch (_) {
            return null;
        }
        return listOriginBlockFrom(latest, this.confirmations[chain]);
    },

    async pollSharedLists(snapshotBlock) {
        if (this['_polling'] === true) installListMetaActivation(this);
        const network = this.network;
        for (const chain of ALLOWED_CHAINS) {
            if (!this.indexers[chain] || !this.indexers[chain].url) continue;

            const originBlock = await this.listOriginBlock(chain);
            if (originBlock === null) continue;

            let sharedLists;
            try {
                sharedLists = await this.indexerCall(chain, 'getsharedlists', { network });
            } catch (_) {
                continue;
            }
            if (!Array.isArray(sharedLists)) continue;

            for (const entry of listsDue(sharedLists, originBlock)) {
                try {
                    await this.maybeSnapshotList(
                        chain,
                        entry.root_index,
                        originBlock,
                        snapshotBlock
                    );
                } catch (error) {
                    logger.warn('ListShare: round failed for ' +
                        listLabel(chain, entry.root_index) + ': ' +
                        (error && error.message));
                }
            }
        }
    },

    async maybeSnapshotList(chain, rootIndex, originBlock, snapshotBlock) {
        const read = await readListAt(this, chain, rootIndex, originBlock);
        if (!read) return;

        const network = this.network;
        const lastSeq = Number(await this.db.getLatestListSeq(network, chain, rootIndex)) || 0;
        const held = await heldListState(this, network, chain, rootIndex, lastSeq);
        if (!held) {
            logger.warn('ListShare: refusing to sign ' + listLabel(chain, rootIndex) +
                '; its held snapshot chain cannot be read through seq ' + lastSeq);
            return;
        }

        const metaActive = typeof this.activation.listMeta === 'function'
            && this.activation.listMeta(Number(snapshotBlock), network, 'BTC') === true;
        const plan = planListVersion({
            read,
            originBlock,
            held: { lastSeq, ...held },
            metaActive
        });
        if (plan.unchanged) return;
        if (plan.decline) {
            logger.warn('ListShare: declining to sign ' + listLabel(chain, rootIndex) +
                ' because it exceeds LIST_SHARE_MAX_MEMBERS; the previous version stays in force');
            return;
        }
        if (plan.refuse) {
            logger.warn('ListShare: refusing to sign ' + listLabel(chain, rootIndex) +
                ' (' + plan.refuse + '); no snapshot proposed');
            return;
        }

        const row = buildListSnapshotRow({
            version: plan.version,
            network,
            homeChain: chain,
            homeListIndex: rootIndex,
            snapshotBlock
        });
        if (this._inflight.has(row.snapshot_id)) return;

        if (!await stampAdmission(this, row)) {
            logger.warn('ListShare: refusing to open the round for ' +
                listLabel(chain, rootIndex) + '; no fresh admission tip');
            return;
        }
        await proposeListRow(this, row, snapshotBlock, network);
    }
};
