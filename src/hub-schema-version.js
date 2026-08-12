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
 * cannot interpret, and equally when the mirror SET itself gains a table (a table
 * a stale indexer does not know about is a row shape it cannot interpret either,
 * it just fails by omission instead of by column). As of now that set is seven
 * tables: oracle_prices, price_snapshots, cross_chain_matches, cross_chain_calls,
 * capability_snapshots, state_checkpoints, anchor_reward_attestations (see
 * xchain-indexer/src/hub_db_sync.js RETRACTION_COLUMNS + CROSS_CHAIN_TABLES +
 * HUB_STATE_TABLES). oracle_prices and cross_chain_matches gate the settlement
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
//
// v3 : the mirror set gained anchor_reward_attestations (hub_db_sync
// HUB_STATE_TABLES). It carries the XANCPUB publisher-attestation quorum the BTC
// indexer derives the COLLECT-spendable anchor/archive reward from, so an indexer
// that predates it does not merely miss rows, it under-derives a money rail while
// still advertising a matching handshake. v2 was never bumped for that table, so a
// pre- indexer accepted a current hub instead of failing closed; v3 restores
// the gate. A stale indexer must reject this stream until it has applied the
// 2026-07-21 anchor-reward-attestations migration.
const HUB_SCHEMA_VERSION = 3;

module.exports = { HUB_SCHEMA_VERSION };
