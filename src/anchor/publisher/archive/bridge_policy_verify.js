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

const CrossChainBridgeEngine = require('../../../cross_chain/bridge_engine.js');
const { resolveQuorumNetwork } = require('../../quorum_network.js');
const swq = require('../../../consensus/stake_weighted_quorum.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

function comparable(row){
    const out = Object.assign({}, row);
    delete out.id;
    delete out.validator_signatures;
    return out;
}

function policyList(raw){
    if(raw == null) return null;
    try {
        const parsed = JSON.parse(String(raw));
        return Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch(e){
        return undefined;
    }
}

module.exports = {

    async verifyArchivedBridgeTransfer(row){
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
        }
        return this.verifyArchivedBridgePolicyQuorum(row, 'bridge transfer',
                                                      this.bridgeTransferCanonical(row));
    },

    async verifyArchivedPolicySnapshot(row){
        const allow = policyList(row.allow_list);
        const block = policyList(row.block_list);
        if(allow === undefined || block === undefined ||
           CrossChainBridgeEngine.prototype.policyHash.call(
               null, allow, block, Number(row.sleeping) === 1
           ) !== String(row.policy_hash || '').toLowerCase()){
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
