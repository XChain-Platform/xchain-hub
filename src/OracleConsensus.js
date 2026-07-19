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
 * XChain Hub - Oracle Consensus
 *
 * PBFT-like consensus for price oracle rounds. After the submission
 * window closes, the round leader aggregates prices using a trimmed
 * median, proposes the result, and validators vote to finalize it.
 *
 * Flow: ORACLE_PROPOSE -> ORACLE_PREPARE (2f+1) -> ORACLE_COMMIT (2f+1) -> store snapshot
 *
 * Single-node fast path: when quorum === 0 (only one oracle_publish validator),
 * the snapshot is stored immediately without any PROPOSE/PREPARE/COMMIT exchange.
 *
 ********************************************************************/

const crypto            = require('crypto');
const EventEmitter      = require('events');
const PriceFetcher      = require('./PriceFetcher.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD, ORACLE_MAX_CHANGE_PER_ROUND } = require('./constants.js');
const swq               = require('./stake_weighted_quorum.js');
const eq                = require('./equivocation_header.js');
const bcmath            = require('./bcmath.js');

const ORACLE_PROPOSE = 'ORACLE_PROPOSE';
const ORACLE_PREPARE = 'ORACLE_PREPARE';
const ORACLE_COMMIT  = 'ORACLE_COMMIT';

const TRIM_PERCENT = 0.15;  // Discard top and bottom 15% of submissions
const DEFAULT_FINALIZATION_TIMEOUT = 120000; // 2 minutes
const FALLBACK_GRACE_MS = 3000;  // brief grace before fallback proposer takes over
// Leader-timeout: a leader can gossip (and have peers record) its submission and
// then crash before broadcasting ORACLE_PROPOSE. Followers would otherwise wait
// out the full finalization window. After this shorter grace with no PROPOSE, the
// lowest-addr submitter OTHER THAN the (presumed-dead) leader takes over as
// fallback proposer, salvaging the round's pricing data. Measured from the moment
// the round becomes ready to finalize (block-driven, so every hub uses the same
// window); receivers apply the same grace before accepting such a fallback PROPOSE.
const DEFAULT_LEADER_TIMEOUT_MS = 30000;  // 30 seconds (< finalization window)

class OracleConsensus extends EventEmitter {

    constructor(hub, oracleRound) {
        super();
        this.hub         = hub;
        this.oracleRound = oracleRound;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Pending rounds: Map<round, { prices, digest, prepares: Set, commits: Set, finalized: bool, timer }>
        this.pendingRounds = new Map();

        // Rounds evicted on finalization timeout (leader and follower seats alike),
        // mirroring StateCheckpointEngine._roundTimeouts. Exposed as round_timeouts
        // through OracleRound.getSubmissionsInfo (the getoraclesubmissions RPC) so
        // the dashboard can alert on quorum-loss frequency (reviews 1468/1469).
        this._roundTimeouts = 0;

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

        // Already finalized rounds (prevents double-store), bounded FIFO (L1):
        // this set only ever grew (~1 entry per round), leaking for the process
        // lifetime. Cap it with an insertion-order ring; rounds finalize in
        // roughly ascending order so the oldest evicted round is far below the
        // live round and will never be re-proposed.
        this.finalized = new Set();
        this._finalizedOrder = [];
        this.finalizedMax = parseInt(process.env.ORACLE_FINALIZED_MAX, 10) || 10000;

        // Rounds this hub stored as 'skipped' for a LOCAL reason (its gossip lagged
        // below minSubmissions at the block boundary, or its own aggregate was
        // empty), NOT because the whole federation skipped (stress-sweep #7). These
        // are kept separate from `finalized` so a legitimate later PROPOSE from the
        // federation still processes: without this, a locally-skipped round landed
        // in `finalized`, _handlePropose dropped the real PROPOSE, and _handlePrepare
        // /_handleCommit refused to buffer, so the hub permanently held a NULL
        // price_snapshot for a round the rest of the federation finalized. When the
        // round does reach commit quorum here, _storeSnapshot's ON DUPLICATE KEY
        // UPDATE upgrades the 'skipped' rows to 'finalized' and _markFinalized moves
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
        // _pruneEarlyMessages an O(rounds) scan (O(n^2) CPU). Map preserves insertion
        // order, so eviction is FIFO on the oldest round key. 256 >> any legitimate
        // in-flight round concurrency (rounds are ~10 min apart).
        this.earlyMessageMaxRounds = parseInt(process.env.ORACLE_EARLY_MSG_MAX_ROUNDS) || 256;

        this.validatorSet = [];

        this._messageHandler = null;

        this.finalizationTimeout = parseInt(process.env.ORACLE_FINALIZATION_TIMEOUT) || DEFAULT_FINALIZATION_TIMEOUT;
        // Default to a 2-hub diversity floor: a single hub's single external source must never
        // become a federation-signed price. A real federation always clears 2; single-host / regtest
        // deployments set ORACLE_MIN_SUBMISSIONS=1 explicitly.
        this.minSubmissions      = parseInt(process.env.ORACLE_MIN_SUBMISSIONS) || 2;
        this.leaderTimeout       = parseInt(process.env.ORACLE_LEADER_TIMEOUT_MS) || DEFAULT_LEADER_TIMEOUT_MS;
        // : a proposed pair this follower can verify against NOTHING (no live
        // local aggregate AND no finalized history) used to fall through with only
        // the (0, PRICE_MAX) clamp, letting a Byzantine leader who is the sole
        // submitter for a brand-new pair get any value up to PRICE_MAX co-signed.
        // Default is fail closed: withhold co-sign on unverifiable pairs, so
        // finalization requires at least one follower that priced the pair itself.
        // Escape hatch for deliberate single-host / bootstrap deployments where no
        // second fetcher exists (regtest, ORACLE_MIN_SUBMISSIONS=1 setups).
        this.allowUnverifiedPairs = String(process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS || '') === 'true';
    }

    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    async start() {
        // Seed the in-memory last-finalized-price cache from price_snapshots so a
        // cold-started hub applies the same historical-deviation co-sign band a
        // warm hub does (seq 4382). Without this, _getLastFinalizedPrice returns
        // null on every pair until the hub itself stores a round, so a freshly
        // restarted hub would co-sign a Byzantine price for any pair it does not
        // locally submit that a long-running hub would withhold on. Local accept-
        // gate only: no signed bytes change, no reindex.
        await this._seedLastFinalizedPrices();
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        console.log('Oracle consensus engine started');
    }

    // Populate _lastFinalizedPrices with the most-recently-finalized price per
    // coin_pair from price_snapshots. Mirrors the cache keying in
    // _updateLastFinalizedPrices (key = coin_pair, value = price string) and the
    // "latest finalized = highest round_number" ordering used by hub.getPrice().
    // Fail-soft: an empty table or a query error leaves the cache empty (the prior
    // cold-start behavior), so this can never block hub startup.
    async _seedLastFinalizedPrices() {
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        try {
            // One row per coin_pair: the price from that pair's highest finalized
            // round. The subquery picks the max finalized round per pair, then the
            // join reads that round's price for the pair.
            let rows = await this.db.doQuery(
                "SELECT p.coin_pair AS coin_pair, p.price AS price " +
                "FROM price_snapshots p " +
                "JOIN (SELECT coin_pair, MAX(round_number) AS mx FROM price_snapshots " +
                "      WHERE status = 'finalized' AND price IS NOT NULL GROUP BY coin_pair) m " +
                "  ON p.coin_pair = m.coin_pair AND p.round_number = m.mx " +
                "WHERE p.status = 'finalized' AND p.price IS NOT NULL", []);
            let seeded = 0;
            for (let r of (rows || [])) {
                if (r.coin_pair && r.price !== null && r.price !== undefined) {
                    this._lastFinalizedPrices.set(r.coin_pair, String(r.price));
                    seeded++;
                }
            }
            if (seeded > 0)
                console.log('Oracle: seeded last-finalized-price cache with ' + seeded + ' pair(s) from price_snapshots');
        } catch (e) {
            console.warn('Oracle: could not seed last-finalized-price cache (continuing with empty cache):',
                e && e.message ? e.message : e);
        }
    }

    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for (let [round, pending] of this.pendingRounds) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        for (let [, t] of this.leaderTimers) clearTimeout(t);
        this.leaderTimers.clear();
        this.pendingRounds.clear();
        this.roundReadyAt.clear();
        this.earlyMessages.clear();
        this.earlyMessageTtl.clear();
    }

    // --- Early-message buffering (finding F7) ---

    _pruneEarlyMessages(now) {
        for (let [round, expiresAt] of this.earlyMessageTtl) {
            if (expiresAt <= now) {
                this.earlyMessages.delete(round);
                this.earlyMessageTtl.delete(round);
            }
        }
    }

    // Hold a PREPARE/COMMIT that arrived before this hub's pendingRounds entry
    // exists for the round. Replayed by _drainEarlyMessages once it does.
    _bufferEarlyMessage(round, envelope) {
        let now = Date.now();
        this._pruneEarlyMessages(now);
        let arr = this.earlyMessages.get(round);
        if (!arr) {
            // Bound the number of distinct buffered rounds (attacker picks `round`).
            // Map iteration is insertion-ordered, so evict the OLDEST round key first.
            while (this.earlyMessages.size >= this.earlyMessageMaxRounds) {
                let oldest = this.earlyMessages.keys().next().value;
                this.earlyMessages.delete(oldest);
                this.earlyMessageTtl.delete(oldest);
            }
            arr = [];
            this.earlyMessages.set(round, arr);
        }
        if (arr.length >= this.earlyMessageMaxPerRound) return;
        arr.push(envelope);
        this.earlyMessageTtl.set(round, now + this.earlyMessageTtlMs);
    }

    // Replay buffered envelopes through the normal dispatch path. Called from
    // both pendingRounds.set sites (proposer + follower). Deletes the queue
    // up-front so replayed messages can't re-buffer.
    _drainEarlyMessages(round) {
        let arr = this.earlyMessages.get(round);
        if (!arr) return;
        this.earlyMessages.delete(round);
        this.earlyMessageTtl.delete(round);
        for (let env of arr) {
            try { this._handleMessage(env); }
            catch (e) { console.error('Oracle: error replaying buffered message for round ' + round + ':', e.message); }
        }
    }

    // Record a finalized round under the bounded FIFO ring (L1). Evicts the
    // oldest round once the window is full so `finalized` cannot grow unbounded
    // over the process lifetime.
    _markFinalized(round) {
        // A round that genuinely finalizes supersedes any local skip marker for it
        // (the 'skipped' price_snapshots rows were upgraded to 'finalized' by
        // _storeSnapshot), so clear it from locallySkipped (stress-sweep #7).
        if (this.locallySkipped.delete(round)) {
            let i = this._locallySkippedOrder.indexOf(round);
            if (i !== -1) this._locallySkippedOrder.splice(i, 1);
        }
        if (this.finalized.has(round)) return;
        this.finalized.add(round);
        this._finalizedOrder.push(round);
        if (this._finalizedOrder.length > this.finalizedMax) {
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
        }
    }

    // Record a round this hub stored as 'skipped' for a local reason (stress-sweep
    // #7). Unlike _markFinalized this does NOT block a later federation PROPOSE from
    // processing; it only prevents this hub from re-skipping the same round and lets
    // getSubmissionsInfo/health distinguish a local skip from a true finalize.
    // Bounded by the same insertion-order ring as `finalized`.
    _markLocallySkipped(round) {
        if (this.finalized.has(round) || this.locallySkipped.has(round)) return;
        this.locallySkipped.add(round);
        this._locallySkippedOrder.push(round);
        if (this._locallySkippedOrder.length > this.finalizedMax) {
            let oldest = this._locallySkippedOrder.shift();
            this.locallySkipped.delete(oldest);
        }
    }

    // Minimum per-pair provider count observed across all of a round's submissions
    // (Infinity when no submission carries a per-pair `sources` count). A result of
    // <= 1 means at least one pair finalized this round with single-source (and thus
    // correlated, outlier-rejection-defeating) corroboration somewhere in the set.
    //
    // `capablePairs` (optional Set of coinPairs) restricts the scan to pairs that can
    // normally reach >=2 sources, so CoinGecko-only-by-design pairs (BTC/MXN, etc.,
    // which Kraken does not list) do not pin the minimum to 1 every healthy round.
    // Omitted -> no filtering (legacy behavior; relied on by unit tests).
    _minRoundSources(submissions, capablePairs) {
        let min = Infinity;
        if (!submissions) return min;
        for (let sub of submissions.values()) {
            if (sub && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (capablePairs && p && !capablePairs.has(p.coinPair)) continue;
                    let n = Number(p && p.sources);
                    if (Number.isFinite(n)) min = Math.min(min, n);
                }
            }
        }
        return min;
    }

    // Finalize a round. Called by OracleRound after the submission window closes.
    // btcBlockHeight and btcBlockTime are the BTC chain tip at the time the round was
    // triggered (used for the on-chain PRICE v0 anchor).
    //
    // If we're the deterministic leader, propose immediately. If we're a follower
    // and the leader is missing from submissions (e.g. its CoinGecko fetch failed),
    // the hub with the lowest addr (lex) among submitters takes over as fallback
    // proposer after a brief grace period, salvaging rounds where the leader has
    // no prices but other hubs do.
    async finalizeRound(round, btcBlockHeight, btcBlockTime) {
        if (this.finalized.has(round)) return;

        // Default to round number if BTC tip is unavailable (early bootstrap)
        btcBlockHeight = btcBlockHeight || round;
        btcBlockTime   = btcBlockTime   || Math.floor(Date.now() / 1000);

        let submissions = this.oracleRound.getSubmissions(round);
        if (!submissions || submissions.size === 0) {
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'no submissions');
            return;
        }

        if (submissions.size < this.minSubmissions) {
            console.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
                ' submission(s); minimum is ' + this.minSubmissions + ', skipping');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'below minimum submissions threshold');
            return;
        }

        // Source-diversity health signal (non-blocking). finalizeRound gates on hub
        // COUNT, never on per-submission source diversity, so a federation-wide
        // degradation to a single upstream (e.g. Kraken down everywhere, only
        // CoinGecko answering) finalizes and is PBFT-signed exactly as if it had the
        // "2 uncorrelated sources" corroboration the oracle is designed around. The
        // only prior signal was a per-hub PriceFetcher console.warn; this one is
        // federation-scoped (it sees every collected submission's per-pair count),
        // so it actually reflects whether the ROUND, not just this hub, lost its
        // second source. Surface it rather than letting the round pass silently; the
        // round still finalizes (no liveness change).
        //
        // Scope the scan to pairs that can normally reach >=2 sources. Pairs that are
        // CoinGecko-only by design (Kraken lists no MXN/CNY/BRL/INR/KRW, etc.) report
        // sources=1 in every healthy round, so without this filter the global minimum
        // is ~always 1 and the warn cries wolf on every finalization, training
        // operators to ignore the very signal that should flag a real degradation.
        let capablePairs   = this.oracleRound && this.oracleRound.priceFetcher
            ? this.oracleRound.priceFetcher.multiSourceCapablePairs() : null;
        let minRoundSources = this._minRoundSources(submissions, capablePairs);
        if (Number.isFinite(minRoundSources) && minRoundSources <= 1) {
            console.warn('Oracle: Round ' + round + ' finalizing with single-source corroboration ' +
                'on a normally-multi-source pair (minimum source count across the ' + submissions.size +
                ' submissions, restricted to multi-source-capable pairs = ' + minRoundSources +
                '); the federation lost its second uncorrelated price source this round. PRICE v0 is ' +
                'still quorum-signed but its outlier-rejection resilience is gone.');
        }

        // Lock the validator-set snapshot at the round's block boundary so
        // every hub computes the same quorum for this round, even when stake
        // state drifts mid-round. Spec: capability-staking-model.md §6.
        // Falls back to the live validator-set count when the indexer is
        // unreachable (graceful degradation; same behavior as before the
        // snapshot wiring landed).
        // STAKE_WEIGHTED_QUORUM: at/above the activation snapshot_block, finalize on
        // summed signer STAKE (>2/3 of S, source-deduped) rather than signer COUNT.
        // Gated on the round's BTC block boundary + the hub's network so the hub and
        // every indexer flip on the same anchor. When weighted, lock the source-keyed
        // weight snapshot; below activation, byte-for-byte the legacy count snapshot.
        let weighted = swq.isStakeWeightedQuorumActive(btcBlockHeight, this.hub.network);
        let snapshot = this.hub.capabilitySnapshot
            ? (weighted
                ? await this.hub.capabilitySnapshot.getWeightSnapshot('price', btcBlockHeight)
                : await this.hub.capabilitySnapshot.getSnapshot('price', btcBlockHeight))
            : null;

        // Fix (seq 4118): when weighted mode is active but the snapshot is absent or
        // carries no validators, fall back to count mode for this round rather than
        // entering PBFT with validators=[] and weighted=true. An empty weighted round
        // can never finalize (swq.meetsStakeThreshold([], signers) is always false)
        // and silently stalls for the full finalization timeout without storing a
        // skipped-round record. Falling back to count mode degrades gracefully and
        // keeps the round from stalling.
        if (weighted && (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)) {
            // Federation-split guard (fail closed), mirroring Consensus.js's posture
            // before its identical weighted->count flip. swq.isStakeWeightedQuorumActive
            // is a pure function of (block, network) that every honest hub computes
            // identically, so downgrading to a count quorum on THIS hub's weight-snapshot
            // reachability forks the finalization THRESHOLD semantics: peers finalize on
            // summed stake while this hub finalizes/stalls on a count quorum over the same
            // N validators. In a real federation, skip the round rather than diverge.
            // A single-node / regtest hub (no peers, _getQuorum()===0) has no peer to
            // split from, so it keeps the graceful count fallback below.
            if (this._getQuorum() > 0) {
                console.warn('Oracle: Round ' + round + ' weighted mode active but weight snapshot ' +
                    'unavailable while federated; skipping rather than downgrading to a count quorum ' +
                    'this hub\'s peers are not using.');
                await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                    'weighted quorum active but weight snapshot unavailable');
                return;
            }
            console.warn('Oracle: Round ' + round + ' weighted mode active but snapshot has no validators; falling back to count-based quorum');
            weighted = false;
            snapshot = this.hub.capabilitySnapshot
                ? await this.hub.capabilitySnapshot.getSnapshot('price', btcBlockHeight)
                : null;
        }

        // A federation whose price-qualifying set is empty at this block must skip
        // the round, not self-finalize it: getQuorum(empty)=0 would otherwise take
        // the single-node bypass below and publish a one-signature PRICE v0 the
        // indexer's stake gate rejects (see _isEmptyFederationSnapshot). Genuine
        // single-node / regtest bootstrap (no federation) is unaffected and still
        // self-finalizes via the quorum===0 path.
        if (this._isEmptyFederationSnapshot(snapshot)) {
            console.warn('Oracle: Round ' + round + ' qualified ZERO price validators at block ' +
                btcBlockHeight + ' while this hub is federated; skipping rather than self-finalizing a ' +
                'single-signature round the indexer stake gate would reject.');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'empty qualifying validator snapshot');
            return;
        }

        // Oracle M1: everything below (aggregation, minSubmissions floor, leader/
        // fallback election) must only see submissions from snapshot MEMBERS, one
        // per verified pubkey. Quorum is sized from the snapshot; letting any
        // merely-registered validator's submission through hands a no-stake key a
        // vote in the trimmed median every hub then co-signs. Null snapshot keeps
        // the unfiltered legacy map (graceful degradation, same as the quorum
        // fallback below).
        let memberPubkeys = this._memberPubkeySet(snapshot);
        submissions = this._filterSubmissionsToSnapshot(submissions, memberPubkeys);
        if (!submissions || submissions.size === 0) {
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                'no submissions from snapshot members');
            return;
        }
        if (submissions.size < this.minSubmissions) {
            console.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
                ' snapshot-member submission(s); minimum is ' + this.minSubmissions + ', skipping');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                'below minimum member submissions threshold');
            return;
        }

        let quorum = snapshot
            ? this.hub.capabilitySnapshot.getQuorum(snapshot)
            : this._getQuorum();
        if (quorum === 0) {
            let aggregated = this._aggregateAll(submissions);
            // Mirror the federated _proposeRound guard: _aggregateAll can
            // legitimately return [] while submissions exist (every pair dropped
            // by the price clamp or the 2-source deviation gate). Without this,
            // _storeSnapshot early-returns on empty prices (no finalized AND no
            // skipped row - a silent drop), yet _markFinalized still resets the
            // stall gauges and round:finalized still emits an empty-pair PRICE v0
            // on-chain. Store a durable skipped-round row and stop instead.
            if (aggregated.length === 0) {
                await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'aggregation yielded no prices');
                return;
            }
            // Sign locally and embed in the proof so the publisher can include the sig in PRICE v0
            let mySig = this._signPriceV0(round, btcBlockTime, aggregated, btcBlockHeight);
            let sigsArray = mySig ? [{ pubkey: mySig.pubkey, sig: mySig.sig }] : [];
            await this._storeSnapshot(round, aggregated, 1, JSON.stringify(sigsArray), btcBlockHeight, btcBlockTime);
            // Mark the round finalized so the guard at the top of finalizeRound()
            // dedupes any subsequent call for this round (prevents a duplicate
            // snapshot store / PRICE v0 broadcast).
            this._markFinalized(round);
            let selfAddr = this.peerManager.validatorAddr;
            this.emit('round:finalized', {
                round:          round,
                btcBlockHeight: btcBlockHeight,
                btcBlockTime:   btcBlockTime,
                prices:         aggregated,
                participants:   [selfAddr],
                signatures:     sigsArray,
                submissions:    submissions
            });
            return;
        }

        let leader   = this._getLeader(round, memberPubkeys);
        let myAddr   = this.peerManager.validatorAddr;
        let isLeader = this._isLeaderIdentity(leader, myAddr, this._resolveSenderPubkey(myAddr));

        if (isLeader) {
            this._proposeRound(round, submissions, false, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys);
            return;
        }

        // Follower path. Record when this round became ready to finalize so the
        // receiver-side leader-timeout grace in _handlePropose measures the same
        // window every other hub does.
        this._markRoundReady(round);

        let leaderSubAddr   = this._leaderSubmissionAddr(submissions, leader);
        let leaderSubmitted = leaderSubAddr != null;
        if (leaderSubmitted) {
            // The leader has a submission on record and is expected to broadcast
            // ORACLE_PROPOSE. But a leader can gossip its submission and then
            // crash before proposing, leaving every follower waiting out the full
            // finalization window. Arm a shorter leader-timeout: if no PROPOSE has
            // populated pendingRounds by then, the lowest-addr submitter OTHER THAN
            // the (presumed-dead) leader takes over as fallback proposer. Only the
            // elected fallback arms a timer; a live leader proposes immediately, so
            // by the time this fires the round is already taken and we abort.
            let fb = [...submissions.keys()].filter(a => a !== leaderSubAddr).sort()[0];
            if (fb === myAddr) {
                let t = setTimeout(() => {
                    this.leaderTimers.delete(round);
                    if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
                    // Same snapshot membership filter as the election above so a
                    // non-member submitter arriving during the grace cannot shift
                    // the fallback election (Oracle M1).
                    let subs = this._filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
                    if (!subs || subs.size === 0) return;
                    // Re-elect against the (possibly grown) submission set in case
                    // gossip delivered more submitters during the grace.
                    let fb2 = [...subs.keys()].filter(a => a !== this._leaderSubmissionAddr(subs, leader)).sort()[0];
                    if (fb2 !== myAddr) return;
                    this._proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys);
                }, this.leaderTimeout + FALLBACK_GRACE_MS);
                // Don't let an armed grace timer keep the process alive on its own;
                // the hub stays up via its other listeners. Cleared on stop().
                if (t.unref) t.unref();
                this.leaderTimers.set(round, t);
            }
            return;
        }

        // Leader has no submission. Lowest addr (lex) among submitters takes over.
        let fallbackAddr = [...submissions.keys()].sort()[0];
        if (fallbackAddr !== myAddr) {
            // Someone else is the fallback. Wait for their PROPOSE.
            return;
        }

        // I'm the fallback. Grace period in case a real-leader PROPOSE is in flight;
        // if pendingRounds gets populated during the grace, abort.
        let t = setTimeout(() => {
            this.leaderTimers.delete(round);
            if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
            // Filter to snapshot members, matching the election above (Oracle M1).
            let subs = this._filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
            if (!subs || subs.size === 0) return;
            this._proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys);
        }, FALLBACK_GRACE_MS);
        // Don't let this grace timer keep the process alive on its own; register
        // it so stop() can cancel it, matching the sibling timer above.
        if (t.unref) t.unref();
        this.leaderTimers.set(round, t);
    }

    // Propose a round (used both by the real leader and the fallback proposer).
    // snapshot + quorum are captured in finalizeRound() at the block boundary
    // and threaded through so the entire round uses the same locked validator
    // set. Without the snapshot, falls back to live _getQuorum() per legacy.
    _proposeRound(round, submissions, isFallback, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys) {
        let aggregated = this._aggregateAll(submissions);
        if (aggregated.length === 0) {
            this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'aggregation yielded no prices').catch(err =>
                console.error('Oracle: Error storing skipped round ' + round + ':', err.message));
            return;
        }

        let digest = this._digest(round, aggregated);

        // Sign the canonical PRICE v0 payload locally (this validator's contribution
        // to the on-chain anchor). Embedded in the published PRICE v0 transaction along
        // with sigs from other validators.
        let mySig = this._signPriceV0(round, btcBlockTime, aggregated, btcBlockHeight);

        let pending = {
            round:          round,
            prices:         aggregated,
            digest:         digest,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            prepares:       new Set(),
            commits:        new Set(),
            signatures:     new Map(),  // pubkey (hex) -> sig (hex)
            finalized:      false,
            timer:          null,
            // Snapshot of the validator set at this round's block boundary.
            // Locked here so _checkPrepareQuorum/_checkCommitQuorum compute
            // against the same N for the round's full lifecycle, even when
            // on-chain stake state changes mid-round (capability-staking spec §6).
            snapshot:       snapshot || null,
            quorum:         (typeof quorum === 'number' && quorum >= 0) ? quorum : this._getQuorum(),
            // STAKE_WEIGHTED_QUORUM round? Carry the source-keyed validator weights so
            // _checkPrepareQuorum/_checkCommitQuorum can tally signer stake (the count
            // quorum above is ignored when weighted).
            weighted:       !!weighted,
            validators:     (weighted && snapshot && Array.isArray(snapshot.validators))
                ? snapshot.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0') }))
                : [],
            // Snapshot member pubkeys for the count-mode vote tally (Oracle M1).
            // Null (no usable snapshot) keeps the legacy raw-sender count.
            memberPubkeys:  memberPubkeys || null
        };

        pending.prepares.add(this.peerManager.validatorAddr);
        if (mySig) pending.signatures.set(mySig.pubkey, mySig.sig);
        this.pendingRounds.set(round, pending);
        // Replay any PREPARE/COMMIT that beat this proposal (finding F7).
        this._drainEarlyMessages(round);

        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                // Count leader-seat quorum loss symmetrically with the follower-side
                // PROPOSE-round timeout in _handlePropose (review 1469): before this,
                // the eviction left no countable trace, so a leader repeatedly stuck
                // below commit quorum was invisible to the dashboard's oracle stall
                // ladder until lastSuccessAge aged past its warn band. Deliberately
                // NOT a _storeSkippedRound: that marks the round finalized locally
                // and would refuse a late-arriving quorum, unlike the follower path.
                this._roundTimeouts = (this._roundTimeouts || 0) + 1;
                console.warn('Oracle: Finalization timeout for round ' + round + ' ('
                    + pending.prepares.size + ' prepares, '
                    + pending.commits.size + ' commits, quorum ' + pending.quorum + ')');
                this.pendingRounds.delete(round);
            }
        }, this.finalizationTimeout);

        // Broadcast ORACLE_PROPOSE (includes proposer's signature on the canonical PRICE v0 payload).
        // submissionKeys carries the proposer's own view of the submission set (sorted) purely as a
        // diagnostic/wire-compat hint. Receivers do NOT trust it for fallback-proposer legitimacy;
        // that check is made solely against each receiver's locally-observed submissions (see
        // _handlePropose), since a peer-supplied set is attacker-controllable.
        this.peerManager.broadcast(ORACLE_PROPOSE, {
            round:          round,
            prices:         aggregated,
            digest:         digest,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            submissionKeys: [...submissions.keys()].sort(),
            sig_pubkey:     mySig ? mySig.pubkey : null,
            sig:            mySig ? mySig.sig    : null
        });

        let tag = isFallback ? '[FALLBACK] ' : '';
        console.log('Oracle: ' + tag + 'Proposed round ' + round + ' with ' + aggregated.length +
            ' prices (' + submissions.size + ' submissions)');

        this._checkPrepareQuorum(round);
    }

    // Defense-in-depth: only tally votes from senders that are registered
    // validators. PeerManager already drops messages whose signature doesn't
    // match a registered pubkey, but counting raw envelope.sender values means a
    // forged sender that slipped past that layer (e.g. during a null-registry
    // window) could otherwise inflate quorum from a single connection. The
    // registry is keyed by addr (the same value used as the sender). A null
    // registry fails closed (the vulnerability scenario); an empty registry stays
    // lenient ONLY until a chain-effective signer set exists (genuine pre-bootstrap, where the sig layer already rejects
    // unknown senders and no peer votes should be arriving).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) {
            // Empty-registry leniency is for the genuine pre-bootstrap window ONLY
            // (G-1/): once the on-chain snapshot has produced a non-empty
            // effective signer set, an empty registry is a misconfiguration or
            // wipe window, not bootstrap, and counting unattributable senders
            // would reopen count-mode quorum forgery. Fail closed instead.
            let signerSet = this.peerManager.effectiveSignerSet;
            return !(signerSet && signerSet.size > 0);
        }
        return registry.has(sender);
    }

    // Verified signing pubkey (lowercase hex) for a sender addr, or null. The
    // registry binding is enforced by PeerManager on every verified envelope
    // (a registered sender's envelope MUST be signed by its registered key), so
    // this resolves to the identity that actually signed, not a claim. Own addr
    // falls back to the local identity for hubs not present in their own registry.
    _resolveSenderPubkey(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        let pk = (registry && typeof registry.get === 'function') ? registry.get(sender) : null;
        if (!pk && sender === this.peerManager.validatorAddr) {
            let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
            if (identity) pk = identity.getPubkeyHex();
        }
        return pk ? String(pk).toLowerCase() : null;
    }

    // Pubkey set of a locked capability snapshot, or null when there is no usable
    // snapshot (indexer unreachable / empty validators). Null disables the
    // membership filter, preserving the legacy graceful-degradation path; the
    // empty-snapshot case is separately skipped via _isEmptyFederationSnapshot.
    _memberPubkeySet(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
        let set = new Set();
        for (let v of snapshot.validators) {
            if (v && v.pubkey) set.add(String(v.pubkey).toLowerCase());
        }
        return set.size > 0 ? set : null;
    }

    // Oracle M1: restrict a sender-keyed submission map to validators that are
    // members of the round's locked price snapshot, one submission per PUBKEY.
    // Quorum is sized from the snapshot, so submissions from merely-REGISTERED
    // validators (no qualifying stake) must not reach the trimmed median, the
    // minSubmissions floor, or the fallback-proposer election; and since the
    // registry may bind one key to several addrs, dedup on the verified key,
    // first arrival wins (Map iteration is insertion-ordered). A null memberPubkeys
    // (no usable snapshot) returns the map unchanged (legacy behavior).
    _filterSubmissionsToSnapshot(submissions, memberPubkeys) {
        if (!submissions || !memberPubkeys) return submissions;
        let filtered = new Map();
        let seen = new Set();
        for (let [addr, sub] of submissions) {
            let pk = (sub && sub.pubkey) ? sub.pubkey : this._resolveSenderPubkey(addr);
            if (!pk || !memberPubkeys.has(pk)) continue;
            if (seen.has(pk)) continue;
            seen.add(pk);
            filtered.set(addr, sub);
        }
        return filtered;
    }

    _handleMessage(envelope) {
        switch (envelope.type) {
            case ORACLE_PROPOSE:
                // _handlePropose is async because it locks the validator-set
                // snapshot at the round's block boundary via an indexer call.
                // Errors are caught and logged; they never bubble up to the gossip layer.
                this._handlePropose(envelope).catch(err =>
                    console.error('Oracle: PROPOSE handler error for round ' +
                        (envelope && envelope.data && envelope.data.round) + ':',
                        err && err.message ? err.message : err));
                break;
            case ORACLE_PREPARE: this._handlePrepare(envelope); break;
            case ORACLE_COMMIT:  this._handleCommit(envelope);  break;
        }
    }

    async _handlePropose(envelope) {
        let { round, prices, digest, btcBlockHeight, btcBlockTime, sig_pubkey, sig } = envelope.data;
        // Round 0 is a real, valid round (the first ORACLE_ROUND_INTERVAL after
        // ORACLE_EPOCH_START); guard on integer/non-negative, not falsiness, so a
        // genesis round-0 PROPOSE is not silently dropped as malformed.
        if (!Number.isInteger(round) || round < 0 || !prices || !digest) return;
        if (this.finalized.has(round)) return;

        // Discard proposals from senders that are not registered validators
        // before doing any snapshot/indexer work for them.
        if (!this._isKnownSender(envelope.sender)) return;

        // Verify digest
        let computedDigest = this._digest(round, prices);
        if (computedDigest !== digest) {
            console.warn('Oracle: PROPOSE digest mismatch from ' + envelope.sender + ' for round ' + round);
            return;
        }

        // Resolve the round's locked snapshot BEFORE validating the proposer
        // (Oracle M1): the fallback-proposer election below must run over the
        // same snapshot-member-filtered submission set every hub's finalizeRound
        // uses, or a non-member submitter could skew which sender this follower
        // accepts as the legitimate fallback. A pending round reuses its locked
        // member set; otherwise the snapshot is resolved here (the same
        // fail-closed guards that used to sit at pending creation, just earlier)
        // and consumed by the pending creation further down.
        let blockHeight = null, wt = false, snap = null, quorumForRound = null;
        let memberPubkeys = null;
        {
            let existing = this.pendingRounds.get(round);
            if (existing) {
                memberPubkeys = existing.memberPubkeys || null;
            } else {
                // Fix (#1225): do NOT substitute the round id for a missing BTC block
                // height on a federated hub. The leader locked the price snapshot at the
                // real round block in finalizeRound; pinning the follower's snapshot at
                // block_index = round (not a BTC boundary) locks a DIFFERENT (price, block)
                // set/quorum than the leader for the same round, or degrades to the null
                // path. Only reachable from a peer that omits the height (old peer mid
                // rolling deploy, or a malformed envelope) -- current honest senders always
                // populate it. Fail closed: drop the PROPOSE rather than pin to a fake block.
                // A single-node / regtest hub (_getQuorum()===0) has no peer to split from,
                // so it keeps the legacy round-as-anchor fallback for bootstrap.
                blockHeight = btcBlockHeight;
                if (!Number.isInteger(blockHeight) || blockHeight <= 0) {
                    if (this._getQuorum() > 0) {
                        console.warn('Oracle: dropping PROPOSE for round ' + round + ': no BTC block ' +
                            'height in envelope on a federated hub; refusing to pin the price snapshot ' +
                            'at the round id (not a BTC block boundary), which would diverge from the ' +
                            'leader\'s snapshot for this round.');
                        return;
                    }
                    blockHeight = round;
                }
                // Same activation gate + weight snapshot the leader locked in finalizeRound,
                // so this follower tallies the round identically (weighted on stake or legacy
                // on count), keyed on the round's BTC block boundary + the hub's network.
                wt = swq.isStakeWeightedQuorumActive(blockHeight, this.hub.network);
                snap = this.hub.capabilitySnapshot
                    ? (wt
                        ? await this.hub.capabilitySnapshot.getWeightSnapshot('price', blockHeight)
                        : await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight))
                    : null;
                // Mirror the finalizeRound() fallback: if weighted but no validators in the
                // snapshot, degrade to count mode so the round can finalize normally.
                if (wt && (!snap || !Array.isArray(snap.validators) || snap.validators.length === 0)) {
                    // Federation-split guard (fail closed), mirroring the leader-side guard
                    // in finalizeRound (#1222). swq.isStakeWeightedQuorumActive is a pure
                    // function of (block, network) every honest hub computes identically, so
                    // degrading THIS follower to a count quorum on its own weight-snapshot
                    // reachability (e.g. a per-RPC getstakeweightsbycapability failure) forks
                    // the finalization THRESHOLD: peers tally summed stake while this hub
                    // tallies a count over the same N. Skip the round rather than diverge.
                    // A single-node / regtest hub (_getQuorum()===0) has no peer to split
                    // from, so it keeps the graceful count fallback below.
                    if (this._getQuorum() > 0) {
                        console.warn('Oracle: dropping PROPOSE for round ' + round + ': weighted mode ' +
                            'active but weight snapshot unavailable while federated; refusing to open a ' +
                            'count-mode pending round this hub\'s peers are not using.');
                        return;
                    }
                    wt   = false;
                    snap = this.hub.capabilitySnapshot
                        ? await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight)
                        : null;
                }
                quorumForRound = snap
                    ? this.hub.capabilitySnapshot.getQuorum(snap)
                    : this._getQuorum();
                // Refuse to open a pending round on an empty federation snapshot: quorum
                // would be 0 and _quorumMet (count mode) returns `size >= 0` = true, so a
                // single PREPARE/COMMIT would finalize. A legitimate leader skips such a
                // round (finalizeRound), so a PROPOSE for one is spurious/Byzantine; drop
                // it. Genuine single-node hubs receive no PROPOSEs, and a healthy
                // federation snapshot is non-empty, so this only bites the bad case.
                if (this._isEmptyFederationSnapshot(snap)) {
                    console.warn('Oracle: dropping PROPOSE for round ' + round + ': empty price-qualifying ' +
                        'snapshot at block ' + blockHeight + ' on a federated hub (a legitimate leader skips ' +
                        'such a round; not accepting a single-signature finalization).');
                    return;
                }
                memberPubkeys = this._memberPubkeySet(snap);
            }
        }

        // Accept PROPOSE if sender is the deterministic leader OR an authorized
        // fallback (lowest-addr submitter when the leader has no submission).
        // The fallback path salvages rounds where the leader's price fetch
        // failed but other hubs have prices. The local submission view is
        // filtered to snapshot members (Oracle M1) so the election and the
        // deviation reference only see qualified validators.
        let leader       = this._getLeader(round, memberPubkeys);
        let submissions  = this._filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
        let isRealLeader = this._isLeaderIdentity(leader, envelope.sender, this._resolveSenderPubkey(envelope.sender));
        let isFallback   = false;

        if (!isRealLeader) {
            // Validate the fallback proposer against our LOCALLY-observed
            // submission set only. The PROPOSE also carries the proposer's own
            // claimed submission keys, but that list is attacker-controlled: a
            // Byzantine proposer can claim any subset whose lexicographically
            // lowest entry is its own address and thereby elect itself fallback
            // even while the deterministic leader has a valid submission. Trusting
            // it would let a single registered validator inject arbitrary prices
            // into any round. We therefore ignore the claimed list and elect the
            // fallback from the submissions we have actually seen.
            //
            // Trade-off: gossip delivery is async, so our local view may lag the
            // proposer's at the instant of election; in that window we may reject
            // a legitimate fallback and stall the round until the finalization
            // timeout re-elects. That liveness edge case is the accepted cost of
            // not trusting a peer-supplied set for a price-oracle integrity gate.
            let keys = submissions ? [...submissions.keys()] : [];
            if (keys.length > 0) {
                let leaderSubAddr   = this._leaderSubmissionAddr(submissions, leader);
                let leaderSubmitted = leaderSubAddr != null;
                if (!leaderSubmitted) {
                    let fallbackAddr = keys.sort()[0];
                    if (fallbackAddr === envelope.sender) isFallback = true;
                } else {
                    // Leader submitted but may have crashed before proposing. Accept
                    // a fallback from the lowest-addr submitter OTHER THAN the leader,
                    // but only after this hub's own leader-timeout grace has elapsed
                    // since the round became ready. An early (possibly malicious)
                    // fallback could otherwise usurp a still-alive leader and inject
                    // arbitrary prices. A live leader proposes immediately, so once
                    // the grace passes without a PROPOSE the leader is presumed dead.
                    // The sender is still validated against our LOCALLY-observed
                    // submission set, never a peer-supplied list (see the trust note
                    // above), preserving the price-integrity gate.
                    let readyAt = this.roundReadyAt.get(round);
                    if (readyAt && (Date.now() - readyAt) >= this.leaderTimeout) {
                        let fallbackAddr = keys.filter(a => a !== leaderSubAddr).sort()[0];
                        if (fallbackAddr === envelope.sender) isFallback = true;
                    }
                }
            }
        }

        if (!isRealLeader && !isFallback) {
            console.warn('Oracle: PROPOSE from non-leader ' + envelope.sender + ' for round ' + round);
            return;
        }

        if (isFallback) {
            console.log('Oracle: Accepting [FALLBACK] PROPOSE from ' + envelope.sender +
                ' for round ' + round + ' (leader ' + (leader ? leader.addr : 'unknown') + ' has no submission)');
        }

        // Content-validate the proposed prices before co-signing. Leadership rotates round-robin, so
        // a Byzantine or feed-broken validator gets a leader turn; without this check honest followers
        // would PREPARE/COMMIT and contribute signatures to whatever prices it proposed (the digest
        // check only proves the proposer's array hashes to its own digest). Mirror CrossChainEngine's
        // "never trust the proposer's claim": reject (no PREPARE/sign) any pair outside the hard
        // PRICE_MAX bound, or (when this hub has its own aggregate for the pair) more than the
        // federation-uniform ORACLE_DEVIATION_THRESHOLD away from it. This gate deliberately does
        // NOT read the per-operator SLASH_DEVIATION_THRESHOLD (constants.js explains why: per-hub
        // bands would split accept/withhold decisions at the +-band edge); SlashDetector defaults
        // its slash band to the same constant and fail-fasts on a tighter override, so by default
        // we never co-sign exactly what we'd be slashed for.
        // Fix (seq 4083): for pairs where this hub has no local submission, also check the last
        // finalized price_snapshots value if available, to narrow the acceptance window beyond the
        // very loose PRICE_MAX bound. Without this a Byzantine leader can inject any price in
        // (0, PRICE_MAX) for any pair that quorum co-signers did not price locally.
        {
            // Exclude the PROPOSER's own submission from the deviation reference: a
            // Byzantine leader/fallback must not be its own co-sign reference. With its
            // gossiped submission in the reference, a pair only IT submitted (in our local
            // view) self-validates at deviation 0, letting it inject any (0, PRICE_MAX)
            // price for pairs we did not independently fetch. Excluding it makes such a
            // pair fall through to the historical-snapshot bound below.
            // Resolve the proposer's verified pubkey and exclude EVERY addr bound to
            // it, not just envelope.sender: the registry may bind one key to several
            // addrs (see _addrForPubkey / _leaderSubmissionAddr), so a leader can gossip
            // its submission from addr A and PROPOSE from addr B. An addr-only exclusion
            // would leave A's price in the reference and let the pair self-validate at
            // deviation 0. Mirror _leaderSubmissionAddr's pubkey resolution; keep the
            // raw-addr guard as a belt-and-suspenders fallback for unknown-pubkey addrs.
            let refSubs = new Map();
            let proposerPk = this._resolveSenderPubkey(envelope.sender);
            if (submissions) for (let [addr, sub] of submissions) {
                if (addr === envelope.sender) continue;
                let pk = (sub && sub.pubkey) ? String(sub.pubkey).toLowerCase() : this._resolveSenderPubkey(addr);
                if (proposerPk && pk === proposerPk) continue;
                refSubs.set(addr, sub);
            }
            let localByPair  = new Map((this._aggregateAll(refSubs) || []).map(a => [a.coinPair, a.price]));
            // Federation-uniform deviation band (shared constant, not per-hub config) so
            // every hub's accept/withhold boundary is identical; deviation is computed in
            // bignumber (bcmath) per the platform mandate, removing the +-band-boundary
            // float-ULP ambiguity. A reject emits oracle:propose-rejected so a feed-
            // disagreement withhold is distinguishable from a leader crash.
            let devThreshold = ORACLE_DEVIATION_THRESHOLD;
            // Canonical-pair whitelist for the co-sign gate. Ingest already drops a
            // fabricated pair (OracleRound.canonicalPairs, built from
            // PriceFetcher.getCoinPairs()), but the propose path never re-checked it:
            // a pair the leader invents has no live local aggregate and no finalized
            // history, so both deviation gates below are structurally absent and it
            // falls through with only the (0, PRICE_MAX) bound. A single Byzantine
            // round-robin leader could thus get a non-canonical pair (e.g. BTC/ZZZ)
            // quorum co-signed and finalized. Read the SAME set the ingest path uses
            // (this.oracleRound.canonicalPairs) so the two cannot drift. Fail-open on
            // an empty/absent whitelist (bootstrap / misconfig) so honest followers
            // never withhold on legitimate pairs when the source is momentarily stale.
            let canonicalPairs = (this.oracleRound &&
                this.oracleRound.canonicalPairs && this.oracleRound.canonicalPairs.size)
                ? this.oracleRound.canonicalPairs
                : null;
            let reject = (coinPair, detail, extra) => {
                console.warn('Oracle: rejecting PROPOSE round ' + round + ' from ' + envelope.sender +
                    ': ' + coinPair + ' ' + detail);
                this.emit('oracle:propose-rejected', Object.assign({ round, sender: envelope.sender, coinPair }, extra || {}));
            };
            for (let p of prices) {
                let val = parseFloat(p.price);
                if (!(Number.isFinite(val) && val > 0 && val < PRICE_MAX)) {
                    reject(p.coinPair, 'price ' + p.price + ' outside (0, PRICE_MAX)',
                        { reason: 'out-of-range', proposed: String(p.price) });
                    return;
                }
                // Canonical-pair membership: withhold co-sign on any pair ingest would
                // have dropped, closing the fabricated-pair injection path (same fail-safe
                // withhold path as a deviation disagreement). Skipped when the whitelist is
                // empty/absent so a stale source cannot freeze honest followers.
                if (canonicalPairs && !canonicalPairs.has(p.coinPair)) {
                    reject(p.coinPair, 'pair not in canonical whitelist',
                        { reason: 'non-canonical-pair', proposed: String(p.price) });
                    return;
                }
                let local = localByPair.get(p.coinPair);
                if (local !== undefined && local !== null && bcmath.bcgt(local, '0')) {
                    // deviation = |proposed - local| / local, in bignumber
                    let diff    = bcmath.bcsub(p.price, local, 18);
                    let absDiff = bcmath.bclt(diff, 0) ? bcmath.bcmul(diff, '-1', 18) : diff;
                    let deviation = bcmath.bcdiv(absDiff, local, 18);
                    if (bcmath.bcgt(deviation, String(devThreshold))) {
                        let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
                        reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
                            '% from local ' + local + ' (> ' + (devThreshold * 100) + '%)',
                            { reason: 'deviation', proposed: String(p.price), local: String(local), deviation: bcmath.bcformat(deviation, 18) });
                        return;
                    }
                } else {
                    // No live local submission for this pair. Apply a tighter sanity check
                    // against the most recent finalized snapshot price when available, so a
                    // Byzantine leader cannot inject any (0, PRICE_MAX) value for pairs that
                    // quorum co-signers happened to not fetch in this round.
                    let lastPrice = this._getLastFinalizedPrice(p.coinPair);
                    if (lastPrice !== null && bcmath.bcgt(lastPrice, '0')) {
                        let diff      = bcmath.bcsub(p.price, lastPrice, 18);
                        let absDiff   = bcmath.bclt(diff, 0) ? bcmath.bcmul(diff, '-1', 18) : diff;
                        let deviation = bcmath.bcdiv(absDiff, lastPrice, 18);
                        // Use a wider band than the live-submission check to allow for
                        // genuine price movement between rounds, while still bounding a Byzantine
                        // leader from injecting values that are orders of magnitude off. The band
                        // is ORACLE_MAX_CHANGE_PER_ROUND, the same constant the aggregation clamp
                        // (_clampToLastFinalized) emits, so a maximally-clamped aggregate always
                        // passes this gate. Deriving both sides from one constant keeps them from
                        // drifting apart (constants.js states this as a federation-uniform contract).
                        let histThreshold = String(ORACLE_MAX_CHANGE_PER_ROUND);
                        if (bcmath.bcgt(deviation, histThreshold)) {
                            let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
                            reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
                                '% from last finalized ' + lastPrice + ' (no local submission, threshold ' + (ORACLE_MAX_CHANGE_PER_ROUND * 100) + '%)',
                                { reason: 'historical-deviation', proposed: String(p.price), lastFinalized: String(lastPrice), deviation: bcmath.bcformat(deviation, 18) });
                            return;
                        }
                    } else if (!this.allowUnverifiedPairs) {
                        // : no live local aggregate AND no finalized history means
                        // this follower can verify the value against nothing; only the
                        // (0, PRICE_MAX) clamp would apply. Withhold co-sign (same
                        // fail-safe path as a deviation disagreement) so a Byzantine
                        // leader who is the sole submitter for a brand-new pair cannot
                        // get an arbitrary value quorum co-signed. The pair finalizes
                        // once at least one co-signer prices it locally (next fetch
                        // cycle); ORACLE_ALLOW_UNVERIFIED_PAIRS=true restores the old
                        // clamp-only leniency for deliberate single-fetcher setups.
                        reject(p.coinPair, 'proposed ' + p.price + ' is unverifiable: no local submission and no finalized history',
                            { reason: 'unverifiable-new-pair', proposed: String(p.price) });
                        return;
                    }
                }
            }

            // Coverage check. The per-price loop above only bounds the pairs the
            // proposer chose to INCLUDE; it never checks for pairs the proposer
            // dropped. An honest leader proposes every pair the round priced (it
            // stores a skipped round rather than an empty/truncated set), so a
            // Byzantine leader omitting a pair this hub priced locally is the only
            // way to reach here with missing coverage. Withhold co-sign (same
            // fail-safe path as a deviation disagreement) so a suppressed pair can't
            // silently freeze consumers on the prior snapshot for the round window.
            if (!Array.isArray(prices) || prices.length === 0) {
                reject('(all)', 'empty or malformed price set', { reason: 'empty-proposal' });
                return;
            }
            let proposedPairs = new Set(prices.map(p => p && p.coinPair));
            for (let coinPair of localByPair.keys()) {
                if (!proposedPairs.has(coinPair)) {
                    reject(coinPair, 'priced locally but omitted from proposal', { reason: 'missing-pairs' });
                    return;
                }
            }
        }

        // Create or update pending round. The validator-set snapshot was locked
        // at the round's block boundary BEFORE the proposer validation above
        // (same snapshot the leader used in finalizeRound) so PREPARE/COMMIT
        // checks use the same N on every hub. blockHeight/wt/snap/quorumForRound
        // are only populated when no pending round existed at the top of this
        // handler; a concurrent handler creating one during the await is caught
        // by the has() re-check here.
        if (!this.pendingRounds.has(round) && quorumForRound !== null) {
            let quorum = quorumForRound;
            let pending = {
                round:          round,
                prices:         prices,
                digest:         digest,
                btcBlockHeight: blockHeight,
                btcBlockTime:   btcBlockTime   || Math.floor(Date.now() / 1000),
                prepares:       new Set(),
                commits:        new Set(),
                signatures:     new Map(),  // pubkey (hex) -> sig (hex)
                finalized:      false,
                snapshot:       snap || null,
                quorum:         quorum,
                weighted:       !!wt,
                validators:     (wt && snap && Array.isArray(snap.validators))
                    ? snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0') }))
                    : [],
                // Snapshot member pubkeys for the count-mode vote tally (Oracle M1).
                memberPubkeys:  memberPubkeys || null,
                timer:          setTimeout(() => {
                    // Surface the follower-side PROPOSE-round timeout (item 4268e0fb).
                    // The leader path logs its finalization timeout, but this eviction
                    // fired in total silence, hiding a follower stuck below commit quorum.
                    // Mirror the StateCheckpointEngine._roundTimeouts counter convention.
                    let p = this.pendingRounds.get(round);
                    if (p && !p.finalized) {
                        this._roundTimeouts = (this._roundTimeouts || 0) + 1;
                        console.warn('Oracle: PROPOSE round ' + round + ' timed out before commit quorum ('
                            + (p.prepares ? p.prepares.size : 0) + ' prepares, '
                            + (p.commits ? p.commits.size : 0) + ' commits, quorum ' + p.quorum + ')');
                    }
                    this.pendingRounds.delete(round);
                }, this.finalizationTimeout)
            };
            this.pendingRounds.set(round, pending);
            // Replay any PREPARE/COMMIT that arrived while this handler was
            // awaiting the snapshot fetch above (finding F7).
            this._drainEarlyMessages(round);
        }

        let pending = this.pendingRounds.get(round);
        // Guard against a second PROPOSE for the same round with a different
        // digest (mirrors the Consensus._handlePrePrepare fix in b8f5143).
        // Adding the sender to pending.prepares and broadcasting ORACLE_PREPARE
        // with the incoming digest would inflate the A-round prepare tally and
        // emit an orphaned PREPARE for digest B, the same protocol-noise pattern
        // the config engine fixed. COMMIT quorum still guards finalization, but
        // we should not mutate prepares or broadcast at all for a conflicting digest.
        if (pending.digest !== digest) {
            console.warn('Oracle: PROPOSE digest conflict for round ' + round +
                ' from ' + envelope.sender + ': expected ' + pending.digest + ', got ' + digest);
            return;
        }
        pending.prepares.add(envelope.sender);
        pending.prepares.add(this.peerManager.validatorAddr);

        if (sig_pubkey && sig) {
            this._verifyAndStoreSig(pending, sig_pubkey, sig);
        }

        let mySig = this._signPriceV0(round, pending.btcBlockTime, prices, pending.btcBlockHeight);
        if (mySig && !pending.signatures.has(mySig.pubkey)) {
            pending.signatures.set(mySig.pubkey, mySig.sig);
        }

        this.peerManager.broadcast(ORACLE_PREPARE, {
            round:      round,
            digest:     digest,
            sig_pubkey: mySig ? mySig.pubkey : null,
            sig:        mySig ? mySig.sig    : null
        });

        this._checkPrepareQuorum(round);
    }

    _handlePrepare(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!Number.isInteger(round) || round < 0 || !digest) return;   // round 0 is valid (see _handlePropose)

        // Only count PREPARE votes from registered validators.
        if (!this._isKnownSender(envelope.sender)) return;

        let pending = this.pendingRounds.get(round);
        if (!pending) {
            // No pending entry yet: the PROPOSE may still be in flight or its
            // handler mid-await on the snapshot fetch. Buffer instead of
            // dropping (finding F7); replayed once pendingRounds is populated.
            if (!this.finalized.has(round)) this._bufferEarlyMessage(round, envelope);
            return;
        }
        if (pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        if (sig_pubkey && sig) this._verifyAndStoreSig(pending, sig_pubkey, sig);
        this._checkPrepareQuorum(round);
    }

    _handleCommit(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!Number.isInteger(round) || round < 0 || !digest) return;   // round 0 is valid (see _handlePropose)

        // Only count COMMIT votes from registered validators.
        if (!this._isKnownSender(envelope.sender)) return;

        let pending = this.pendingRounds.get(round);
        if (!pending) {
            // Same early-arrival race as _handlePrepare (finding F7).
            if (!this.finalized.has(round)) this._bufferEarlyMessage(round, envelope);
            return;
        }
        if (pending.digest !== digest) return;

        pending.commits.add(envelope.sender);
        if (sig_pubkey && sig) this._verifyAndStoreSig(pending, sig_pubkey, sig);
        this._checkCommitQuorum(round);
    }

    // Whether the round has cleared quorum. STAKE_WEIGHTED_QUORUM tallies the
    // SUMMED STAKE (source-deduped, >2/3 of S) of validators that have produced a
    // valid signature on the canonical (keyed on `pending.signatures`) because,
    // unlike the DEX/checkpoint engines, this engine's prepare/commit sets hold
    // validator ADDRESSES while the snapshot + signatures are PUBKEY-keyed; the
    // signatures map is the only pubkey-keyed record of who endorsed the canonical,
    // and is exactly the signer set the indexer re-verifies (actions/price.js). A
    // value cannot finalize without >2/3 stake having signed it, so the published
    // PRICE always clears the indexer's identical weighted gate. Below activation:
    // byte-for-byte the legacy count of the passed vote set against the locked quorum.
    _quorumMet(pending, voteSet) {
        if (pending.weighted)
            return swq.meetsStakeThreshold(pending.validators, [...pending.signatures.keys()]);
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
        // Oracle M1: when the round has a locked snapshot, count-mode quorum tallies
        // DISTINCT MEMBER PUBKEYS, not raw sender addrs. The quorum above is sized
        // from the snapshot's qualified set, so a vote from a merely-registered
        // validator (or a second addr bound to a key that already voted) must not
        // count toward it. Senders that don't resolve to a registered key are
        // dropped (fail closed; they only exist in the empty-registry bootstrap
        // window, where no snapshot is available either). Null memberPubkeys keeps
        // the legacy raw count (graceful degradation, matching the quorum fallback).
        if (pending.memberPubkeys) {
            let counted = new Set();
            for (let sender of voteSet) {
                let pk = this._resolveSenderPubkey(sender);
                if (pk && pending.memberPubkeys.has(pk)) counted.add(pk);
            }
            return counted.size >= quorum;
        }
        return voteSet.size >= quorum;
    }

    _checkPrepareQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        // Use the round's locked quorum (snapshot at the block boundary),
        // not a live recompute, to keep every hub in lockstep across the round.
        if (this._quorumMet(pending, pending.prepares) && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);

            // Include this validator's signature in the COMMIT message so late-joining nodes
            // can collect signatures from any of the three phases (PROPOSE, PREPARE, COMMIT)
            let mySig = this._signPriceV0(round, pending.btcBlockTime, pending.prices, pending.btcBlockHeight);
            if (mySig && !pending.signatures.has(mySig.pubkey)) {
                pending.signatures.set(mySig.pubkey, mySig.sig);
            }

            this.peerManager.broadcast(ORACLE_COMMIT, {
                round:      round,
                digest:     pending.digest,
                sig_pubkey: mySig ? mySig.pubkey : null,
                sig:        mySig ? mySig.sig    : null
            });

            this._checkCommitQuorum(round);
        }
    }

    _checkCommitQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        // Same quorum rule as _checkPrepareQuorum (see _quorumMet).
        if (this._quorumMet(pending, pending.commits)) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);
            // Fire-and-forget (mirrors the prior promise-chain behavior); durability,
            // retry, and re-drive-on-failure live in _finalizeCommittedRound.
            this._finalizeCommittedRound(round);
        }
    }

    // Persist a quorum-finalized round's snapshot, then mark finalized + emit
    // round:finalized. A round reaching commit quorum carries collected validator
    // signatures, so a transient DB error while storing MUST NOT silently drop it
    // (the prior code deleted pending + tracking in the .catch with no retry and no
    // durable record, leaving pending.finalized already true so replayed COMMITs
    // could never re-finalize; the round evaporated on a one-off DB hiccup). Retry
    // the store a bounded number of times; only on durable success do we _markFinalized,
    // delete round state, and emit. If every attempt fails we do NOT delete round state
    // and we RESET pending.finalized=false, so a later replayed COMMIT re-enters
    // _checkCommitQuorum and re-drives finalization instead of the round being lost.
    async _finalizeCommittedRound(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending) return;

        let validatorCount = pending.prepares.size;
        let proof = JSON.stringify([...pending.commits]);

        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await this._storeSnapshot(round, pending.prices, validatorCount, proof,
                    pending.btcBlockHeight, pending.btcBlockTime);

                // Persistence succeeded: now (and only now) it is safe to finalize and
                // drop the in-memory round state.
                this._markFinalized(round);
                this.pendingRounds.delete(round);
                this._clearRoundTracking(round);
                console.log('Oracle: Round ' + round + ' finalized (' +
                    pending.prepares.size + ' prepares, ' +
                    pending.commits.size + ' commits)' +
                    (attempt > 1 ? ' after ' + attempt + ' store attempts' : ''));

                // Convert collected signatures to the [{pubkey, sig}, ...] array format used by OraclePublisher
                let sigsArray = [];
                for (let [pubkey, sig] of pending.signatures) {
                    sigsArray.push({ pubkey: pubkey, sig: sig });
                }

                this.emit('round:finalized', {
                    round:          round,
                    btcBlockHeight: pending.btcBlockHeight,
                    btcBlockTime:   pending.btcBlockTime,
                    prices:         pending.prices,
                    participants:   [...pending.prepares],
                    signatures:     sigsArray,
                    submissions:    this.oracleRound.getSubmissions(round)
                });
                return;
            } catch (err) {
                console.error('Oracle: Error storing snapshot for round ' + round +
                    ' (attempt ' + attempt + '/' + maxAttempts + '):', err.message);
                if (attempt < maxAttempts) {
                    // Linear backoff between retries for a transient DB hiccup.
                    await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    // The shared tree could have been cleared out from under us by a
                    // concurrent path; bail if the round is gone.
                    if (!this.pendingRounds.has(round)) return;
                }
            }
        }

        // Every store attempt failed. Do NOT delete round state and do NOT leave
        // pending.finalized=true: resetting it lets a subsequent replayed COMMIT
        // re-enter _checkCommitQuorum and re-drive finalization once the DB recovers,
        // rather than the quorum-signed round being silently and permanently dropped.
        console.error('Oracle: Round ' + round + ' snapshot store failed after ' +
            maxAttempts + ' attempts; retaining round state for re-finalization on the ' +
            'next COMMIT (round NOT dropped).');
        let stillPending = this.pendingRounds.get(round);
        if (stillPending) stillPending.finalized = false;
    }

    _aggregateAll(submissions) {
        if (!submissions) return [];   // no submission map for this round (guard: for..of undefined throws)
        let coinPairs = new Set();
        for (let [sender, sub] of submissions) {
            if (sub.prices && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (p.coinPair) coinPairs.add(p.coinPair);
                }
            }
        }

        let results = [];
        for (let pair of coinPairs) {
            let price = this._aggregate(submissions, pair);
            if (price !== null) {
                results.push({ coinPair: pair, price: price });
            }
        }
        return results;
    }

    // Aggregate a single coin pair using trimmed median
    _aggregate(submissions, coinPair) {
        if (!submissions) return null;
        // Collect all prices for this pair. Keep the original string `s` alongside a
        // float `f` used only for ordering. The median value itself is computed in
        // bignumber (bcmath) per the platform's bignumber mandate, so the
        // signed aggregate carries no float/`.toFixed` rounding artifact.
        let values = [];
        for (let [sender, sub] of submissions) {
            if (sub.prices && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (p.coinPair === coinPair && p.price) {
                        let val = parseFloat(p.price);
                        if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                            values.push({ f: val, s: String(p.price) });
                            // Cap each sender at one data point per pair. A
                            // submission could contain N entries for the same
                            // pair; counting them all would inflate values.length
                            // and shift the trim boundary, letting an outlier
                            // survive. Stop after the first valid value.
                            break;
                        }
                    }
                }
            }
        }

        if (values.length === 0) {
            // Surface the drop (item #180): without this line a pair whose every
            // submission fails the >0 / <PRICE_MAX clamp (or is absent) vanishes
            // from the round with no signal at all.
            console.warn('Oracle: dropping ' + coinPair + ' this round: no usable submission '
                + 'values (all missing, non-numeric, or outside the price clamp)');
            return null;
        }

        // Sort ascending (ordering only; float compare is fine here)
        values.sort((a, b) => a.f - b.f);

        // Exactly-2-source deviation gate (item 4496). With only two submissions the trim
        // below is a no-op, so the even-length median is a plain mean: one divergent source
        // drags the federation-signed price ~halfway toward it, with no outlier protection.
        // Refuse to publish this pair when the two disagree enough that the mean would put
        // BOTH submitters outside the deviation threshold, i.e. each is more than
        // ORACLE_DEVIATION_THRESHOLD from the mean, which for sorted values reduces to
        // (hi - lo) / (hi + lo) > threshold. That matches SlashDetector's default band
        // (it defaults to this same ORACLE_DEVIATION_THRESHOLD and fail-fasts on a tighter
        // override), so we never federation-sign a price we would then slash; the pair is
        // simply omitted this round and consumers hold the last snapshot.
        // Uses the hardcoded constant (not an env value) and bignumber math so every hub
        // gates identically. CONSENSUS-CRITICAL: deploy fleet-wide atomically.
        if (values.length === 2) {
            let lo = values[0].s, hi = values[1].s; // sorted ascending, both > 0
            let spread = bcmath.bcdiv(bcmath.bcsub(hi, lo, 8), bcmath.bcadd(lo, hi, 8), 8);
            if (bcmath.bcgt(spread, String(ORACLE_DEVIATION_THRESHOLD))) {
                console.warn('Oracle: dropping ' + coinPair + ' this round: only 2 sources and they '
                    + 'disagree beyond the ' + (ORACLE_DEVIATION_THRESHOLD * 100) + '% mean-deviation gate ('
                    + lo + ' vs ' + hi + ')');
                return null;
            }
        }

        // Trim top and bottom 15%. Use Math.ceil so at least one value is trimmed
        // once N >= 4 (Math.floor yields 0 for all N <= 6, making the trim a no-op
        // in small federations and leaving a single in-bounds outlier able to shift
        // a 2-source median by ~50%).
        let trimCount = Math.ceil(values.length * TRIM_PERCENT);
        if (trimCount > 0 && values.length > 2 * trimCount) {
            values = values.slice(trimCount, values.length - trimCount);
        }

        // Defensive: the slice above always leaves >= 1 value when it runs, but
        // if trimming ever empties the array, surface the drop instead of
        // silently omitting the pair (item #180).
        if (values.length === 0) {
            console.warn('Oracle: dropping ' + coinPair + ' this round: trimming emptied the value set');
            return null;
        }

        // Compute median in bignumber (no float midpoint average / .toFixed artifact)
        let mid = Math.floor(values.length / 2);
        let median;
        if (values.length % 2 === 0) {
            median = bcmath.bcformat(bcmath.bcdiv(bcmath.bcadd(values[mid - 1].s, values[mid].s, 8), '2', 8), 8);
        } else {
            median = bcmath.bcformat(values[mid].s, 8);
        }
        return this._clampToLastFinalized(coinPair, median);
    }

    // Per-pair bounded-change clamp . The trim + median above bound what a
    // MINORITY of bad feeds can do; nothing bounds the aggregate itself, so a real
    // fat-tail print (or a majority of correlated bad sources) still lands in one
    // round and immediately drives USD-pegged fee math. Bound the finalized price's
    // per-round movement to ORACLE_MAX_CHANGE_PER_ROUND relative to the pair's last
    // FINALIZED snapshot: a genuine sustained move walks to the new level over a few
    // rounds (cache updates each finalized round), a one-round spike is absorbed.
    // Deterministic federation-wide: every hub's _lastFinalizedPrices holds the same
    // finalized history (DB-seeded on start), so followers re-deriving the aggregate
    // clamp identically. No history (brand-new pair, cold standalone cache) means no
    // clamp; the  unverifiable-pair gate covers that case on the co-sign side.
    // CONSENSUS-CRITICAL: deploy fleet-wide atomically.
    _clampToLastFinalized(coinPair, price) {
        let last = this._getLastFinalizedPrice(coinPair);
        if (last === null || !bcmath.bcgt(last, '0')) return price;
        let maxDelta = bcmath.bcmul(last, String(ORACLE_MAX_CHANGE_PER_ROUND), 8);
        let hi = bcmath.bcadd(last, maxDelta, 8);
        let lo = bcmath.bcsub(last, maxDelta, 8);
        if (bcmath.bcgt(price, hi)) {
            console.warn('Oracle: clamping ' + coinPair + ' aggregate ' + price + ' to ' +
                bcmath.bcformat(hi, 8) + ' (last finalized ' + last + ', max +' +
                (ORACLE_MAX_CHANGE_PER_ROUND * 100) + '%/round)');
            return bcmath.bcformat(hi, 8);
        }
        if (bcmath.bclt(price, lo)) {
            console.warn('Oracle: clamping ' + coinPair + ' aggregate ' + price + ' to ' +
                bcmath.bcformat(lo, 8) + ' (last finalized ' + last + ', max -' +
                (ORACLE_MAX_CHANGE_PER_ROUND * 100) + '%/round)');
            return bcmath.bcformat(lo, 8);
        }
        return price;
    }

    async _storeSnapshot(round, prices, validatorCount, proof, btcBlockHeight, btcBlockTime) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        if (!prices || prices.length === 0) return;

        // Write the whole round in ONE multi-row INSERT (mirrors db.setParams) so the
        // round lands atomically. The per-pair loop this replaced let a getfeequote /
        // getpricesnapshots reader observe a torn round (some pairs from round N, others
        // from N-1) mid-loop, and the id-ordered mirror bootstrap could persist that torn
        // read to a replica. The hub Database exposes no transaction API, so a single
        // statement is the atomicity primitive here.
        let placeholders = prices.map(() => "(?, ?, ?, ?, 'BTC', ?, ?, 1, ?, 'finalized')").join(', ');
        let params = [];
        for (let p of prices) params.push(round, p.coinPair, p.price, referenceBlock, blockTimestamp, validatorCount, proof);
        let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE price = VALUES(price), reference_block = VALUES(reference_block),
                 block_timestamp = VALUES(block_timestamp), validator_count = VALUES(validator_count),
                 consensus_proof = VALUES(consensus_proof), status = 'finalized'`;
        await this.db.doQuery(query, params);

        // Durable per-pair skip markers (item #180). A pair can drop out of a
        // round that otherwise finalizes (aggregation clamp/deviation-gate/trim
        // returns null, or the leader simply didn't propose it); before this,
        // that pair got neither a 'finalized' nor a 'skipped' row, so consumers
        // silently fell back to the previous round with no observable signal.
        // Write a 'skipped' row (same shape as _storeSkippedRound) for every
        // configured pair absent from the finalized set, so the drop is durable,
        // countable, and visible to getSubmissionsInfo/dashboard health. This is
        // derived from the finalized proposal + local pair config, so every hub
        // writes the same rows deterministically. Best-effort: never fail the
        // finalized write over the marker.
        try {
            let finalizedPairs = new Set(prices.map(p => p.coinPair));
            let missingPairs = PriceFetcher.getCoinPairs().filter(pair => !finalizedPairs.has(pair));
            if (missingPairs.length) {
                console.warn('Oracle: round ' + round + ' finalized without ' + missingPairs.length
                    + ' configured pair(s): ' + missingPairs.join(', ')
                    + '; recording per-pair skipped snapshot(s)');
                let skipPlaceholders = missingPairs.map(() => "(?, ?, NULL, ?, 'BTC', ?, 0, 1, '[]', 'skipped')").join(', ');
                let skipParams = [];
                for (let pair of missingPairs) skipParams.push(round, pair, referenceBlock, blockTimestamp);
                await this.db.doQuery(`INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                     validator_count, consensus_round, consensus_proof, status)
                    VALUES ${skipPlaceholders}
                    ON DUPLICATE KEY UPDATE
                     reference_block = IF(status = 'skipped', VALUES(reference_block), reference_block),
                     block_timestamp = IF(status = 'skipped', VALUES(block_timestamp), block_timestamp),
                     status = IF(status = 'skipped', 'skipped', status)`, skipParams);
            }
        } catch (e) {
            console.error('Oracle: error recording per-pair skipped snapshot(s) for round ' + round + ':', e.message);
        }

        // Update the in-memory last-finalized-price cache so the co-sign gate in
        // _handlePropose can apply a historical-deviation check for pairs a hub
        // did not price locally in the current round (seq 4083).
        this._updateLastFinalizedPrices(prices);

        // Broadcast the finalized rows to hub-DB mirror subscribers (distributed indexers),
        // mirroring StateCheckpointEngine/CrossChainDexEngine. This must happen AFTER the
        // atomic write so a subscriber never sees a partial round. Without this the round
        // is written via a bare INSERT that emits nothing, so a replica's price mirror never
        // receives it live and _priceSyncSatisfied passes while the round is absent, causing
        // the replica to validate native-coin fees against the prior round (ledger divergence).
        // Best-effort; never block finalize.
        if (this.hub && this.hub.hubDbBroadcaster) {
            try {
                let rows = await this.db.doQuery(
                    'SELECT * FROM price_snapshots WHERE round_number=? ORDER BY coin_pair', [round]);
                for (let row of rows) this.hub.hubDbBroadcaster.broadcastRow({ table: 'price_snapshots', row });
            } catch (e) { /* broadcast is best-effort */ }
        }
    }

    // reason: short string describing why the round was skipped ('no submissions',
    // 'below minimum submissions threshold', etc.); surfaced in the skip log so
    // operators can tell a full outage apart from a quorum shortfall.
    async _storeSkippedRound(round, btcBlockHeight, btcBlockTime, reason) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        let coinPairs = PriceFetcher.getCoinPairs();
        // One multi-row INSERT so the skipped round lands atomically (same torn-read
        // rationale as _storeSnapshot).
        if (coinPairs.length) {
            let placeholders = coinPairs.map(() => "(?, ?, NULL, ?, 'BTC', ?, 0, 1, '[]', 'skipped')").join(', ');
            let params = [];
            for (let pair of coinPairs) params.push(round, pair, referenceBlock, blockTimestamp);
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                 reference_block = IF(status = 'skipped', VALUES(reference_block), reference_block),
                 block_timestamp = IF(status = 'skipped', VALUES(block_timestamp), block_timestamp),
                 status = IF(status = 'skipped', 'skipped', status)`;
            await this.db.doQuery(query, params);
        }
        // Broadcast the skipped-round rows to hub-DB mirror subscribers, mirroring
        // _storeSnapshot. Both insert paths into the mirrored price_snapshots table must
        // feed HubDbBroadcaster or a live streaming mirror never receives the skipped
        // rows (it gets them only on the next re-bootstrap), diverging from a
        // freshly-bootstrapped mirror. Best-effort; never block finalize.
        if (coinPairs.length && this.hub && this.hub.hubDbBroadcaster) {
            try {
                let rows = await this.db.doQuery(
                    'SELECT * FROM price_snapshots WHERE round_number=? ORDER BY coin_pair', [round]);
                for (let row of rows) this.hub.hubDbBroadcaster.broadcastRow({ table: 'price_snapshots', row });
            } catch (e) { /* broadcast is best-effort */ }
        }
        // #7: mark as LOCALLY skipped, not finalized, so a legitimate later PROPOSE
        // from the federation still processes and can upgrade the 'skipped' rows to
        // 'finalized'. _markFinalized would have frozen this round's NULL price here.
        this._markLocallySkipped(round);
        this._clearRoundTracking(round);
        console.log('Oracle: Round ' + round + ' skipped (' + (reason || 'no submissions') + ')');
    }

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/ed25519.js buildPriceV0Payload exactly so signatures
    // produced here verify against the same canonical bytes when indexers parse on-chain PRICE v0 actions.
    _buildPriceV0Payload(round, btcBlockTime, prices, btcBlockHeight) {
        let pairs = prices.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
        let sortedPairs = [...pairs].sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        let raw = JSON.stringify({
            round:            parseInt(round),
            timestamp:        parseInt(btcBlockTime),
            btc_block_height: parseInt(btcBlockHeight),
            pairs:            sortedPairs
        });
        // EQUIV header (WI-2 bump 2): gated on the round's BTC block HEIGHT + the hub's
        // network, byte-matching ed25519.buildPriceV0Payload. The height is in the signed
        // content and the on-chain wire so every indexer reconstructs identical bytes and
        // flips on the same anchor every other engine uses (#4232). XORACLE has no view ->
        // VIEW=0; ROUND_ID is the BTC height (the real activation anchor).
        if (eq.isEquivHeaderActive(btcBlockHeight, this.hub && this.hub.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parseInt(btcBlockHeight), 0, raw);
        return raw;
    }

    // Sign the canonical PRICE v0 payload with the local validator identity
    // Returns { pubkey, sig } or null if no identity is configured
    _signPriceV0(round, btcBlockTime, prices, btcBlockHeight) {
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (!identity) return null;
        try {
            let payload = this._buildPriceV0Payload(round, btcBlockTime, prices, btcBlockHeight);
            let sigHex  = identity.sign(payload);
            return { pubkey: identity.getPubkeyHex(), sig: sigHex };
        } catch (e) {
            console.warn('Oracle: failed to sign PRICE v0 payload:', e);
            return null;
        }
    }

    // Verify a (pubkey, sig) pair against the pending round's canonical PRICE v0 payload,
    // and store it on the pending round's signatures map if valid.
    // The pending object must have a `round` field set when it's created.
    _verifyAndStoreSig(pending, pubkeyHex, sigHex) {
        if (!pending || !pubkeyHex || !sigHex) return false;
        if (pending.signatures.has(pubkeyHex)) return false; // already collected
        if (pending.round === undefined || pending.round === null) {
            console.warn('Oracle: cannot verify sig: pending round has no round number');
            return false;
        }
        try {
            let payload = this._buildPriceV0Payload(pending.round, pending.btcBlockTime, pending.prices, pending.btcBlockHeight);
            let ok = ValidatorIdentity.verify(payload, sigHex, pubkeyHex);
            if (ok) {
                pending.signatures.set(pubkeyHex, sigHex);
                return true;
            } else {
                console.warn('Oracle: invalid PRICE v0 signature from ' + pubkeyHex.substring(0, 16) + '... for round ' + pending.round);
                return false;
            }
        } catch (e) {
            console.warn('Oracle: signature verification error:', e);
            return false;
        }
    }

    // Return the most recently finalized price for a coin pair from price_snapshots,
    // or null if unavailable. Used by the co-sign gate to apply a historical-deviation
    // check for pairs this hub has no live local submission for (seq 4083).
    // Synchronous best-effort: reads from the in-memory cache populated by
    // _storeSnapshot. Falls back to null when not cached (first round, cold start).
    _getLastFinalizedPrice(coinPair) {
        if (!this._lastFinalizedPrices) return null;
        return this._lastFinalizedPrices.get(coinPair) || null;
    }

    // Update the in-memory last-finalized-price cache after a round is stored.
    // Called at the end of _storeSnapshot.
    _updateLastFinalizedPrices(prices) {
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        for (let p of prices) {
            if (p.coinPair && p.price) this._lastFinalizedPrices.set(p.coinPair, String(p.price));
        }
    }

    // Record the first time we saw this round as ready to finalize. The
    // receiver-side leader-timeout grace in _handlePropose measures from here.
    // Opportunistically evicts entries for rounds that never finalized (the rare
    // stuck case) so the map can't grow unbounded.
    _markRoundReady(round) {
        let now = Date.now();
        let ttl = this.finalizationTimeout * 2 + this.leaderTimeout;
        for (let [r, ts] of this.roundReadyAt) {
            if (now - ts > ttl) this.roundReadyAt.delete(r);
        }
        if (!this.roundReadyAt.has(round)) this.roundReadyAt.set(round, now);
    }

    // Forget per-round leader-timeout bookkeeping once the round is done.
    _clearRoundTracking(round) {
        this.roundReadyAt.delete(round);
        let t = this.leaderTimers.get(round);
        if (t) {
            clearTimeout(t);
            this.leaderTimers.delete(round);
        }
    }

    //  (Hub F3): when the round has a block-locked snapshot, the leader
    // is derived from the snapshot's member pubkeys (sorted, round % N), NOT
    // the live registered validatorSet. The live set drifts with registration
    // churn mid-round, so live-set indexing lets two hubs elect different
    // leaders for the same round and reject each other's legitimate PROPOSE
    // (liveness stall until fallback/timeout). The snapshot is already the
    // federation-deterministic set every hub locks at the round's block
    // boundary, so deriving the leader from it keeps the election identical
    // everywhere. Without a usable snapshot (memberPubkeys null), legacy
    // live-set rotation is preserved (graceful-degradation path).
    _getLeader(round, memberPubkeys) {
        if (memberPubkeys && memberPubkeys.size > 0) {
            let keys = [...memberPubkeys].sort();
            let pubkey = keys[round % keys.length];
            return { addr: this._addrForPubkey(pubkey), pubkey: pubkey };
        }
        if (this.validatorSet.length === 0) return null;
        return this.validatorSet[round % this.validatorSet.length];
    }

    // Resolve a (lowercase) signing pubkey to its P2P addr: the loaded
    // validator set first, then the peer registry (lowest addr wins so a key
    // bound to several addrs resolves identically on every hub), then own
    // identity. Null when unknown; leader-addr comparisons then fail and the
    // fallback-proposer election salvages the round.
    _addrForPubkey(pubkey) {
        for (let v of this.validatorSet) {
            if (v && v.pubkey && String(v.pubkey).toLowerCase() === pubkey) return v.addr;
        }
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (registry && typeof registry.get === 'function') {
            let matches = [];
            for (let [addr, pk] of registry) {
                if (pk && String(pk).toLowerCase() === pubkey) matches.push(addr);
            }
            if (matches.length > 0) return matches.sort()[0];
        }
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (identity && String(identity.getPubkeyHex()).toLowerCase() === pubkey) {
            return this.peerManager.validatorAddr;
        }
        return null;
    }

    // True when `addr` (with verified pubkey `pubkey`, may be null) is the
    // round leader. Matches on addr OR verified pubkey so a snapshot-derived
    // leader is still recognized when this hub's addr binding for that key
    // differs from the one _addrForPubkey picked.
    _isLeaderIdentity(leader, addr, pubkey) {
        if (!leader) return false;
        if (leader.addr && leader.addr === addr) return true;
        let lpk = leader.pubkey ? String(leader.pubkey).toLowerCase() : null;
        return !!(lpk && pubkey && lpk === pubkey);
    }

    // Addr under which the leader's submission is recorded in a
    // snapshot-filtered submission map (keys are addrs, values carry the
    // verified pubkey), or null when the leader has not submitted.
    _leaderSubmissionAddr(submissions, leader) {
        if (!leader || !submissions) return null;
        if (leader.addr && submissions.has(leader.addr)) return leader.addr;
        let lpk = leader.pubkey ? String(leader.pubkey).toLowerCase() : null;
        if (!lpk) return null;
        for (let [addr, sub] of submissions) {
            let pk = (sub && sub.pubkey) ? sub.pubkey : this._resolveSenderPubkey(addr);
            if (pk === lpk) return addr;
        }
        return null;
    }

    _getQuorum() {
        let N = this.validatorSet.length;
        if (N <= 0) {
            // Fall back to peer count
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        if (N <= 1) return 0;
        let f = Math.floor((N - 1) / 3);
        // Majority floor: bare 2f+1 degenerates to quorum=1 at N=3 (f=0),
        // letting a single validator finalize alone.
        return Math.max(2 * f + 1, Math.ceil((N + 1) / 2));
    }

    // True when a capability snapshot was fetched but qualified ZERO validators
    // AND this hub is part of a federation. getQuorum() over an empty snapshot
    // returns 0, which collides with the genuine single-node bypass; taking that
    // bypass in a federation self-finalizes the round with ONE signature, storing
    // a divergent 'finalized' row and publishing a PRICE v0 the indexer's
    // >2/3-stake gate then rejects. Such a round must be SKIPPED instead. The
    // federation test is `_getQuorum() > 0` (validatorSet has >=2 registered
    // members, or a live peer is connected); a genuine single-node / regtest
    // bootstrap has `_getQuorum() === 0`, so it keeps the self-finalize path. A
    // null snapshot (indexer unreachable) is NOT this case: that is the separate
    // graceful-degradation-to-live-count path and is left untouched.
    _isEmptyFederationSnapshot(snapshot) {
        if (!snapshot) return false;
        let vals = snapshot.validators;
        let empty = !Array.isArray(vals) || vals.length === 0;
        return empty && this._getQuorum() > 0;
    }

    _digest(round, prices) {
        let payload = JSON.stringify({ round: round, prices: prices });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = OracleConsensus;
