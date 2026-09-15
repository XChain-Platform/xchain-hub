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
 * XChain Hub - Oracle Consensus: construction
 *
 * The constructor field groups: the round bookkeeping, the timer and watchdog maps,
 * the bounded rings and early-message buffer, and the config-read timing knobs. Each is
 * called with the engine as `this`, so the assignments read exactly as they did inline.
 *
 ********************************************************************/

'use strict';

const { positiveIntConfig } = require('../../lib/config_int.js');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

const DEFAULT_FINALIZATION_TIMEOUT = 120000; // 2 minutes
// Leader-timeout: a leader can gossip (and have peers record) its submission and
// then crash before broadcasting ORACLE_PROPOSE. Followers would otherwise wait
// out the full finalization window. After this shorter grace with no PROPOSE, the
// lowest-addr submitter OTHER THAN the (presumed-dead) leader takes over as
// fallback proposer, salvaging the round's pricing data. Measured from the moment
// the round becomes ready to finalize (block-driven, so every hub uses the same
// window); receivers apply the same grace before accepting such a fallback PROPOSE.
const DEFAULT_LEADER_TIMEOUT_MS = 30000;  // 30 seconds (< finalization window)

// Slack the round-abandonment watchdog adds on top of the round's own
// timer ladder before it declares the round lost and writes the durable skipped
// record. Wide enough that a round finishing at the very edge of its finalization
// window (or one re-opened by a PROPOSE that landed late) still wins the race and
// disarms the watchdog, narrow enough that the record lands long before the next
// round's boundary (rounds are ~10 minutes apart).
const DEFAULT_ROUND_ABANDON_GRACE_MS = 15000;
// Follower freshness bound on the leader-supplied btcBlockHeight in a PROPOSE.
// Same family and default as StateCheckpointEngine.cosignToleranceBlocks and
// CrossChainCallEngine's snapshot_block bound: about a day of BTC blocks.
const DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS = 144;

// The round's in-memory bookkeeping: the pending-round map and the counters
// OracleRound.getSubmissionsInfo and the metrics rail read back.
function initRoundCounters() {
    // Pending rounds: Map<round, { prices, digest, prepares: Set, commits: Set, finalized: bool, timer }>
    this.pendingRounds = new Map();

    // Rounds evicted on finalization timeout (leader and follower seats alike),
    // mirroring StateCheckpointEngine._roundTimeouts. Exposed as round_timeouts
    // through OracleRound.getSubmissionsInfo (the getoraclesubmissions RPC) so
    // the dashboard can alert on quorum-loss frequency (reviews 1468/1469).
    this._roundTimeouts = 0;

    // Rounds finalized with single-source corroboration on a normally-multi-source
    // pair, plus the last such round. Same shape and the same reason as
    // _roundTimeouts above: the diversity collapse is computed at finalization and
    // was then only console.warn'd, so a federation publishing PRICE v0 off one
    // upstream left no trace any dashboard rail could read. Exposed as
    // single_source_rounds / lastSingleSourceRound through
    // OracleRound.getSubmissionsInfo, and as xchain_oracle_single_source_rounds_total
    // on the metrics surface.
    this._singleSourceRounds    = 0;
    this._lastSingleSourceRound = null;

    // Rounds this hub watched open and then recorded as abandoned,
    // same counter convention as _roundTimeouts. Distinct from it: a timeout
    // counts only the two PBFT seats that held a pending round, while the
    // follower seat that never got a PROPOSE at all left no trace anywhere.
    // Surfaced as abandoned_rounds through OracleRound.getSubmissionsInfo, so
    // "this hub keeps losing rounds" is legible without a DB query.
    this._abandonedRounds    = 0;

    // Rounds whose PROPOSE was judged against a clamp reference this hub's own
    // database had not caught up to, counted after the round-aligned re-read
    // still came back behind. Same counter convention as _roundTimeouts.
    this._staleClampReference = 0;

    // Round of the last re-read ATTEMPT, so a hub whose database is genuinely
    // behind reads at most once per round instead of once per PROPOSE.
    this._lastFinalizedRefreshRound = null;
    this._lastAbandonedRound = null;
}

// The per-round timer and watchdog maps, all keyed by round and cleared by stop().
function initRoundTimers() {
    // When each round became ready to finalize (Date.now() at finalizeRound's
    // follower path). The receiver-side leader-timeout grace in _handlePropose
    // is measured from here so every honest hub applies the same window before
    // accepting a leader-timeout fallback PROPOSE. Pruned when a round
    // finalizes/skips. Map<round, msEpoch>.
    this.roundReadyAt = new Map();

    // Armed leader-timeout timers, keyed by round, so they can be cleared on
    // stop() or once the round is taken. Only the elected fallback proposer
    // arms one. Map<round, Timeout>.
    this.leaderTimers = new Map();

    // Armed round-abandonment watchdogs, keyed by round.
    // Map<round, { timer, btcBlockHeight, btcBlockTime, rearms }>.
    //
    // EVERY seat that observes a round open arms one, so a round that dies
    // between opening and finalizing still becomes a durable 'skipped' record
    // HERE rather than only on whichever hub happened to take one of the
    // early store-skipped branches in finalizeRound. Before this, the
    // follower seats (leader submitted, someone else is the elected fallback)
    // and both PBFT timeout seats returned in silence, so testnet rounds
    // 25-27 finalized nowhere and left a row on exactly one of five
    // validators: the federation could not even agree the rounds happened.
    this.roundWatchdogs = new Map();
}

