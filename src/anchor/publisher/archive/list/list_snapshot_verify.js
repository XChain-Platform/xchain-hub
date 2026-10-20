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
 **********************************************************************
 *
 * ANCHOR publisher - archived shared-list snapshot verification
 *
 ********************************************************************/

'use strict';

const listCanonical = require('../../../../cross_chain/list/canonical.js');
const { archivedListRowRefusal } = require('../../../../cross_chain/list/archive_checks.js');
const { getLogger } = require('../../../../observability');
const logger = getLogger();

function comparable(row){
    const out = Object.assign({}, row);
    delete out.id;
    delete out.validator_signatures;
    return out;
}

function sameList(a, b){
    return String(a.network) === String(b.network) &&
        String(a.home_chain) === String(b.home_chain) &&
        Number(a.home_list_index) === Number(b.home_list_index);
}

// Reduce a held or archived row to the fields the list fold reads; null when a delta is unparseable
function foldEntry(row){
    try {
        return {
            seq: Number(row.seq),
            kind: row.kind,
            added: Array.isArray(row.added) ? row.added : JSON.parse(row.added),
            removed: Array.isArray(row.removed) ? row.removed : JSON.parse(row.removed),
            members_hash: row.members_hash
        };
    } catch(_e){
        return null;
    }
}

// Seq 1 to seq-1 of the row's list: our own finalized rows first, then the same list's rows in this archive
function predecessorChain(row, heldRows, archive){
    const seq = Number(row.seq);
    const bySeq = new Map();
    for(const candidate of ((archive && archive.list_snapshots) || [])){
        if(sameList(candidate, row) && Number(candidate.seq) < seq) bySeq.set(Number(candidate.seq), candidate);
    }
    for(const candidate of (heldRows || [])){
        if(Number(candidate.seq) < seq) bySeq.set(Number(candidate.seq), candidate);
    }
    const chain = [];
    for(let s = 1; s < seq; s++){
        if(!bySeq.has(s)) return null;
        chain.push(bySeq.get(s));
    }
    return chain;
}

module.exports = {

    listSnapshotCanonical(row){
        return listCanonical.listSnapshotCanonical(row, row.finalizing_view);
    },

    // A delta row we never wrote must fold onto its predecessors: the signature covers the
    // members_hash after the delta but not the added and removed arrays themselves.
    async unheldListDeltaRefusal(row, archive){
        const heldRows = await this.db.findListSnapshotChain(
            row.network, row.home_chain, Number(row.home_list_index), Number(row.seq) - 1);
        const chain = predecessorChain(row, heldRows, archive);
        if(!chain) return 'delta has no complete predecessor chain here or in the archive';
        const entries = chain.concat([row]).map(foldEntry);
        if(entries.some(entry => entry === null)) return 'delta chain carries an unparseable added or removed array';
        // Each fold step must reproduce that row's signed members_hash
        if(listCanonical.foldListChain(entries) === null) return 'delta does not fold onto its predecessor chain';
        return null;
    },

    async verifyArchivedListSnapshot(row, archive){
        const refusal = archivedListRowRefusal(row);
        if(refusal){
            logger.warn('StateAnchorPublisher: archive list snapshot ' +
                        String(row && row.snapshot_id).substring(0, 16) +
                        '... ' + refusal + '; NOT signing');
            return false;
        }

        const held = await this.db.getListSnapshotBySnapshotId(row.snapshot_id);
        if(held && held.length){
            const local = comparable(this.serializeListSnapshot(held[0]));
            const archived = comparable(row);
            if(JSON.stringify(local) !== JSON.stringify(archived)){
                logger.warn('StateAnchorPublisher: archive list snapshot ' +
                            String(row.snapshot_id).substring(0, 16) +
                            '... TERMS differ from our row; NOT signing');
                return false;
            }
        } else {
            // A full version we never wrote rests on the signature quorum below; a delta must also fold
            const deltaRefusal = Number(row.seq) > 1 ? await this.unheldListDeltaRefusal(row, archive) : null;
            if(deltaRefusal){
                logger.warn('StateAnchorPublisher: archive list snapshot ' +
                            String(row.snapshot_id).substring(0, 16) +
                            '... ' + deltaRefusal + '; NOT signing');
                return false;
            }
            logger.info('StateAnchorPublisher: archive list snapshot ' +
                        String(row.snapshot_id).substring(0, 16) +
                        '... predates our local history; accepting on signature quorum alone');
        }

        return this.verifyArchivedBridgePolicyQuorum(
            row, 'list snapshot', this.listSnapshotCanonical(row));
    }

};
