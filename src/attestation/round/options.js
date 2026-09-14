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
 * XChain Hub - Attestation Round Options
 *
 * The state a round manager starts life with: the per-request maps, the poll
 * and retry windows read from config, and the process-lifetime counters. Held
 * apart from the poll loop because every one of these is a sizing decision with
 * an argument behind it, and the arguments are long.
 *
 ********************************************************************/

'use strict';
const esc    = require('../escalation.js');
// The consensus round-timeout default the seen-window floor below is keyed to.
// Required, never re-spelled: see the constant's own note in constants.js.
const { DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS } = require('../../constants.js');
const { positiveIntConfig } = require('../../lib/config_int.js');

// How often to poll the indexer for new pending requests. 3 s, not the historical
// 15 s: above ATTEST_ZERO_CONF_ACTIVATION the hub serves a request at the tip it
// was mined at, so this interval IS the floor on how long a contract waits for its
// response, and a 15 s floor dominated the whole mined-to-mirrored budget. Two
// indexer queries per poll (the tip read and the pending page), so a five-hub
// federation costs about 3.3 queries a second fleet-wide.
const DEFAULT_POLL_MS         = 3000;
const DEFAULT_CONFIRMATIONS   = 3;      // BTC blocks of confirmation before initiating fetch (spec §14)

// ms: provider fetch timeout. 20 s, not the historical 10 s (operator ruling
// 2026-09-11): a slow-but-healthy provider fetch that crossed 10 s aborted here and
// left the round with fewer independent bodies than its redundancy asked for, which
// byte_equality reads as a no_quorum rather than as a slow vendor. 20 s still sits an
// order of magnitude under DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, so the round timer
// remains the terminal backstop. AttestationConsensus bounds the judge call with the
// same key and must carry the same literal; the two are read on separate paths.
const DEFAULT_FETCH_TIMEOUT   = 20000;

