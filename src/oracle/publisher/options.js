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
 * XChain Hub - Oracle Publisher: construction of the queue, guard, takeover and self-chaining state
 *
 * The fields the constructor assigned before the batch rail existed: where the
 * durable files live, the two halves of the at-most-once guard, the spend gate,
 * and the rank-staggered takeover and self-chaining knobs. Each initializer is
 * called from the constructor in the order these fields were always assigned, so
 * a config read, a clamp and a warn line still happen exactly when they did.
 *
 ********************************************************************/

'use strict';

const hubConfig = require('../../config');
const { AtMostOnce } = require('../../lib/idempotent_broadcast.js');
const SpendGuard    = require('../../lib/spend_guard.js');

// ~10 min. Translates the rank-staggered takeover window from BTC blocks (the
// unit the window anchor is denominated in) into wall-clock, the same way
// AttestationPublisher does for its own failover.
const APPROX_BTC_BLOCK_MS = 600000;

module.exports = {

    // The durable file paths and the counters getStats reports.
    initQueueState(cfg) {
        this.queuePath          = hubConfig.PUBLISHER_QUEUE_PATH || cfg.PUBLISHER_QUEUE_PATH || './data/publisher-queue.jsonl';
        // Append-only sink for rounds that exhaust maxAttempts. Kept next to the
        // queue so operators find both together; never truncated (open 'a').
        this.deadLetterPath     = this.queuePath.replace(/\.jsonl$/, '') + '.deadletter.jsonl';
        // PRICE v0 round buffer, a third sibling file. Rounds wait here between
        // finalization and the window close that turns them into one signed batch.
        // Deliberately NOT the publish queue: see the header.
        this.bufferPath         = this.queuePath.replace(/\.jsonl$/, '') + '.buffer.jsonl';
        // Lifetime counter of rounds moved to the dead-letter file. Makes a
        // give-up event countable instead of only a console.error.
        this.abandonedCount     = 0;
        // Lifetime count of finalized rounds dropped pre-enqueue because their encoded
        // PRICE v0 wire exceeded PRICE_WIRE_MAX_BYTES. Kept separate from abandonedCount
        // so operators can tell an oversized drop apart from an attempts-exhausted abandon.
        this.oversizedDrops     = 0;
        // Transition-only guard so a persistent capability-snapshot resolution failure
        // (which darks the publisher) is logged once per dark spell, not every round.
        this._snapshotDark      = false;
        // Lifetime published count + last-published markers + last-observed balance,
        // surfaced via getStats() so an operator RPC can see the publish rail's
        // health (a stalled rail is otherwise invisible: every price_snapshots row
        // still reads finalized while nothing lands on-chain).
        this.publishedCount     = 0;
        // Newest publication this hub can prove: assigned on the publish path and
        // hydrated at startup from the durable confirmed markers. The monitor's
        // batch-backlog rail gates on this round, and a null reads to it as a hub that
        // has never published, which silences the rail for every restarted publisher.
        // publishedCount above stays process memory on purpose: it counts what THIS
        // lifetime sent, which the marker table cannot answer.
        this.lastPublishedRound = null;
        this.lastPublishedTxid  = null;
        // Highest CONFIRMED round in the durable marker table, read at startup. Answers
        // "has this hub ever published?" from evidence that excludes intent-only rows,
        // and costs no extra query because hydratePublishedMarkers already reads those
        // rows for the at-most-once guard. Null when no hub DB is wired (dev/test) or
        // when nothing has ever been confirmed.
        this._durableEverPublishedRound = null;
    },

    // Both halves of the at-most-once guard, the DOGE identity the wire spends from,
    // and the retention window bounding the durable marker table.
    initDurableGuard(cfg) {
        // In-process at-most-once guard. Round ids broadcast this process lifetime
        // are recorded here the instant broadcaster(payload) succeeds. If the
        // post-broadcast queue rewrite fails (disk full, permissions, transient I/O),
        // the just-published round stays on the durable queue file; without this set
        // the next processQueue tick would re-read and RE-BROADCAST it, spending real
        // DOGE twice for the same round. Consulted before every broadcast so a failed
        // rewrite can never turn into a duplicate on-chain PRICE. Cleared once the
        // durable queue is confirmed rewritten (no published round can still be on it).
        this._publishedRounds   = new AtMostOnce();
        // Durable at-most-once. The in-process tracker above vanishes on restart, but
        // the finalized round can still be on the durable JSONL queue, so a restart
        // before the queue rewrite is repaired would re-broadcast an already-paid round
        // (duplicate DOGE spend). The `oracle_published_rounds` table (src/sql/) records
        // an intent row BEFORE broadcast and a sent marker AFTER, on the hub DB, a disk
        // decoupled from the queue file whose exhaustion triggers the rewrite failure.
        // start() hydrates _publishedRounds from sent markers and quarantines any
        // intent-only rows (a crash between intent and confirmation left the on-chain
        // state unknown): those are NEVER auto-rebroadcast, only surfaced for an operator
        // to verify on-chain and replay by hand. When no hub DB is wired (dev/test), the
        // durable guard is inert and the in-process tracker is the only at-most-once cover.
        this._quarantinedRounds = new Set();
        this.lastObservedBalance = null;
        this.dogeAddress        = hubConfig.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
        this.dogePubkeyHex      = hubConfig.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        this.lowBalanceThreshold = parseFloat(hubConfig.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10'); // DOGE
        this.maxAttempts        = parseInt(hubConfig.PUBLISHER_MAX_ATTEMPTS || cfg.PUBLISHER_MAX_ATTEMPTS || '5');
        // Retention window (in rounds) for the durable oracle_published_rounds marker
        // table. One row lands per published round forever, so on a money-bearing
        // broadcast path the table grows without bound for the life of the deployment.
        // PRICE batching does NOT change that rate: a batch writes one marker row
        // per CONTAINED round, not one per wire, so the rows-per-day figure the window
        // below is sized against is identical either side of the flag day (D26).
        // Only CONFIRMED rows (sent_at IS NOT NULL) are ever pruned: a sent_at NULL row
        // is the quarantine marker for a round whose on-chain state is unknown, which an
        // operator reconciles by hand, so those must survive forever (see
        // hydratePublishedMarkers). Keep the most recent N rounds; 0 disables pruning.
        // Default ~90 days at the 10-minute round default, mirroring the
        // ORACLE_SUBMISSIONS_RETENTION_ROUNDS window on the sibling audit table.
        // The window counts ROUNDS, never wires, so it means the same 90 days under
        // v2 batching even though the wire count per day falls by ORACLE_BATCH_WINDOW_ROUNDS.
        this.publishedRoundsRetentionRounds = parseInt(
            hubConfig.ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS ||
            cfg.ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS);
        if (!Number.isFinite(this.publishedRoundsRetentionRounds) || this.publishedRoundsRetentionRounds < 0) {
            this.publishedRoundsRetentionRounds = 12960;
        }
        // Lifetime count of confirmed marker rows pruned by the retention sweep, and
        // the promise of the in-flight sweep. The sweep is fire-and-forget on the
        // publish path (a retention failure must never stall a broadcast), so the
        // handle is what makes it awaitable in tests and diagnosable in getStats.
        this.publishedRoundsPruned = 0;
        this._retentionSweep       = null;
    },

    // The operator kill switch and the shared spend ceiling.
    initSpendGate(cfg) {
        // item 2677 - operator kill switch. Mirrors StateAnchorPublisher's
        // ANCHOR_ENABLED gate: a first-class lever to halt outbound DOGE spend
        // during an incident (bad price feed, runaway fees, compromised signer)
        // without tearing down the broadcast pipeline config. Default: enabled.
        this.enabled = String(hubConfig.ORACLE_PUBLISH_ENABLED || cfg.ORACLE_PUBLISH_ENABLED || 'true') !== 'false';

        // Shared SpendGuard (supersedes the old per-publisher SpendCeiling).
        // Composes the per-window spend ceiling (count + a $2000-clamped USD-cents
        // budget, default-ON), the wallet balance floor, and a per-capability runtime
        // pause. Folding the pause into allow() is what lets an operator halt this
        // publisher's PRIMARY (leader) DOGE spend at runtime, not just its sweep.
        this.spendGuard = new SpendGuard('ORACLE_PUBLISH', cfg, 'OraclePublisher');
        // Keep the guard's balance floor in step with the publisher's existing
        // DOGE_LOW_BALANCE_THRESHOLD so guard stats read the same floor the
        // pre-loop balance gate enforces.
        this.spendGuard.minBalance = this.lowBalanceThreshold;
    },

    initTakeoverState(cfg) {
        // Per-round state
        //
        // Rank-staggered window takeover. Without it a window whose leader never
        // broadcasts stays unpublished forever, because this class publishes only the
        // windows it leads and the peers holding the identical buffered rounds have no
        // way in. A follower re-assembles a window its leader left dark, ordered by
        // rank so the set takes over one at a time rather than all at once.
        //
        // Default 0 = OFF. Takeover pays DOGE for a window a peer may already have
        // paid for, so it stays an opt-in an operator arms per deployment once the
        // observation feed below is known to work.
        this.failoverWindowBlocks = parseInt(
            hubConfig.ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS ||
            cfg.ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS || '0');
        if (!Number.isFinite(this.failoverWindowBlocks) || this.failoverWindowBlocks < 0) this.failoverWindowBlocks = 0;
        this.approxBlockMs = parseInt(
            hubConfig.ORACLE_PUBLISH_BLOCK_MS || cfg.ORACLE_PUBLISH_BLOCK_MS || APPROX_BTC_BLOCK_MS);
        if (!Number.isFinite(this.approxBlockMs) || this.approxBlockMs <= 0) this.approxBlockMs = APPROX_BTC_BLOCK_MS;
        // Timers for windows this hub may take over, keyed by window index.
        this._takeoverTimers   = new Map();
        // Memoized proof that landed batches actually reach this hub (see
        // observationFeedProven). Never cached as false: a feed can come up later.
        this._observationProven = false;
        this._takeoverDarkWarned = false;
        this.takeoverAttempts  = 0;
        this.takeoverPublished = 0;
        this.takeoverDeferred  = 0;
        // How long an armed follower waits, once something says a batch for
        // the window may ALREADY be on the wire, before it treats that tx as gone and
        // publishes its own. Mirrors AttestationPublisher's
        // ATTESTATION_AMBIGUOUS_COOLDOWN_MS, down to the default: one full failover
        // window, which is the same horizon the rank stagger is denominated in. A DOGE
        // tx that has not reached this hub's observed-on-chain view in that long did
        // not land, so re-publishing then costs nothing that was not already lost.
        this.takeoverAmbiguousCooldownMs = parseInt(
            hubConfig.ORACLE_TAKEOVER_AMBIGUOUS_COOLDOWN_MS ||
            cfg.ORACLE_TAKEOVER_AMBIGUOUS_COOLDOWN_MS ||
            String(this.failoverWindowBlocks * this.approxBlockMs), 10);
        if (!Number.isFinite(this.takeoverAmbiguousCooldownMs) || this.takeoverAmbiguousCooldownMs < 0) {
            this.takeoverAmbiguousCooldownMs = this.failoverWindowBlocks * this.approxBlockMs;
        }
        // windowIndex -> ms timestamp of this hub's OWN ambiguous send for that window
        // (the dead-letter branch in processQueue). Insertion-ordered and bounded.
        this._ambiguousWindows = new Map();
    },

    initChainingState(cfg) {
        // Whether a publish may spend this address's own unconfirmed change. Default
        // FALSE: chaining is what lets one underpaid batch strand every later one,
        // because miners score by ancestor package. The escape hatch exists for a
        // venue that mines on demand (regtest), where chaining is free and waiting
        // for a confirmation would stall the harness.
        this.allowUnconfirmedInputs =
            String(hubConfig.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS ||
                   cfg.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS || 'false') === 'true';

        // Narrow exception to the rule above: a wire may spend the change of a wire
        // THIS publisher broadcast earlier in the SAME pass. A catch-up sweep sends
        // CATCHUP_WINDOWS_PER_SWEEP wires within one second, so wires past the
        // confirmed-output count see only dust, and a dust sweep prices its own fee
        // above the dust it collects. The package hazard the rule guards against
        // needs a CHEAP ancestor; every wire in one pass is built seconds apart at
        // one fee policy, so they rise and fall together. Bounded by depth, and the
        // next pass still defers wholesale on the NO_CONFIRMED_UTXO gate.
        this.selfChainMaxDepth = parseInt(
            hubConfig.ORACLE_PUBLISH_SELF_CHAIN_MAX_DEPTH ||
            cfg.ORACLE_PUBLISH_SELF_CHAIN_MAX_DEPTH || '4');
        if (!Number.isFinite(this.selfChainMaxDepth) || this.selfChainMaxDepth < 0) this.selfChainMaxDepth = 4;

        // txids this publisher broadcast in the pass now running, and how many wires
        // that pass has sent. Cleared at the head of every pass, so nothing survives
        // into a later pass where the change is no longer ours-this-second.
        this._passSelfChange = new Set();
        this._passChainDepth = 0;
        // Leader-rotation observability (item 3218). A dark peer publisher is
        // otherwise invisible: this hub's own status stays perfect while 1/N of
        // rounds never land on-chain. Track the rank state of the most recent
        // finalized round plus lifetime leader/follower-window counts so getStats
        // (getoraclepublisherstatus) exposes the rotation the dashboard can watch.
        this._lastRankState  = null; // { round, myRank, leaderRank, isLeader, publisherCount }
        this._leaderRounds   = 0;    // rounds this hub was the elected leader
        this._followerRounds = 0;    // finalized rounds this hub deferred (not leader)
        // The election OUTCOME, which the rotation state above cannot carry. _lastRankState
        // is written only once this hub has been found in the publisher set, so a hub that
        // is absent from that set leaves it null and reaches a monitor looking identical to
        // a hub whose publisher set would not resolve at all. One of those is a wedge and
        // the other is a node that was never going to publish, and until they are told
        // apart every rail that would catch the wedge has to stay silent or it reddens the
        // public rollup for every non-publishing node. Null until the first window election
        // runs, which is also the honest reading right after a restart: no election has
        // happened yet in this process and nothing durable records the last one.
        this._publisherRole  = null; // 'in_set' | 'not_in_set'; see getStats publisherRole
    },

};