// The bounded finalized/locally-skipped rings and the early-arrival message buffer,
// both sized from config because both are fed by attacker-chosen round numbers.
function initFinalizedAndEarlyBuffers() {
    // Already finalized rounds (prevents double-store), bounded FIFO (L1):
    // this set only ever grew (~1 entry per round), leaking for the process
    // lifetime. Cap it with an insertion-order ring; rounds finalize in
    // roughly ascending order so the oldest evicted round is far below the
    // live round and will never be re-proposed.
    this.finalized = new Set();
    this._finalizedOrder = [];
    this.finalizedMax = positiveIntConfig(hubConfig.ORACLE_FINALIZED_MAX, 10000, 'ORACLE_FINALIZED_MAX');

    // Rounds this hub stored as 'skipped' for a LOCAL reason (its gossip lagged
    // below minSubmissions at the block boundary, or its own aggregate was
    // empty), NOT because the whole federation skipped (stress-sweep #7). These
    // are kept separate from `finalized` so a legitimate later PROPOSE from the
    // federation still processes: without this, a locally-skipped round landed
    // in `finalized`, _handlePropose dropped the real PROPOSE, and handlePrepare
    // /_handleCommit refused to buffer, so the hub permanently held a NULL
    // price_snapshot for a round the rest of the federation finalized. When the
    // round does reach commit quorum here, storeSnapshot's ON DUPLICATE KEY
    // UPDATE upgrades the 'skipped' rows to 'finalized' and markFinalized moves
    // the round out of this set. Bounded by the same insertion-order ring as
    // `finalized` (round is not attacker-chosen here -- only this hub's own
    // finalizeRound writes it -- but the ring keeps it from growing for the
    // process lifetime).
    this.locallySkipped = new Set();
    this._locallySkippedOrder = [];

    // Early-arrival buffer (finding F7). A PREPARE/COMMIT can land while
    // _handlePropose is still awaiting the block-boundary snapshot, or
    // before the PROPOSE itself arrives. The whole PBFT burst completes in
    // well under a second, so dropping those messages makes this hub miss
    // the round (the federation still finalizes without it, leaving a
    // silent hole in this hub's price_snapshots). Buffer by round and
    // drain once pendingRounds is populated. Mirrors
    // AttestationConsensus.earlyMessages.
    this.earlyMessages        = new Map();   // round -> [envelope]
    this.earlyMessageTtl      = new Map();   // round -> expiresAt (ms)
    this.earlyMessageTtlMs    = 60 * 1000;
    this.earlyMessageMaxPerRound = 64;
    // Cap the number of DISTINCT round keys held at once. `round` is taken from
    // attacker-controlled envelope.data, so without this a single Byzantine
    // validator streaming PREPAREs with millions of fresh round numbers inside
    // the 60s TTL grows earlyMessages without bound (memory DoS) and makes every
    // pruneEarlyMessages an O(rounds) scan (O(n^2) CPU). Map preserves insertion
    // order, so eviction is FIFO on the oldest round key. 256 >> any legitimate
    // in-flight round concurrency (rounds are ~10 min apart).
    // positiveIntConfig, not `parseInt(env) || 256`, and here it is a HANG, not a
    // loosened cap: the eviction below is a `while (size >= max)` loop, so a negative
    // value keeps the condition true at size 0, where `keys().next().value` is
    // undefined and `delete(undefined)` changes nothing. The loop never terminates and
    // wedges the event loop for the whole hub process on the first buffered message.
    this.earlyMessageMaxRounds = positiveIntConfig(hubConfig.ORACLE_EARLY_MSG_MAX_ROUNDS, 256,
        'ORACLE_EARLY_MSG_MAX_ROUNDS');
}

