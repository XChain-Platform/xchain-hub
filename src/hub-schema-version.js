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
 * XChain Hub - Hub DB mirror schema version
 *
 * Single source of truth for the schema-version handshake stamped on every
 * mirror row the hub streams (and snapshots over REST) to indexers. Bump this
 * when ANY table in the indexer's mirror set gains a DDL change a stale indexer
 * cannot interpret. As of now that set is six tables: oracle_prices,
 * price_snapshots, cross_chain_matches, cross_chain_calls, capability_snapshots,
 * state_checkpoints (see xchain-indexer/src/hub_db_sync.js RETRACTION_COLUMNS +
 * CROSS_CHAIN_TABLES). oracle_prices and cross_chain_matches gate the settlement
 * barriers waitForOracleSyncTimestamp / waitForMatchSync, so omitting them here
 * is a ledger-fork risk. The indexer rejects a version mismatch so a hub-side
 * column added before the indexer migrates cannot be silently dropped and fork
 * the ledger.
 *
 ********************************************************************/

// v2 : capability_snapshots.uq_cap_snap gained `source`, so a key
// delegated by two sources keeps BOTH (source, pubkey) rows in the mirror stream
// instead of collapsing to one. A stale indexer on the 3-column key would
// INSERT-IGNORE-drop the second source row and understate stake, so it must
// reject a v2 snapshot stream until it has migrated.
const HUB_SCHEMA_VERSION = 2;

module.exports = { HUB_SCHEMA_VERSION };
