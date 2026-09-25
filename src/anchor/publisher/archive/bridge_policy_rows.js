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
 * ANCHOR publisher - archived bridge transfer and policy snapshot rows
 *
 * The fixed-key-order serializers for the two cross_chain hub-mirror tables an archive
 * carries beside matches, and the canonicals their signatures cover.
 *
 ********************************************************************/

'use strict';

const CrossChainBridgeEngine = require('../../../cross_chain/bridge_engine.js');
const { BRIDGE_KEYS, POLICY_KEYS } = require('../constants.js');

const INTEGER_KEYS  = new Set(['id', 'snapshot_block', 'src_action_index', 'decimals', 'effective_time',
                               'policy_seq', 'origin_block']);
const NULLABLE_INTS = new Set(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']);
const NULLABLE_TEXT = new Set(['allow_list', 'block_list']);

// One archived value under the rule its column follows. The nullable admission columns
// stay null rather than 0, because the canonicals tell an unbound row from height 0.
function archivedValue(key, v){
    if(INTEGER_KEYS.has(key)) return Number(v);
    if(NULLABLE_INTS.has(key)) return v == null ? null : Number(v);
    if(NULLABLE_TEXT.has(key)) return v == null ? null : String(v);
    if(key === 'finalizing_view') return Number(v) || 0;
    if(key === 'sleeping') return Number(v) ? 1 : 0;
    if(key === 'validator_signatures') return v;
    return String(v == null ? '' : v);
}

function serializeByKeys(keys, row){
    let out = {};
    for(let k of keys) out[k] = archivedValue(k, row[k]);
    return out;
}

module.exports = {

    serializeBridgeTransfer(r){
        return serializeByKeys(BRIDGE_KEYS, r);
    },

    serializePolicySnapshot(r){
        return serializeByKeys(POLICY_KEYS, r);
    },

    // Copy of `rows` in ascending order of `idKey`; the archive array order every hub
    // must reproduce byte for byte.
    sortedArchiveRows(rows, idKey){
        return (rows || []).slice().sort((a, b) => {
            let x = String(a[idKey]), y = String(b[idKey]);
            return x < y ? -1 : x > y ? 1 : 0;
        });
    },

    // XBRIDGE canonical of an archived transfer, the engine's own so the archive can
    // never sign a different form than the hub produced.
    bridgeTransferCanonical(r){
        return CrossChainBridgeEngine.prototype.canonicalMatch.call(null, r, r.finalizing_view);
    },

    // XPOLICY canonical of an archived policy snapshot.
    policySnapshotCanonical(r){
        return CrossChainBridgeEngine.prototype.canonicalMatch.call(null, r, r.finalizing_view);
    },

    async backfillBridgePolicyRows(batchSeq, txid, bridgeIds, policyIds){
        for(const bridge of (bridgeIds || []))
            await this.db.updateBridgeTransferArchiveBatchSeq(
                batchSeq, bridge.status, txid, bridge.transfer_id);
        for(const policy of (policyIds || []))
            await this.db.updatePolicySnapshotArchiveBatchSeq(batchSeq, txid, policy.snapshot_id);
    }

};
