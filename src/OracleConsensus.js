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
 ********************************************************************/

const crypto            = require('crypto');
const EventEmitter      = require('events');
const PriceFetcher      = require('./PriceFetcher.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD } = require('./constants.js');
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

        // Already finalized rounds (prevents double-store)
        this.finalized = new Set();

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

        // Validator set (loaded from hub)
        this.validatorSet = [];

        // Message handler
        this._messageHandler = null;

        // Config
        this.finalizationTimeout = parseInt(process.env.ORACLE_FINALIZATION_TIMEOUT) || DEFAULT_FINALIZATION_TIMEOUT;
        // Default to a 2-hub diversity floor: a single hub's single external source must never
        // become a federation-signed price. A real federation always clears 2; single-host / regtest
        // deployments set ORACLE_MIN_SUBMISSIONS=1 explicitly.
        this.minSubmissions      = parseInt(process.env.ORACLE_MIN_SUBMISSIONS) || 2;
        this.leaderTimeout       = parseInt(process.env.ORACLE_LEADER_TIMEOUT_MS) || DEFAULT_LEADER_TIMEOUT_MS;
    }

    // Set the validator set for quorum calculation and leader selection
    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    // Start listening for oracle consensus messages
    async start() {
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        console.log('Oracle consensus engine started');
    }

    // Stop the oracle consensus engine
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
            // No submissions: skip the round
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'no submissions');
            return;
        }

        // Enforce minimum submission count
        if (submissions.size < this.minSubmissions) {
            console.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
                ' submission(s); minimum is ' + this.minSubmissions + ', skipping');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'below minimum submissions threshold');
            return;
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
            console.warn('Oracle: Round ' + round + ' weighted mode active but snapshot has no validators; falling back to count-based quorum');
            weighted = false;
            snapshot = this.hub.capabilitySnapshot
                ? await this.hub.capabilitySnapshot.getSnapshot('price', btcBlockHeight)
                : null;
        }

        let quorum = snapshot
            ? this.hub.capabilitySnapshot.getQuorum(snapshot)
            : this._getQuorum();
        if (quorum === 0) {
            let aggregated = this._aggregateAll(submissions);
            // Sign locally and embed in the proof so the publisher can include the sig in PRICE v0
            let mySig = this._signPriceV0(round, btcBlockTime, aggregated);
            let sigsArray = mySig ? [{ pubkey: mySig.pubkey, sig: mySig.sig }] : [];
            await this._storeSnapshot(round, aggregated, 1, JSON.stringify(sigsArray), btcBlockHeight, btcBlockTime);
            // Mark the round finalized so the guard at the top of finalizeRound()
            // dedupes any subsequent call for this round (prevents a duplicate
            // snapshot store / PRICE v0 broadcast).
            this.finalized.add(round);
            // Emit finalization event for single-node mode
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

        let leader   = this._getLeader(round);
        let myAddr   = this.peerManager.validatorAddr;
        let isLeader = leader && leader.addr === myAddr;

        if (isLeader) {
            this._proposeRound(round, submissions, false, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted);
            return;
        }

        // Follower path. Record when this round became ready to finalize so the
        // receiver-side leader-timeout grace in _handlePropose measures the same
        // window every other hub does.
        this._markRoundReady(round);

        let leaderSubmitted = leader && submissions.has(leader.addr);
        if (leaderSubmitted) {
            // The leader has a submission on record and is expected to broadcast
            // ORACLE_PROPOSE. But a leader can gossip its submission and then
            // crash before proposing, leaving every follower waiting out the full
            // finalization window. Arm a shorter leader-timeout: if no PROPOSE has
            // populated pendingRounds by then, the lowest-addr submitter OTHER THAN
            // the (presumed-dead) leader takes over as fallback proposer. Only the
            // elected fallback arms a timer; a live leader proposes immediately, so
            // by the time this fires the round is already taken and we abort.
            let fb = [...submissions.keys()].filter(a => !leader || a !== leader.addr).sort()[0];
            if (fb === myAddr) {
                let t = setTimeout(() => {
                    this.leaderTimers.delete(round);
                    if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
                    let subs = this.oracleRound.getSubmissions(round);
                    if (!subs || subs.size === 0) return;
                    // Re-elect against the (possibly grown) submission set in case
                    // gossip delivered more submitters during the grace.
                    let fb2 = [...subs.keys()].filter(a => !leader || a !== leader.addr).sort()[0];
                    if (fb2 !== myAddr) return;
                    this._proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted);
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
        setTimeout(() => {
            if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
            let subs = this.oracleRound.getSubmissions(round);
            if (!subs || subs.size === 0) return;
            this._proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted);
        }, FALLBACK_GRACE_MS);
    }

    // Propose a round (used both by the real leader and the fallback proposer).
    // snapshot + quorum are captured in finalizeRound() at the block boundary
    // and threaded through so the entire round uses the same locked validator
    // set. Without the snapshot, falls back to live _getQuorum() per legacy.
    _proposeRound(round, submissions, isFallback, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted) {
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
        let mySig = this._signPriceV0(round, btcBlockTime, aggregated);

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
                : []
        };

        // Add own PREPARE vote and signature
        pending.prepares.add(this.peerManager.validatorAddr);
        if (mySig) pending.signatures.set(mySig.pubkey, mySig.sig);
        this.pendingRounds.set(round, pending);
        // Replay any PREPARE/COMMIT that beat this proposal (finding F7).
        this._drainEarlyMessages(round);

        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                console.warn('Oracle: Finalization timeout for round ' + round);
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

    // --- Message handlers ---

    // Defense-in-depth: only tally votes from senders that are registered
    // validators. PeerManager already drops messages whose signature doesn't
    // match a registered pubkey, but counting raw envelope.sender values means a
    // forged sender that slipped past that layer (e.g. during a null-registry
    // window) could otherwise inflate quorum from a single connection. The
    // registry is keyed by addr (the same value used as the sender). A null
    // registry fails closed (the vulnerability scenario); an empty registry
    // stays lenient (genuine pre-bootstrap, where the sig layer already rejects
    // unknown senders and no peer votes should be arriving).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) return true;
        return registry.has(sender);
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
        if (!round || !prices || !digest) return;
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

        // Accept PROPOSE if sender is the deterministic leader OR an authorized
        // fallback (lowest-addr submitter when the leader has no submission).
        // The fallback path salvages rounds where the leader's price fetch
        // failed but other hubs have prices.
        let leader       = this._getLeader(round);
        let submissions  = this.oracleRound.getSubmissions(round);
        let isRealLeader = leader && leader.addr === envelope.sender;
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
                let leaderSubmitted = leader && keys.includes(leader.addr);
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
                        let fallbackAddr = keys.filter(a => !leader || a !== leader.addr).sort()[0];
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
        // PRICE_MAX bound, or (when this hub has its own aggregate for the pair) more than the slash
        // deviation threshold away from it, refusing to co-sign exactly what we'd be slashed for.
        // Fix (seq 4083): for pairs where this hub has no local submission, also check the last
        // finalized price_snapshots value if available, to narrow the acceptance window beyond the
        // very loose PRICE_MAX bound. Without this a Byzantine leader can inject any price in
        // (0, PRICE_MAX) for any pair that quorum co-signers did not price locally.
        {
            let localByPair  = new Map((this._aggregateAll(submissions) || []).map(a => [a.coinPair, a.price]));
            // Federation-uniform deviation band (shared constant, not per-hub config) so
            // every hub's accept/withhold boundary is identical; deviation is computed in
            // bignumber (bcmath) per the platform mandate, removing the +-band-boundary
            // float-ULP ambiguity. A reject emits oracle:propose-rejected so a feed-
            // disagreement withhold is distinguishable from a leader crash.
            let devThreshold = ORACLE_DEVIATION_THRESHOLD;
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
                let local = localByPair.get(p.coinPair);
                if (local !== undefined && local !== null && bcmath.bcgt(local, '0')) {
                    // deviation = |proposed - local| / local, in bignumber
                    let diff    = bcmath.bcsub(p.price, local, 18);
                    let absDiff = bcmath.bclt(diff, 0) ? bcmath.bcmul(diff, '-1', 18) : diff;
                    let deviation = bcmath.bcdiv(absDiff, local, 18);
                    if (bcmath.bcgt(deviation, String(devThreshold))) {
                        let pct = bcmath.bcstr(bcmath.bcmul(deviation, '100', 4), 4);
                        reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
                            '% from local ' + local + ' (> ' + (devThreshold * 100) + '%)',
                            { reason: 'deviation', proposed: String(p.price), local: String(local), deviation: bcmath.bcstr(deviation, 18) });
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
                        // Use a wider band than the live-submission check (5x) to allow for
                        // genuine price movement between rounds, while still bounding a Byzantine
                        // leader from injecting values that are orders of magnitude off.
                        let histThreshold = String(devThreshold * 5);
                        if (bcmath.bcgt(deviation, histThreshold)) {
                            let pct = bcmath.bcstr(bcmath.bcmul(deviation, '100', 4), 4);
                            reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
                                '% from last finalized ' + lastPrice + ' (no local submission, threshold ' + (devThreshold * 500) + '%)',
                                { reason: 'historical-deviation', proposed: String(p.price), lastFinalized: String(lastPrice), deviation: bcmath.bcstr(deviation, 18) });
                            return;
                        }
                    }
                }
            }
        }

        // Create or update pending round. The validator-set snapshot is locked
        // at the round's block boundary (same snapshot the leader used in
        // finalizeRound) so PREPARE/COMMIT checks use the same N on every hub.
        if (!this.pendingRounds.has(round)) {
            let blockHeight = btcBlockHeight || round;
            // Same activation gate + weight snapshot the leader locked in finalizeRound,
            // so this follower tallies the round identically (weighted on stake or legacy
            // on count), keyed on the round's BTC block boundary + the hub's network.
            let wt = swq.isStakeWeightedQuorumActive(blockHeight, this.hub.network);
            let snap = this.hub.capabilitySnapshot
                ? (wt
                    ? await this.hub.capabilitySnapshot.getWeightSnapshot('price', blockHeight)
                    : await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight))
                : null;
            // Mirror the finalizeRound() fallback: if weighted but no validators in the
            // snapshot, degrade to count mode so the round can finalize normally.
            if (wt && (!snap || !Array.isArray(snap.validators) || snap.validators.length === 0)) {
                wt   = false;
                snap = this.hub.capabilitySnapshot
                    ? await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight)
                    : null;
            }
            let quorum = snap
                ? this.hub.capabilitySnapshot.getQuorum(snap)
                : this._getQuorum();
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
                timer:          setTimeout(() => {
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

        // Verify and store the proposer's signature on the canonical PRICE v0 payload
        if (sig_pubkey && sig) {
            this._verifyAndStoreSig(pending, sig_pubkey, sig);
        }

        // Sign the canonical PRICE v0 payload locally with this validator's identity
        let mySig = this._signPriceV0(round, pending.btcBlockTime, prices);
        if (mySig && !pending.signatures.has(mySig.pubkey)) {
            pending.signatures.set(mySig.pubkey, mySig.sig);
        }

        // Send ORACLE_PREPARE (includes this validator's signature on the canonical PRICE v0 payload)
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
        if (!round || !digest) return;

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
        if (!round || !digest) return;

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
            let mySig = this._signPriceV0(round, pending.btcBlockTime, pending.prices);
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

            let validatorCount = pending.prepares.size;
            let proof = JSON.stringify([...pending.commits]);

            this._storeSnapshot(round, pending.prices, validatorCount, proof, pending.btcBlockHeight, pending.btcBlockTime)
                .then(() => {
                    this.finalized.add(round);
                    this.pendingRounds.delete(round);
                    this._clearRoundTracking(round);
                    console.log('Oracle: Round ' + round + ' finalized (' +
                        pending.prepares.size + ' prepares, ' +
                        pending.commits.size + ' commits)');

                    // Convert collected signatures to the [{pubkey, sig}, ...] array format used by OraclePublisher
                    let sigsArray = [];
                    for (let [pubkey, sig] of pending.signatures) {
                        sigsArray.push({ pubkey: pubkey, sig: sig });
                    }

                    // Emit finalization event for RewardTracker, SlashDetector, and OraclePublisher
                    this.emit('round:finalized', {
                        round:          round,
                        btcBlockHeight: pending.btcBlockHeight,
                        btcBlockTime:   pending.btcBlockTime,
                        prices:         pending.prices,
                        participants:   [...pending.prepares],
                        signatures:     sigsArray,
                        submissions:    this.oracleRound.getSubmissions(round)
                    });
                })
                .catch(err => {
                    console.error('Oracle: Error storing snapshot for round ' + round + ':', err.message);
                    this.pendingRounds.delete(round);
                    this._clearRoundTracking(round);
                });
        }
    }

    // --- Aggregation ---

    // Aggregate all coin pairs from submissions
    _aggregateAll(submissions) {
        // Collect all unique coin pairs
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
                        if (isFinite(val) && val > 0 && val < PRICE_MAX) {
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

        if (values.length === 0) return null;

        // Sort ascending (ordering only; float compare is fine here)
        values.sort((a, b) => a.f - b.f);

        // Trim top and bottom 15%. Use Math.ceil so at least one value is trimmed
        // once N >= 4 (Math.floor yields 0 for all N <= 6, making the trim a no-op
        // in small federations and leaving a single in-bounds outlier able to shift
        // a 2-source median by ~50%).
        let trimCount = Math.ceil(values.length * TRIM_PERCENT);
        if (trimCount > 0 && values.length > 2 * trimCount) {
            values = values.slice(trimCount, values.length - trimCount);
        }

        // If trimming removed everything, use original sorted array
        if (values.length === 0) return null;

        // Compute median in bignumber (no float midpoint average / .toFixed artifact)
        let mid = Math.floor(values.length / 2);
        if (values.length % 2 === 0) {
            return bcmath.bcstr(bcmath.bcdiv(bcmath.bcadd(values[mid - 1].s, values[mid].s, 8), '2', 8), 8);
        }
        return bcmath.bcstr(values[mid].s, 8);
    }

    // --- Storage ---

    // Store a finalized price snapshot
    // btcBlockHeight is the BTC chain tip when this round was triggered (used as reference_block)
    // btcBlockTime is the BTC block_time of that block (used as block_timestamp)
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

    // Store a skipped round
    // reason is a short human-readable string describing why the round was
    // skipped (e.g. 'no submissions', 'below minimum submissions threshold',
    // 'aggregation yielded no prices'); it's surfaced in the skip log so
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
                ON DUPLICATE KEY UPDATE reference_block = VALUES(reference_block),
                 block_timestamp = VALUES(block_timestamp), status = 'skipped'`;
            await this.db.doQuery(query, params);
        }
        this.finalized.add(round);
        this._clearRoundTracking(round);
        console.log('Oracle: Round ' + round + ' skipped (' + (reason || 'no submissions') + ')');
    }

    // --- Signature collection (PRICE v0 anchor) ---

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/ed25519.js buildPriceV0Payload exactly so signatures
    // produced here verify against the same canonical bytes when indexers parse on-chain PRICE v0 actions.
    _buildPriceV0Payload(round, btcBlockTime, prices) {
        let pairs = prices.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
        let sortedPairs = [...pairs].sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        let raw = JSON.stringify({
            round:     parseInt(round),
            timestamp: parseInt(btcBlockTime),
            pairs:     sortedPairs
        });
        // EQUIV header (WI-2 bump 2): gated on the round (a BTC block height) + the hub's
        // network, byte-matching ed25519.buildPriceV0Payload. XORACLE has no view -> VIEW=0.
        if (eq.isEquivHeaderActive(round, this.hub && this.hub.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parseInt(round), 0, raw);
        return raw;
    }

    // Sign the canonical PRICE v0 payload with the local validator identity
    // Returns { pubkey, sig } or null if no identity is configured
    _signPriceV0(round, btcBlockTime, prices) {
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (!identity) return null;
        try {
            let payload = this._buildPriceV0Payload(round, btcBlockTime, prices);
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
            let payload = this._buildPriceV0Payload(pending.round, pending.btcBlockTime, pending.prices);
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

    // --- Utilities ---

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

    _getLeader(round) {
        if (this.validatorSet.length === 0) return null;
        return this.validatorSet[round % this.validatorSet.length];
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

    _digest(round, prices) {
        let payload = JSON.stringify({ round: round, prices: prices });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = OracleConsensus;
