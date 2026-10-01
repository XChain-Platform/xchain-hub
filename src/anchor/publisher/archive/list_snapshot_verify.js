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

const listCanonical = require('../../../cross_chain/list/canonical.js');
const { archivedListRowRefusal } = require('../../../cross_chain/list/archive_checks.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

function comparable(row){
    const out = Object.assign({}, row);
    delete out.id;
    delete out.validator_signatures;
    return out;
}

module.exports = {

    listSnapshotCanonical(row){
        return listCanonical.listSnapshotCanonical(row, row.finalizing_view);
    },

    async verifyArchivedListSnapshot(row){
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
        }

        return this.verifyArchivedBridgePolicyQuorum(
            row, 'list snapshot', this.listSnapshotCanonical(row));
    }

};