module.exports = {

    // Per-request maps and the poll-loop flags. Every one is evicting or
    // cursor-bounded; the notes say against which window.
    initRoundState(){
        // Active round state, keyed by requestId. Each entry:
        //   { request, role: 'leader'|'follower'|'inactive', fetchedAt, proposed: bool }
        this.rounds = new Map();

        // Requests we've already evaluated, as request_id -> last-evaluated
        // timestamp (ms). A Map rather than a Set so entries can be evicted
        // after `retryAfterMs`: a request skipped for a transient reason
        // (provider not yet registered, empty capability snapshot) becomes
        // eligible for re-evaluation once the window lapses, instead of being
        // suppressed for the whole process lifetime. Also bounds memory;
        // a plain Set grew monotonically with historical request volume.
        this.seen = new Map();

        // Leader-silence observation, keyed by requestId. One entry per request
        // this hub has run a round for:
        //   { silent: Set<pubkey>, watchPubkey, watchBlock,
        //     heldLogged: bool, updatedAt: ms }
        // It has to live HERE rather than on a round or a consensus `pending`,
        // because both of those are torn down and rebuilt on every retry while the
        // question it answers ("has this member ever spoken for this request?")
        // spans the request's whole life. Evicted on the `rounds` TTL.
        this.leaderSilence = new Map();

        // Keyset cursor for paging through pending requests across poll cycles.
        // null = start a fresh sweep from the oldest pending request.
        this.pollCursor = null;

        // The BTC tip the last successful poll reported, as
        // { blockHeight, observedAt (ms) }, or null before the first one. Every hub
        // that runs rounds polls a Bitcoin indexer, so this is a BTC height every
        // attestation validator holds; the batch publisher anchors on it when no
        // indexer has pushed a chain_tips row to this hub, which on a federation
        // that shares one Bitcoin indexer is every hub but the one it pushes to.
        this.observedTip = null;

        // AttestationConsensus instance; set via setConsensus after creation
        this.consensus = null;

        this._pollTimer      = null;
        // In-flight guard for the interval-driven poll. Matches the
        // house convention (XChainIndexer _hubConfigPollRunning, XChainDecoder
        // mempoolBusy, HubPushQueue draining): a poll that outruns pollMs under a
        // slow/partitioned indexer or a tightened ATTESTATION_POLL_MS must not
        // stack a second concurrent pollPending that races this.pollCursor.
        this._pollRunning    = false;
    },

    // The poll cadence, the fetch budget and the two windows a skipped or
    // completed request ages out on.
    initRoundTimings(){
        // positiveIntConfig, not `parseInt(cfg) || DEFAULT`, for the reason
        // AttestationConsensus states over its own ring caps: a negative is TRUTHY, so
        // it survives the `||` fallback and silently inverts the gate it sizes. A
        // negative ATTESTATION_CONFIRMATIONS makes `block_index + confirmations >
        // latestBlock` false below spec §14 depth, so this hub pays for fetches on
        // requests the federation still considers reorg-able; a negative POLL_MS or
        // FETCH_TIMEOUT collapses the poll cadence and the fetch budget the same way.
        // Zero and garbage already fell back, so this changes nothing an operator can
        // configure today except that a negative now warns and falls back too.
        this.pollMs         = positiveIntConfig(this.config.ATTESTATION_POLL_MS,       DEFAULT_POLL_MS,       'ATTESTATION_POLL_MS');
        this.confirmations  = positiveIntConfig(this.config.ATTESTATION_CONFIRMATIONS, DEFAULT_CONFIRMATIONS, 'ATTESTATION_CONFIRMATIONS');
        this.fetchTimeoutMs = positiveIntConfig(this.config.ATTESTATION_FETCH_TIMEOUT, DEFAULT_FETCH_TIMEOUT, 'ATTESTATION_FETCH_TIMEOUT');
        // Blocks of leader silence before the round leader rotates one slot down
        // the responsible set (and the model-fallback ladder advances; both are
        // pure functions of chain height, see attestation_escalation.js).
        this.leaderRotationBlocks = positiveIntConfig(this.config.ATTESTATION_LEADER_ROTATION_BLOCKS,
            esc.DEFAULT_ROTATION_WINDOW_BLOCKS, 'ATTESTATION_LEADER_ROTATION_BLOCKS');
        // How long a request stays in `seen` before it can be re-evaluated.
        // Defaults to 5 poll cycles so transient skips clear quickly while
        // still suppressing the steady-state re-poll of confirmed work.
        //
        // Floor it above the consensus round timeout. The seen window
        // must never nest inside a LIVE consensus round: if it evicts first, the
        // next poll re-`_startRound`s a request whose round is still pending and
        // issues another paid provider fetch that consensus.propose() then discards
        // on its `pending.has(rid)` guard. At stock defaults 5*3s=15s is far shorter
        // than the 120s round timeout, so it is the Math.max floor below that binds
        // and the effective window is 120s+3s=123s; lowering ATTESTATION_POLL_MS
        // widens the gap silently. Sourcing the round timeout from the same config
        // key AND the same shared default AttestationConsensus reads keeps the two
        // windows coupled on both paths; a re-spelled literal here coupled them only
        // while the two copies happened to be equal, so raising the consensus default
        // one-sidedly re-nested the window on any hub with no explicit key. The paid
        // fetch is also short-circuited directly in _startRound via
        // consensus.isRoundActive(), but flooring closes the nesting at its root.
        // The floor is only as strong as the weaker of the two parses: a negative
        // ATTESTATION_ROUND_TIMEOUT_MS survived `||` here and in the consensus copy,
        // collapsing this Math.max to 5*pollMs while every round died on the next tick,
        // which is the paid-duplicate-fetch nesting the paragraph above closes.
        let roundTimeoutMs  = positiveIntConfig(this.config.ATTESTATION_ROUND_TIMEOUT_MS,
            DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, 'ATTESTATION_ROUND_TIMEOUT_MS');
        this.retryAfterMs   = Math.max(
            positiveIntConfig(this.config.ATTESTATION_RETRY_AFTER_MS, 5 * this.pollMs, 'ATTESTATION_RETRY_AFTER_MS'),
            roundTimeoutMs + this.pollMs
        );
        // How long a `rounds` entry is retained before lazy eviction. A round's
        // active lifecycle is ~2 min (consensus round timeout), so the 1-hour
        // default leaves a wide safety margin while bounding memory. Without
        // this the Map grew monotonically with lifetime request volume (it was
        // only ever cleared on stop()).
        this.roundsTtlMs    = parseInt(this.config.ATTESTATION_ROUND_TTL_MS)   || (60 * 60 * 1000);
    },

    // Monotonic process-lifetime accounting. Consumers alert on a RISE in any
    // of these, never on a raw nonzero snapshot; a restart is where the
    // evicting maps above are empty and these are 0.
    initRoundCounters(){
        // Fetch accounting, monotonic for the process life and reported by getStats.
        // No fetch counter existed anywhere before: the durable fetch cache's whole
        // purpose is to keep a restart from re-paying a provider, and nothing made
        // "did this hub pay once or twice for this request" observable. Consumers
        // alert on a rise in fetchCount without a matching request, and read
        // fetchCacheHitCount as the cache doing its job.
        this.fetchCount         = 0;   // provider calls this process actually issued
        this.fetchCacheHitCount = 0;   // rounds served from the durable cache instead
        this.finalizedSkipCount = 0;   // re-polls refused on the finalized ring before any fetch

        // Poll-rejection accounting (item 7650). An indexer that answers HTTP 200 with a
        // JSON-RPC error - an unknown method on an incompatible build is the shape that
        // costs the most - never reaches the catch above that logs transport failures, so
        // without this counter the quieter failure leaves the poll in silence: no counter
        // moves, no line is written, and every counter below stays frozen at its last
        // value while the request feed admits nothing. Monotonic for the
        // process life for the same reason fetchCount is: consumers alert on a rise, and
        // a restart is exactly when the evicting maps are empty.
        this.pollRpcErrorCount = 0;
        // Timestamp of the last poll whose JSON-RPC result was usable. Null until one
        // succeeds, which is also the observer-only steady state, so getStats reports the
        // age as null rather than as a huge number that reads like a stall.
        this.lastPollOkAt      = null;
        // Warn throttle for the above. A broken indexer is broken on every tick, and at
        // the default cadence that is a line every few seconds forever; log the first
        // occurrence and then at most one per pollMs-scaled window.
        this._pollRpcWarnAt    = 0;
    }

};
