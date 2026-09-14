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
 * XChain Hub - the COLUMN LISTS the hub-DB mirror carries, for the two rails whose
 * writer builds its statement from a list rather than naming columns inline.
 *
 * One place owns what an indexer receives for a finalized bridge transfer and a
 * finalized policy snapshot, which is why these are a list at all: the order is
 * contract (see btc_chain_id below), and a column added in one of the two writers
 * and not the other is the defect the shared list removes.
 *
 * src/db/index.js exposes each as the static it always was, so the write paths in
 * db/bridge_transfers.js and db/policy_snapshots.js keep reading
 * this.constructor.<NAME> and still get a fresh array per read.
 *
 ********************************************************************/

// ---------------------------------------------------------------------------
// Bridge tables (the base bridge spec section 6, token spec section 5,
// policy spec section 5). CrossChainBridgeEngine runs the rounds; the writes and
// the invariant read live in db/bridge_transfers.js and db/policy_snapshots.js,
// and the column lists stay in ONE place so one file owns what the hub-DB mirror
// carries to every indexer. src/db/index.js serves them as the statics the write
// paths read.
// ---------------------------------------------------------------------------

// Columns written for a finalized transfer record. `status` is left to its DDL
// default ('finalized') and `id`/`created_at` are assigned by the table.
const BRIDGE_TRANSFER_COLUMNS = ['transfer_id', 'snapshot_block', 'network', 'src_chain', 'src_action_index',
            'src_address', 'dest_chain', 'dest_address', 'tick', 'decimals', 'amount',
            'effective_time', 'finalizing_view', 'validator_signatures', 'push_generation',
            // The admission map, one column per chain in the row's read set. Inside the
            // signed canonical, so it is written from `row` like every other signed
            // field. Placed BEFORE btc_chain_id because that one stays LAST by contract:
            // it is the only transport-only column and the write path's tests read it
            // off the end of the parameter list.
            'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
            'btc_chain_id'];

// Columns written for a finalized policy snapshot.
const POLICY_SNAPSHOT_COLUMNS = ['snapshot_id', 'snapshot_block', 'origin_chain', 'tick', 'policy_seq',
            'origin_block', 'policy_hash', 'allow_list', 'block_list', 'sleeping',
            'effective_time', 'network', 'finalizing_view', 'validator_signatures',
            'push_generation',
            // Every federation chain, because a policy snapshot's consuming select
            // carries no chain clause: see the note in src/sql/policy_snapshots.sql.
            // Before btc_chain_id, which stays LAST by contract (see the transfer list).
            'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
            'btc_chain_id'];

module.exports = { BRIDGE_TRANSFER_COLUMNS, POLICY_SNAPSHOT_COLUMNS };
