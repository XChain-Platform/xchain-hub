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
 * XChain Hub - the TIMESTAMP -> DATETIME column list an already-deployed hub
 * needs migrated in place; a fresh install gets DATETIME straight from src/sql.
 *
 * TIMESTAMP is bounded by the signed 32-bit epoch (2038-01-19 03:14:07 UTC).
 * alterTableForDrift never MODIFYs a column's type, so this list is the only
 * path that reaches a table already created with the old type.
 *
 ********************************************************************/

const DATETIME_COLUMNS = Object.freeze([
    { table: 'anchor_published_archives',    column: 'intent_at',      columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'anchor_published_archives',    column: 'sent_at',        columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'anchor_published_archives',    column: 'settled_at',     columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'anchor_published_checkpoints', column: 'intent_at',      columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'anchor_published_checkpoints', column: 'sent_at',        columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'anchor_reward_attestations',   column: 'created_at',     columnDef: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    { table: 'archive_price_tombstones',     column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'attest_published_batches',     column: 'intent_at',      columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'attest_published_batches',     column: 'sent_at',        columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'attest_published_batches',     column: 'landed_at',      columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'attest_published_requests',    column: 'intent_at',      columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'attest_published_requests',    column: 'sent_at',        columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'attestation_fetch_cache',      column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'attestation_validator_stats',  column: 'checked_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'attestations',                 column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'attestations',                 column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'bridge_transfers',             column: 'created_at',     columnDef: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    { table: 'capability_snapshots',         column: 'created_at',     columnDef: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    { table: 'configs',                      column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'consensus_state',              column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'cross_chain_calls',            column: 'created_at',     columnDef: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    { table: 'cross_chain_matches',          column: 'created_at',     columnDef: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    { table: 'governance_proposals',         column: 'applied_at',     columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'governance_proposals',         column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'governance_votes',             column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'oracle_prices',                column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'oracle_published_rounds',      column: 'intent_at',      columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'oracle_published_rounds',      column: 'sent_at',        columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'oracle_submissions',           column: 'submitted_at',   columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'p2p_peers',                    column: 'last_seen_at',   columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'p2p_peers',                    column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'p2p_peers',                    column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'policy_snapshots',             column: 'created_at',     columnDef: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    { table: 'price_ingest_watermarks',      column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'price_snapshots',              column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'reorg_attestations',           column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'reorg_attestations',           column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'slash_proposals',              column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'state_checkpoints',            column: 'created_at',     columnDef: 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' },
    { table: 'swap_records',                 column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'swap_records',                 column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'telemetry_pings',              column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'validator_capabilities',       column: 'self_test_at',   columnDef: 'DATETIME NULL DEFAULT NULL' },
    { table: 'validator_capabilities',       column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'validator_capabilities',       column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },
    { table: 'validator_rewards',            column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'validators',                   column: 'created_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { table: 'validators',                   column: 'updated_at',     columnDef: 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' }
]);

module.exports = { DATETIME_COLUMNS };
