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
 * when any mirrored table (cross_chain_calls, price_snapshots,
 * capability_snapshots, state_checkpoints) gains a DDL change a stale indexer
 * cannot interpret; the indexer rejects a mismatch so a hub-side column added
 * before the indexer migrates cannot be silently dropped and fork the ledger.
 *
 ********************************************************************/

const HUB_SCHEMA_VERSION = 1;

module.exports = { HUB_SCHEMA_VERSION };
