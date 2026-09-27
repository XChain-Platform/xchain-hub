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
 * XChain Hub - ANCHOR constants
 *
 * The wire tags, byte budgets, serialization orders and retention defaults the
 * ANCHOR publisher and its part modules share. One definition each, so a value
 * a part reads can never drift from the one the class was built with.
 *
 ********************************************************************/

'use strict';

const ark = require('../anchor_reward_key.js');

// The reward types the indexer re-derives from chain above a flag-day, split by WHICH
// flag-day judges them. One definition, read by both forms of the eligibility rule
// (isChainDerivedReward and its SQL twin), so a new type cannot be added to one alone.
const ANCHOR_FLAG_DAY_REWARD_TYPES = ['anchor_BTC', 'anchor_LTC', 'anchor_DOGE', 'anchor_bundle'];
const ARCHIVE_FLAG_DAY_REWARD_TYPE = ark.ARCHIVE_REWARD_TYPE;

const XANC_SIGN_REQ  = 'XANC_SIGN_REQ';
const XANC_SIGN      = 'XANC_SIGN';
const XANC_FINALIZED = 'XANC_FINALIZED';
const XANC_BUNDLE_DONE = 'XANC_BUNDLE_DONE';
// Publisher-attestation round (anchor-reward re-derivation flag-day): the elected
// bundle publisher collects a 2f+1 oracle_publish quorum ATTESTING that it is the
// legitimate reward earner, carried on-chain in the ANCHOR v0 tail so the indexer
// DERIVES the reward instead of trusting the forgeable push. Mirrors XANC_SIGN_REQ/SIGN.
const XANCPUB_SIGN_REQ = 'XANCPUB_SIGN_REQ';
const XANCPUB_SIGN     = 'XANCPUB_SIGN';

// Archive publisher-attestation round (archive-reward re-derivation flag-day):
// the elected ARCHIVE leader collects a 2f+1 oracle_publish quorum attesting that it is
// the anchor_archive reward earner, carried on-chain in the ANCHOR v1 tail so the indexer DERIVES
// the archive reward and the last key-authenticated push is retired. Mirrors
// XANCPUB_SIGN_REQ/SIGN for the archive leg.
const XANCARCHPUB_SIGN_REQ = 'XANCARCHPUB_SIGN_REQ';
const XANCARCHPUB_SIGN     = 'XANCARCHPUB_SIGN';

// Reward-attestation federation (derive-relocation flag-day). The
// anchor_reward_attestations row is written ONLY by the elected publisher, and hub_db_sync
// carries it to that hub's OWN indexer subscribers and nowhere else, so a federation whose
// publisher rotates per checkpoint leaves every hub holding a disjoint subset and every
// indexer deriving only what its own hub happened to publish. This message closes that: the
// publisher broadcasts the confirmed row, and every receiver re-verifies the XANCPUB quorum
// against its OWN oracle_publish set at snapshot_block and re-proves the DOGE anchor mined
// before writing its copy. The wire is TRANSPORT, never trust: nothing a receiver writes is
// taken from the message except the tuple identity it independently re-derives the canonical
// from, and the frozen reward amount is never read off the wire at all.
const XANCREWARD = 'XANCREWARD';

// The hard on-chain ceiling on one action's data, from
// xchain-documentation/protocol/constants.js. The DECODER is the arbiter and silently
// DROPS a larger action, so an oversize bundle is lost fleet-wide rather than rejected
// loudly. Local copy so the hub can measure without a sibling checkout.
const MAX_ACTION_DATA_LENGTH = 8192;
// The encoder compiles the raw payload text into a push whose prefix costs 3 bytes
// (xchain-encoder/src/validator.js), so compiled size IS raw text + 3.
const OP_RETURN_PUSH_OVERHEAD = 3;
// The byte budget a v0 bundle's raw text must stay within (D10). Overflow is SPLIT
// chain-ascending, never dropped; a single section that cannot fit with the attestation
// tail its bundle will carry is refused loudly and counted (bundlesOversize).
const ANCHOR_BUNDLE_MAX_BYTES = MAX_ACTION_DATA_LENGTH - OP_RETURN_PUSH_OVERHEAD;   // 8189
// Wire cost of one (PUBKEY, SIG) pair: '|' + 64-hex pubkey + '|' + 128-hex Ed25519
// signature. Fixed width, which is what lets the split arithmetic size an attestation
// tail before the round that fills it has run.
const ANCHOR_SIG_PAIR_BYTES = 1 + 64 + 1 + 128;   // 194

// Default retention window for anchor_published_checkpoints and
// anchor_published_archives, mirroring OraclePublisher's ~90-day
// oracle_published_rounds window.
const DEFAULT_ANCHOR_MARKER_RETENTION_MS = 7776000000;   // 90 days
// Multiple of anchorIntentTtlMs the effective window is FLOORED at. The TTL is the
// exact horizon past which anchorIntentHolds already answers false, so the multiple
// is pure margin over a re-armed intent, not the safety property itself.
const ANCHOR_MARKER_RETENTION_TTL_SAFETY = 8;

