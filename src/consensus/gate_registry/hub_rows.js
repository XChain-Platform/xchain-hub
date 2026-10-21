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
 * moved module can still find its row by name. A row that mirrors an
 * indexer-only gate keeps the indexer's key instead, so set-activation-heights
 * arms both rows in one plan, and a test holds the two values equal.
 *
 * No SHARED-GATES markers on purpose: nothing here is twinned, so
 * reconcile-twins.sh never copies this file and the layout suite grades it
 * apart from the block parts. A hub-only gate that is also read through a
 * computed require stays a carrier under the frozen set; this part only
 * holds its value.
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

// validators/governance/rules
// R2-M2: snapshot-lock the electorate onto each proposal. Below the activation
// height a hub still ATTACHES and PERSISTS a validator_snapshot (harmless,
// additive) but tallies by the legacy live-set rule and accepts snapshotless
// proposals; at/above it the snapshot is REQUIRED and is the tally denominator,
// so validator-set churn between propose() and tally can no longer move the
// quorum/approval goalposts. Same shape + BTC-anchored gating discipline as
// STAKE_WEIGHTED_QUORUM_ACTIVATION. mainnet ARMED 2026-07-16, with the rest of
// that flag-day set: BTC 963000, RE-PINNED 2026-08-12 off 969500
// onto the shared pre-freeze train boundary, the one height the rest of that
// BTC-height cohort now carries; deploy every hub before this era.
addGate('validators/governance/rules.GOV_SNAPSHOT_ACTIVATION', 'height', { mainnet: 963000, testnet: 0, regtest: 0 });

// Ranked tally failover: at/above the height a lower-ranked validator may tally
// a proposal the leader left in voting. Regtest is armed from genesis and
// testnet from its cut height; mainnet stays unpinned until ratified.
addGate('validators/governance/rules.GOV_TALLY_FAILOVER_ACTIVATION', 'height', { mainnet: UNPINNED, testnet: 156230, regtest: 0 });

addGate('cross_chain/bridge/proof_ready_snapshot.BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 156230, 'LTC:testnet': 4912984, 'DOGE:testnet': 67989993, testnet: UNARMED, regtest: 0 });

// Height on a DOGE or LTC source leg's own block_index. From it a lock of a bare token native
// to that chain is stamped one below the snapshot_block of the first finalized origin
// checkpoint covering it, and held until one exists, so the destination indexer's escrow
// cross-check (BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION, first checkpoint strictly above the
// stamp) finds it at once instead of stalling a block for the next round. Arm it at or before
// that indexer row: a stamp ahead of the indexer's flag day is refused there exactly as a tip
// stamp is, while an armed indexer facing tip stamps waits up to a cadence on every such lock.
// Unarmed live; regtest from genesis, as the indexer row.
addGate('cross_chain/bridge/proof_ready_snapshot.BRIDGE_ANCHOR_PROOF_READY_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 157235, 'LTC:testnet': 4930600, 'DOGE:testnet': 68012800, testnet: UNARMED, regtest: 0 });

// peers/hub_db/landing_watermark
// Landed-from-clear-frontier: at/above the activation, in the landing indexer's
// block height, the hub publishes landed[chain] from the indexer's
// price_landing_clear reading whenever it is ahead of hub_push_delivered. Below
// it, only hub_push_delivered feeds the watermark. Armed on regtest and on each
// testnet chain; mainnet stays dark until the operator names its height.
addGate('peers/hub_db/landing_watermark.LANDING_CLEAR_FRONTIER_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 156230, 'LTC:testnet': 4912984, 'DOGE:testnet': 67989993, testnet: UNARMED, regtest: 0 });

// anchor/reorg_handler/snapshot_lock
// Reorg rollback rounds stamp a BTC height and derive membership and quorum from
// its federation snapshot. The wire fields stay dark on mainnet until a
// coordinated release; testnet carries them from its cut height and regtest
// exercises them from genesis.
addGate('anchor/reorg_handler/snapshot_lock.REORG_SNAPSHOT_ACTIVATION', 'height', { mainnet: UNARMED, testnet: 156230, regtest: 0 });

// Reorg digest v2 keeps the stamped round bound to its replacement hash and
// BTC snapshot height without binding it to a reporter-specific orphan hash.
// Regtest exercises the form from genesis; public networks wait for a
// coordinated activation.
addGate('anchor/reorg_handler/snapshot_round.REORG_DIGEST_V2_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 157073, 'LTC:testnet': 4928460, 'DOGE:testnet': 68009330, testnet: 157073, regtest: 0 });

// Effective allow/block-list enforcement: armed on testnet, inert on mainnet
// and regtest until coordinated activation. A regtest venue arms it at read
// time from XC_OFFER_LIST_REGTEST_ACTIVATION (the entry, gate_registry.js,
// carries that overlay because this part is data only).
addGate('cross_chain/dex/offer_lists.CROSS_CHAIN_OFFER_LIST_ENFORCEMENT', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 156230,
    'LTC:testnet': 4912984,
    'DOGE:testnet': 67989993,
    testnet: 156230,
    regtest: UNARMED,
});

// consensus/federation
// Extends federation detection beyond live quorum at the anchor height.
// Armed on regtest and testnet; mainnet waits on coordinated activation.
addGate('consensus/federation.FEDERATED_HUB_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 156230, 'LTC:testnet': 4912984, 'DOGE:testnet': 67989993, testnet: 156230, regtest: 0 });

// oracle/consensus/commit
// Count-mode quorum uses the verified signer set at and above this BTC height.
addGate('oracle/consensus/commit.COUNT_QUORUM_SIGNED_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 157073, 'LTC:testnet': 4928460, 'DOGE:testnet': 68009330, testnet: UNARMED, regtest: 0 });

addGate('anchor/publisher/bundle_done.BUNDLE_DONE_PUBLISHER_BIND_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 157073, 'LTC:testnet': 4928460, 'DOGE:testnet': 68009330, testnet: 157073, regtest: 0 });

addGate('anchor/snapshot_checkpoint/engine.SNAPSHOT_CHECKPOINT_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 157073, 'LTC:testnet': 4928460, 'DOGE:testnet': 68009330, testnet: UNARMED, regtest: 0 });

// Read by anchor/publisher/reward_defer.js under the indexer's key.
// The indexer's archive fold-term gate, copied so the reward drain screens the same anchor_archive
// rows the indexer screens. It keeps the indexer's key so set-activation-heights arms both rows at once;
// reward_drain_archive_term.test.js holds the two values equal.
addGate('anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION', 'height', { mainnet: UNARMED, 'BTC:testnet': 156230, 'LTC:testnet': 4912984, 'DOGE:testnet': 67989993, testnet: UNARMED, regtest: 0 });

// anchor/publisher/legacy_reward_pin: the time columns of the indexer's LEGACY_ANCHOR_REWARD_PIN protocol change.
// It keeps the hub's own key, since the activation census refuses a hub time row under a change key and
// set-activation-heights arms only the indexer row; reward_drain_legacy_pin.test.js holds the two equal.
addGate('anchor/publisher/legacy_reward_pin.LEGACY_ANCHOR_REWARD_PIN', 'time', { mainnet: UNARMED, testnet: 1792454400, regtest: UNARMED });
