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
 * it just fails by omission instead of by column). As of now that set is ten
 * tables: oracle_prices, price_snapshots, cross_chain_matches, cross_chain_calls,
 * capability_snapshots, state_checkpoints, anchor_reward_attestations,
 * attestation_responses, bridge_transfers, policy_snapshots (see
 * xchain-indexer/src/hub_db_sync.js RETRACTION_COLUMNS +
 * CROSS_CHAIN_TABLES + HUB_STATE_TABLES). oracle_prices and cross_chain_matches gate the settlement
 * barriers waitForOracleSyncTimestamp / waitForMatchSync, so omitting them here
 * is a ledger-fork risk. The indexer rejects a version mismatch so a hub-side
 * column added before the indexer migrates cannot be silently dropped and fork
 * the ledger.
 *
 ********************************************************************/

// v2: capability_snapshots.uq_cap_snap gained `source`, so a key
// delegated by two sources keeps BOTH (source, pubkey) rows in the mirror stream
// instead of collapsing to one. A stale indexer on the 3-column key would
// INSERT-IGNORE-drop the second source row and understate stake, so it must
// reject a v2 snapshot stream until it has migrated.
//
// v3: the mirror set gained anchor_reward_attestations (hub_db_sync
// HUB_STATE_TABLES). It carries the XANCPUB publisher-attestation quorum the BTC
// indexer derives the COLLECT-spendable anchor/archive reward from, so an indexer
// that predates it does not merely miss rows, it under-derives a money rail while
// still advertising a matching handshake. v2 was never bumped for that table, so
// an indexer predating v3 accepted a current hub instead of failing closed; v3 restores
// the gate. A stale indexer must reject this stream until it has applied the
// 2026-07-21 anchor-reward-attestations migration.
//
// v4: anchor_reward_attestations gained doge_anchor_txid, the MINED DOGE anchor
// each attested reward is proof-bound to. It is the column every independent
// re-proof binds against (a peer's XANCREWARD check, the BTC indexer's
// getanchorconfirmations check before it mints validator_rewards), so an indexer
// that predates it silently loses the bind and is back to deriving a
// COLLECT-spendable reward for an anchor it cannot show ever landed. Fail closed
// instead: a stale indexer must reject this stream until it has applied the
// 2026-08-13-anchor-reward-attestations-doge-anchor-txid migration.
//
// v5: the mirror set gained attestation_responses (hub_db_sync
// HUB_STATE_TABLES). It carries a finalized ATTEST response, signed by the
// responsible set over the mirror-era canonical, so the response no longer
// needs a validator-paid on-chain ATTEST v1 transaction and its Bitcoin fee
// (the ATTEST response mirror design). A stale indexer does not
// merely miss rows here: without the table it never learns that a response
// finalized at all, so the request it is waiting on times out instead of
// resolving. A stale indexer must reject this stream until it has applied
// the 2026-09-03-attestation-responses migration.
//
// v6: the mirror set gained bridge_transfers and policy_snapshots (hub_db_sync
// CROSS_CHAIN_TABLES). bridge_transfers carries the cross_chain quorum's signed
// transfer record, which the destination indexer injects as the XBRIDGE settle leg
// that credits an address and moves that chain's supply; policy_snapshots carries
// the signed origin-token policy a destination materializes onto a bridged copy. A
// stale indexer does not merely miss rows: without bridge_transfers the bridge
// barrier never opens, so a transfer whose source leg has ALREADY debited on the
// other chain is never applied there and the escrow behind it is held against
// nothing. A stale indexer must reject this stream until it has applied the
// 2026-09-12-bridge-tables migration.
//
// ROLL ORDER MATCHES THE CROSS-CHAIN PRECEDENT'S "hub first" (measured on the
// regtest rail 2026-09-12). The
// version check is strict equality in both directions, so rolling this hub last
// does not avoid a halt, it only moves the halt onto the hub instead of the
// readers: a v6 explorer against a standing v5 hub refused every mirror row
// with "HubDbSync: hub schema_version 5 != local 6 for price_snapshots;
// refusing to apply row". This hub rolls FIRST and stamps 6, then every indexer
// and the explorer roll back to back behind it (regtest measured about 2.5
// minutes per indexer image for that window).
const HUB_SCHEMA_VERSION = 6;

module.exports = { HUB_SCHEMA_VERSION };