// Fixed serialization order for an archived match row (the crc32 and the
// follower byte-comparison depend on this exact order). Spec §Archive JSON.
// `id` (the hub-assigned mirror cursor) is archived for per-hub provenance
// only; settlement order is (snapshot_block, match_id), never `id`, because a
// per-hub AUTO_INCREMENT must not order consensus state (xchain-indexer
// db/index.js getEffectiveUnsettledMatches). Recovery rebuilds the row under its
// original id to preserve archive byte-parity, not to fix a settlement order
// (xchain-indexer recovery.js). Archives published before this field exist
// without it; recovery tolerates both shapes.
const MATCH_KEYS = ['id', 'match_id', 'snapshot_block', 'network',
    'a_chain', 'a_action_index', 'a_kind', 'a_tick', 'a_amount', 'a_filled_before', 'a_ownership', 'a_payout_addr', 'a_payout_legs',
    'b_chain', 'b_action_index', 'b_kind', 'b_tick', 'b_amount', 'b_filled_before', 'b_ownership', 'b_payout_addr', 'b_payout_legs',
    'effective_time', 'finalizing_view', 'validator_signatures', 'status'];

// Fixed serialization order for an archived cross-chain CALL relay row (XCALL
// dispatch/result phases); same crc32/byte-comparison rules as MATCH_KEYS.
// Without these in the archive, a full-chain-parse recovery could not rebuild
// the injected executions/callbacks and would diverge from live nodes.
// `id` (the hub-assigned AUTO_INCREMENT primary key) IS archived for per-hub
// provenance only; injection order is determined by (snapshot_block, call_id),
// not by `id`. Recovery must preserve the original id so the indexer mirror
// cursor stays consistent, but consensus ordering never uses it.
const CALL_KEYS = ['id', 'call_id', 'phase', 'snapshot_block', 'network',
    'source_chain', 'source_action_index', 'source_contract_index',
    'target_chain', 'target_contract_index', 'method', 'params_json',
    'gas_limit', 'cross_hops', 'effective_time', 'finalizing_view', 'result_status',
    'return_payload_b64', 'validator_signatures', 'status'];

// Fixed serialization order for an archived bridge transfer row and an archived policy
// snapshot row; same crc32/byte-comparison rules as MATCH_KEYS. `id` is per-hub
// provenance, and the push generation, chain id and created_at columns stay out.
const BRIDGE_KEYS = ['id', 'transfer_id', 'snapshot_block', 'network',
    'src_chain', 'src_action_index', 'src_address', 'dest_chain', 'dest_address',
    'tick', 'decimals', 'amount', 'effective_time',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
    'finalizing_view', 'validator_signatures', 'status'];

const POLICY_KEYS = ['id', 'snapshot_id', 'snapshot_block', 'network',
    'origin_chain', 'tick', 'policy_seq', 'origin_block', 'policy_hash',
    'allow_list', 'block_list', 'sleeping', 'effective_time',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
    'finalizing_view', 'validator_signatures', 'status'];

const CHECKPOINT_KEYS = ['id', 'chain', 'network', 'block_index', 'block_hash',
    'ledger_hash', 'actions_hash', 'contract_hash', 'checkpoint_seq', 'snapshot_block',
    'state_root', 'state_root_version', 'block_merkle_root', 'block_merkle_version',
    'validator_signatures'];

const PRICE_KEYS = ['id', 'round_number', 'coin_pair', 'price', 'reference_block',
    'reference_chain', 'block_timestamp', 'validator_count', 'consensus_round',
    'consensus_proof', 'status', 'source_chain', 'source_action_index', 'batch_block_time',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];

// One policy list can reach 10000 members, so a round carries at most this many policy
// rows; the whole archive JSON stays under the byte ceiling, well inside the 16 MiB
// decompress cap every verifier enforces.
const ARCHIVE_MAX_POLICY_ROWS = 8;
const ARCHIVE_MAX_PRICE_ROUNDS = 288;
const ARCHIVE_MAX_JSON_BYTES = 8 * 1024 * 1024;

module.exports = {
    ANCHOR_FLAG_DAY_REWARD_TYPES,
    ARCHIVE_FLAG_DAY_REWARD_TYPE,
    XANC_SIGN_REQ,
    XANC_SIGN,
    XANC_FINALIZED,
    XANC_BUNDLE_DONE,
    XANCPUB_SIGN_REQ,
    XANCPUB_SIGN,
    XANCARCHPUB_SIGN_REQ,
    XANCARCHPUB_SIGN,
    XANCREWARD,
    MAX_ACTION_DATA_LENGTH,
    OP_RETURN_PUSH_OVERHEAD,
    ANCHOR_BUNDLE_MAX_BYTES,
    ANCHOR_SIG_PAIR_BYTES,
    DEFAULT_ANCHOR_MARKER_RETENTION_MS,
    ANCHOR_MARKER_RETENTION_TTL_SAFETY,
    MATCH_KEYS,
    CALL_KEYS,
    BRIDGE_KEYS,
    POLICY_KEYS,
    CHECKPOINT_KEYS,
    PRICE_KEYS,
    ARCHIVE_MAX_POLICY_ROWS,
    ARCHIVE_MAX_PRICE_ROUNDS,
    ARCHIVE_MAX_JSON_BYTES
};
