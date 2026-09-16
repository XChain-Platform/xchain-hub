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
 * XChain Hub - admission by height: the measured READ SETS.
 *
 * Which chains read a mirrored row decides which chains its admission map must
 * cover. The table is data only and requires nothing, so it can sit beside
 * lib/admission_height.js without joining the modules that capture the activation
 * twin at load (the ones an arming test purges from the require cache).
 *
 **********************************************************************/

'use strict';

/*
 * `every: true` marks a rail whose consumers carry NO chain clause at all, so
 * every chain the federation serves reads every row. Policy snapshots are the
 * sharp case: its consuming query, SELECT * FROM policy_snapshots WHERE
 * status='finalized' AND network=? AND effective_time<=?, has no chain column
 * in it, so a map covering only the pair's own chains would leave the row
 * unadmitted everywhere else.
 *
 * Per mirrored table: the row fields naming its readers, or EVERY_CHAIN, or a
 * fixed chain list. Sourced from the consuming query in each case, at the
 * indexer-relative path shown (no line numbers where the file has since moved,
 * because a number into a relocated file is worse than no number at all):
 *
 *   cross_chain_matches      db/index.js, hub/hub_db_sync.js           a_chain OR b_chain
 *   cross_chain_calls        db/index.js                               target_chain OR source_chain
 *   bridge_transfers         consensus/bridge_settle.js                dest_chain
 *   policy_snapshots         consensus/bridge_settle.js                no chain clause at all
 *   attestation_responses    XChainIndexer.js:1517 call-site guard     BTC only
 *   anchor_reward_attestations  XChainIndexer.js:1495 same guard       BTC only
 *   oracle_prices            XChainIndexer.js:1336                     every chain
 *   price_snapshots          XChainIndexer.js:1366                     every chain
 *
 * A table absent from this map has no measured read set, and guessing one is the
 * failure this table exists to prevent, so admissionReadSet() throws rather than
 * defaulting.
 */
const ADMISSION_READ_SETS = Object.freeze({
    cross_chain_matches:        Object.freeze({ fields: Object.freeze(['a_chain', 'b_chain']) }),
    cross_chain_calls:          Object.freeze({ fields: Object.freeze(['target_chain', 'source_chain']) }),
    bridge_transfers:           Object.freeze({ fields: Object.freeze(['dest_chain']) }),
    policy_snapshots:           Object.freeze({ every: true }),
    attestation_responses:      Object.freeze({ chains: Object.freeze(['BTC']) }),
    anchor_reward_attestations: Object.freeze({ chains: Object.freeze(['BTC']) }),
    // The one UNSIGNED rail, and the one that takes a scalar rather than a map. It carries no
    // signatures and no canonical, so there is nothing to stamp a map into; its admission
    // height is the PUBLISHING chain's, named by the row's own source_chain, and the barrier
    // certifies it against that chain's watermark rather than the reading chain's own B.
    oracle_prices:              Object.freeze({ publishingChain: true }),
    price_snapshots:            Object.freeze({ every: true }),
});

module.exports = { ADMISSION_READ_SETS };
