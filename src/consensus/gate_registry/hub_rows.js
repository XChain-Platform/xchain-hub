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
 * Hub-only registry rows: the flag-day tables this hub alone judges.
 *
 * The shared_rows_N.js parts beside this one carry the SHARED block, the rows
 * every consumer of this platform judges, as byte twins of the indexer's.
 * This part carries the rows no other repo twins, in the same shape: one
 * `addGate(key, unit, table)` call per row at column zero, the literal carried
 * over from its module with the comment that explains it, so the table lives
 * in ONE place in this repo and the module keeps its predicate and reads the
 * row back through get(). A key is the module's path under src/ joined to
 * the export name, the spelling the indexer's own non-twin rows use, so a
 * moved module can still find its row by name.
 *
 * No SHARED-GATES markers on purpose: nothing here is twinned, so
 * reconcile-twins.sh never copies this file and the layout suite grades it
 * apart from the block parts. A hub-only gate that is also read through a
 * computed require stays a carrier under the frozen set; this part only
 * holds its value.
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED } = require('./shared_rows.js');

addGate('validators/governance/rules.GOV_SNAPSHOT_ACTIVATION', 'height', { mainnet: 963000, testnet: 0, regtest: 0 });

addGate('cross_chain/bridge/proof_ready_snapshot.BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION', 'height', { mainnet: UNARMED, testnet: UNARMED, regtest: 0 });

// Effective allow/block-list enforcement, inert until coordinated activation.
addGate('cross_chain/dex/offer_lists.CROSS_CHAIN_OFFER_LIST_ENFORCEMENT', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNARMED,
});
