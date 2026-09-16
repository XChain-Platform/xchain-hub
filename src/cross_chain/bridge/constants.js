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
 * XChain Hub - Bridge Engine Constants
 *
 * The bridge engine's tunables and canonical field lists, in one place because the poll,
 * the policy round, the follower checks and the invariant read each need some of them and a
 * second copy of a canonical field list is a fork waiting to happen.
 *
 ********************************************************************/

const coins = require('../../coins');

const ALLOWED_CHAINS  = [...coins.ALLOWED_COINS];

const DEFAULT_POLL_MS = 15000;

// Per-poll page size for the pending-leg read on one chain.
const PENDING_PAGE    = 100;

// The INT-backed fields each canonical signs VERBATIM while the indexer rebuilds them
// from the mirrored BIGINT/TINYINT row. A leader-supplied '041' passes every
// Number()-based re-derivation below yet finalizes a record whose signatures no
// settling indexer can reproduce, so the spellings are gated before any numeric
// comparison. Ticks, addresses, chains and the bcmath decimal `amount` are string
// compares and deliberately absent.
const TRANSFER_CANONICAL_INT_FIELDS = ['snapshot_block', 'src_action_index', 'decimals', 'effective_time'];

const POLICY_CANONICAL_INT_FIELDS   = ['snapshot_block', 'policy_seq', 'origin_block', 'effective_time'];

// Working precision for every amount sum in the invariant read. A token declares up to
// MAX_TOKEN_DECIMALS (18, xchain-indexer config.js), and bcmath's helpers default to
// precision 0, which SILENTLY ROUNDS: bcadd('2.0', '1.5') is 4 without this. The sums are
// display and alarm arithmetic, never a hash input, but an alarm that rounds is an alarm
// that invents a deficit, so they run at the widest precision the platform allows.
const AMOUNT_SCALE = 18;

// Ceiling on the membership of one inherited list (policy spec R2, RULED a 2026-09-11).
// Canonical value: xchain-documentation/protocol/constants.js XPOLICY_MAX_MEMBERS, which
// the indexer enforces at ISSUE format 7; the hub enforces it here as the second half of
// the same rule (section 8: "the hub declines to sign a snapshot whose membership exceeds
// it, one log line, the previous snapshot stays in force"). Nothing depends on the number
// in a hash, so a later flag day can raise it. Named locally for the same reason
// constants.js XCALL_MAX_HOPS is: the hub cannot require across package boundaries.
const XPOLICY_MAX_MEMBERS = 10000;

// How far a follower's own BTC tip view may sit from a leader's snapshot_block before it
// refuses to co-sign: about a day of BTC blocks, the bound every sibling engine uses.
// Pinning an ancient snapshot_block would let a Byzantine leader select a stale validator
// set for the indexer-side signature check.
const SNAPSHOT_BLOCK_TOLERANCE = 144;

module.exports = { ALLOWED_CHAINS, DEFAULT_POLL_MS, PENDING_PAGE, TRANSFER_CANONICAL_INT_FIELDS, POLICY_CANONICAL_INT_FIELDS, AMOUNT_SCALE, XPOLICY_MAX_MEMBERS, SNAPSHOT_BLOCK_TOLERANCE };