// The round's timing and quorum knobs, read from config once at construction.
function applyTimingConfig() {
    this.finalizationTimeout = parseInt(hubConfig.ORACLE_FINALIZATION_TIMEOUT) || DEFAULT_FINALIZATION_TIMEOUT;
    // Default to a 2-hub diversity floor: a single hub's single external source must never
    // become a federation-signed price. A real federation always clears 2; single-host / regtest
    // deployments set ORACLE_MIN_SUBMISSIONS=1 explicitly.
    //
    // positiveIntConfig, not `parseInt(env) || 2`: a NEGATIVE value is truthy, so it would
    // pass straight through and make the `submissions.size < this.minSubmissions` floor checks
    // permanently false, removing the floor rather than lowering it. Non-positive and
    // unparseable values now fall back to 2.
    this.minSubmissions      = positiveIntConfig(hubConfig.ORACLE_MIN_SUBMISSIONS, 2, 'ORACLE_MIN_SUBMISSIONS');
    // Unlike ORACLE_ALLOW_UNVERIFIED_PAIRS below, this knob is NOT regtest-gated: single-host
    // PROD is a supported deployment (xchain-node ConfigService passes the key through, and
    // HubConsensusEnvGuard refuses a container regenerate that drops it) and ignoring the
    // override there would skip every round and stall every indexer's price-sync barrier.
    // What the hatch must not be is SILENT, so a sub-floor setting announces itself on any
    // network that is not regtest, naming the defense it stands down.
    if (this.minSubmissions < 2 && !(this.hub && this.hub.network === 'regtest')) {
        logger.info('WARNING: ORACLE_MIN_SUBMISSIONS=' + this.minSubmissions + ' on ' +
            (((this.hub && this.hub.network) || '<unset>')) + '; the 2-hub price diversity floor ' +
            'is STOOD DOWN on this hub, so one submitter can carry a federation-signed round. ' +
            'Intended only for a deliberate single-host deployment.');
    }
    this.leaderTimeout       = parseInt(hubConfig.ORACLE_LEADER_TIMEOUT_MS) || DEFAULT_LEADER_TIMEOUT_MS;
    // Follower freshness bound on the leader-supplied btcBlockHeight in a
    // PROPOSE. That height selects the price snapshot (quorum N), the member set
    // the round's leader is elected from, and the STAKE_WEIGHTED_QUORUM
    // activation outcome, and it is a wire field the proposer chose. Same family
    // and default as StateCheckpointEngine.cosignToleranceBlocks and
    // CrossChainCallEngine's snapshot_block bound: about a day of BTC blocks, so
    // honest tip skew between hubs costs a round nothing. 0 is meaningful (pin to
    // our own tip exactly), hence the non-negative guard rather than `|| default`.
    this.snapshotToleranceBlocks = parseInt(hubConfig.ORACLE_SNAPSHOT_TOLERANCE_BLOCKS
        || String(DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS));
    if (!(this.snapshotToleranceBlocks >= 0))
        this.snapshotToleranceBlocks = DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS;
    // Extra slack on top of the round's own timer ladder before the
    // abandonment watchdog declares the round lost. Additive only:
    // roundAbandonMs() derives the window from the ladder, so a deployment
    // that widens ORACLE_FINALIZATION_TIMEOUT widens the watchdog with it and
    // this knob never has to be retuned alongside it.
    this.roundAbandonGraceMs = positiveIntConfig(hubConfig.ORACLE_ROUND_ABANDON_GRACE_MS,
        DEFAULT_ROUND_ABANDON_GRACE_MS, 'ORACLE_ROUND_ABANDON_GRACE_MS');
}

// The regtest-only hatch that lets a single-fetcher hub co-sign pairs it cannot verify.
function applyUnverifiedPairsHatch() {
    // A proposed pair this follower can verify against NOTHING (no live
    // local aggregate AND no finalized history) would otherwise fall through with only
    // the (0, PRICE_MAX) clamp, letting a Byzantine leader who is the sole
    // submitter for a brand-new pair get any value up to PRICE_MAX co-signed.
    // Default is fail closed: withhold co-sign on unverifiable pairs, so
    // finalization requires at least one follower that priced the pair itself.
    // Escape hatch for deliberate single-host / bootstrap deployments where no
    // second fetcher exists (regtest, ORACLE_MIN_SUBMISSIONS=1 setups).
    //
    // Network-gated, same rule as the other regtest-only seams (StateCheckpointEngine's
    // XDEX_SNAPSHOT_BLOCK / XDEX_SEED_LOCAL_VALIDATOR, coins/index.js
    // resolveFeeDestination): honored ONLY on regtest, set-but-IGNORED and warned
    // everywhere else. A mainnet/testnet federation always has a second fetcher, so the
    // hatch has no legitimate use there, and a stray env var must never disarm a
    // Byzantine-leader defense in silence. hub.network is the api.js-validated
    // HUB_NETWORK (mainnet|testnet|regtest, required in validator mode, and this engine
    // only ever starts in validator mode); anything else, '' included, fails closed.
    let allowUnverifiedEnv = String(hubConfig.ORACLE_ALLOW_UNVERIFIED_PAIRS || '') === 'true';
    let isRegtest          = !!(this.hub && this.hub.network === 'regtest');
    if (allowUnverifiedEnv && !isRegtest) {
        logger.info('WARNING: ORACLE_ALLOW_UNVERIFIED_PAIRS is set but IGNORED on ' +
            (((this.hub && this.hub.network) || '<unset>')) + '; unverifiable-pair co-sign ' +
            'stays fail-closed. This hatch is honored only on regtest single-host bring-up.');
    }
    this.allowUnverifiedPairs = allowUnverifiedEnv && isRegtest;
}

module.exports = {
    initRoundCounters, initRoundTimers, initFinalizedAndEarlyBuffers,
    applyTimingConfig, applyUnverifiedPairsHatch
};
