/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - archived bridge transfer and policy verification
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../../../consensus/gate_registry.js');
const { parsePolicyColumn } = require('../../../../cross_chain/bridge/policy_column.js');
const { policyHash } = require('../../../../cross_chain/bridge/policy_hash.js');
const { resolveQuorumNetwork } = require('../../../quorum_network.js');
const swq = require('../../../../consensus/stake_weighted_quorum.js');
const { getLogger } = require('../../../../observability');
const logger = getLogger();

function comparable(row){
    const out = Object.assign({}, row);
    delete out.id;
    delete out.validator_signatures;
    return out;
}

const LIST_SHARE_PRODUCER_GATE = 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION';

function policyList(raw, refsAllowed){
    return parsePolicyColumn(raw, refsAllowed);
}

// Either case: validate.js co-signs an id case-insensitively, so a held row may carry upper case.
const HEX64 = /^[0-9a-f]{64}$/i;

// The reason a row does not belong in its archive array, or null. The shared canonical
// picks XBRIDGE or XPOLICY by which id the row carries and throws on both, so a row
// filed under the wrong array would otherwise verify as the other kind or throw.
function rowShapeRefusal(row, idKey, otherKey){
    if(!row || typeof row !== 'object' || Array.isArray(row)) return 'is not a row object';
    // Require this array's own id as a derived sha256 hex id
    // (a held row refused here is re-selected every wake, so this must admit every id quorum signs)
    if(typeof row[idKey] !== 'string' || !HEX64.test(row[idKey])) return 'has a malformed ' + idKey;
    // Refuse a row that also carries the other kind's id
    const other = row[otherKey];
    if(other !== undefined && other !== null && other !== '') return 'also carries ' + otherKey;
    return null;
}

// Record that a row this hub never held was accepted on its signature quorum alone.
function logUnheld(label, id){
    logger.info('StateAnchorPublisher: archive ' + label + ' ' + String(id).substring(0, 16) +
                '... predates our local history; accepting on signature quorum alone');
}

module.exports = {

    async verifyArchivedBridgeTransfer(row){
        // Refuse a row that is not a transfer before any lookup or canonical
        const shape = rowShapeRefusal(row, 'transfer_id', 'snapshot_id');
        if(shape){
            logger.warn('StateAnchorPublisher: archive bridge transfer ' +
                        String(row && row.transfer_id).substring(0, 16) +
                        '... ' + shape + '; NOT signing');
            return false;
        }
        const held = await this.db.getBridgeTransferByTransferId(row.transfer_id);
        if(held && held.length){
            const local = comparable(this.serializeBridgeTransfer(held[0]));
            const archived = comparable(row);
            if(JSON.stringify(local) !== JSON.stringify(archived)){
                logger.warn('StateAnchorPublisher: archive bridge transfer ' +
                            String(row.transfer_id).substring(0, 16) +
                            '... TERMS differ from our row; NOT signing');
                return false;
            }
        } else {
            logUnheld('bridge transfer', row.transfer_id);
        }
        return this.verifyArchivedBridgePolicyQuorum(row, 'bridge transfer',
                                                      this.bridgeTransferCanonical(row));
    },

    async verifyArchivedPolicySnapshot(row){
        // Refuse a row that is not a policy snapshot before any lookup or canonical
        const shape = rowShapeRefusal(row, 'snapshot_id', 'transfer_id');
        if(shape){
            logger.warn('StateAnchorPublisher: archive policy snapshot ' +
                        String(row && row.snapshot_id).substring(0, 16) +
                        '... ' + shape + '; NOT signing');
            return false;
        }
        const refsAllowed = gateRegistry.activeAt(LIST_SHARE_PRODUCER_GATE,
            row.network, 'BTC', Number(row.snapshot_block), null);
        const allow = policyList(row.allow_list, refsAllowed);
        const block = policyList(row.block_list, refsAllowed);
        const members = side => Array.isArray(side) ? side : null;
        const refs = {
            allow: allow && !Array.isArray(allow) ? allow.ref : null,
            block: block && !Array.isArray(block) ? block.ref : null
        };
        if(allow === undefined || block === undefined ||
           policyHash(members(allow), members(block), Number(row.sleeping) === 1, refs) !==
               String(row.policy_hash || '').toLowerCase()){
            logger.warn('StateAnchorPublisher: archive policy snapshot ' +
                        String(row.snapshot_id).substring(0, 16) +
                        '... membership does not match policy_hash; NOT signing');
            return false;
        }
        const held = await this.db.getPolicySnapshotBySnapshotId(row.snapshot_id);
        if(held && held.length){
            const local = comparable(this.serializePolicySnapshot(held[0]));
            const archived = comparable(row);
            if(JSON.stringify(local) !== JSON.stringify(archived)){
                logger.warn('StateAnchorPublisher: archive policy snapshot ' +
                            String(row.snapshot_id).substring(0, 16) +
                            '... TERMS differ from our row; NOT signing');
                return false;
            }
        } else {
            logUnheld('policy snapshot', row.snapshot_id);
        }
        return this.verifyArchivedBridgePolicyQuorum(row, 'policy snapshot',
                                                      this.policySnapshotCanonical(row));
    },

    async verifyArchivedBridgePolicyQuorum(row, label, canonical){
        const network = resolveQuorumNetwork(row, this.network);
        const set = await this.resolveCapabilitySet('cross_chain', Number(row.snapshot_block), network);
        const sigs = this.parseSigs(row.validator_signatures);
        const weighted = swq.isStakeWeightedQuorumActive(Number(row.snapshot_block), network);
        if(!this.quorumVerified(canonical, sigs, set, weighted)){
            const id = row.transfer_id || row.snapshot_id;
            logger.warn('StateAnchorPublisher: archive ' + label + ' ' +
                        String(id).substring(0, 16) +
                        '... fails signature quorum against the cross_chain set at block ' +
                        row.snapshot_block);
            return false;
        }
        return true;
    }

};
