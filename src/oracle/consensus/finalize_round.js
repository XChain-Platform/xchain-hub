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
 * XChain Hub - Oracle Consensus: finalizing a round
 *
 * The leader-side entry point once the submission window closes: the submission floors,
 * the snapshot and quorum guards that every hub applies identically, the single-node
 * bypass, and the seat this hub then takes.
 *
 ********************************************************************/

'use strict';

const swq               = require('../../consensus/stake_weighted_quorum.js');
const ocr               = require('../../oracle_clamp_reference_activation.js');
const { takeSeat }      = require('./seats.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Tells finalizeOnSnapshot to re-resolve the round in count mode rather than skip it.
const DOWNGRADE_TO_COUNT = Symbol('downgrade to a count quorum');

// The skip reason for a round whose raw submission set cannot carry it, or null to go on.
function submissionCountSkip(round, submissions) {
    if (!submissions || submissions.size === 0) return 'no submissions';

    if (submissions.size < this.minSubmissions) {
        logger.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
            ' submission(s); minimum is ' + this.minSubmissions + ', skipping');
        return 'below minimum submissions threshold';
    }
    return null;
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
function noteSourceDiversity(round, submissions) {
    let capablePairs   = this.oracleRound && this.oracleRound.priceFetcher
        ? this.oracleRound.priceFetcher.multiSourceCapablePairs() : null;
    let minRoundSources = this.computeMinRoundSources(submissions, capablePairs);
    if (Number.isFinite(minRoundSources) && minRoundSources <= 1) {
        // Count it as well as logging it. The warn reaches one hub's stdout, which is
        // below every threshold the dashboard can act on, so a fleet-wide loss of the
        // second upstream was observable only to whoever was tailing that hub.
        // Counting only, never gating: the round's outcome is unchanged.
        this._singleSourceRounds++;
        this._lastSingleSourceRound = round;
        logger.warn('Oracle: Round ' + round + ' finalizing with single-source corroboration ' +
            'on a normally-multi-source pair (minimum source count across the ' + submissions.size +
            ' submissions, restricted to multi-source-capable pairs = ' + minRoundSources +
            '); the federation lost its second uncorrelated price source this round. PRICE v0 is ' +
            'still quorum-signed but its outlier-rejection resilience is gone.');
    }
}

// Fix (seq 4118): when weighted mode is active but the snapshot is absent or
// carries no validators, fall back to count mode for this round rather than
// entering PBFT with validators=[] and weighted=true. An empty weighted round
// can never finalize (swq.meetsStakeThreshold([], signers) is always false)
// and silently stalls for the full finalization timeout without storing a
// skipped-round record. Falling back to count mode degrades gracefully and
// keeps the round from stalling.
function weightedSnapshotVerdict(round, weighted, snapshot) {
    if (weighted && (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)) {
        // Federation-split guard (fail closed), mirroring Consensus.js's posture
        // before its identical weighted->count flip. swq.isStakeWeightedQuorumActive
        // is a pure function of (block, network) that every honest hub computes
        // identically, so downgrading to a count quorum on THIS hub's weight-snapshot
        // reachability forks the finalization THRESHOLD semantics: peers finalize on
        // summed stake while this hub finalizes/stalls on a count quorum over the same
        // N validators. In a real federation, skip the round rather than diverge.
        // A single-node / regtest hub (no peers, getQuorum()===0) has no peer to
        // split from, so it keeps the graceful count fallback below.
        if (this.getQuorum() > 0) {
            logger.warn('Oracle: Round ' + round + ' weighted mode active but weight snapshot ' +
                'unavailable while federated; skipping rather than downgrading to a count quorum ' +
                'this hub\'s peers are not using.');
            return 'weighted quorum active but weight snapshot unavailable';
        }
        logger.warn('Oracle: Round ' + round + ' weighted mode active but snapshot has no validators; falling back to count-based quorum');
        return DOWNGRADE_TO_COUNT;
    }
    return null;
}

// The two federation guards a round clears before anything aggregates: the skip reason,
// or null to go on.
function snapshotSkip(round, btcBlockHeight, snapshot) {
    // No deterministic snapshot on a FEDERATED hub: skip, in both quorum modes. A
    // null snapshot (indexer down / timeout / 401-403 / malformed) otherwise falls
    // through to getQuorum(), which reads this hub's own validatorSet or open-peer
    // count, so the finalization THRESHOLD becomes a function of local reachability:
    // at one height a hub holding a seven-member snapshot needs five votes while a
    // hub whose fetch failed needs three over its live four. The same null also
    // unfilters the member tally (countDistinctMembers) and reverts leader election
    // to live-set rotation. The under-quorum hub then publishes a PRICE v0 the
    // indexer rejects at its own gate (actions/price.js re-derives the count over
    // getValidatorsByCapability at the same height), so the degradation buys no
    // liveness and spends a fee to say so. Consensus.js takes exactly this posture
    // for config rounds and CrossChainEngine for cross-chain ones; this is that gate,
    // not a new one. Genuine single-node / regtest bootstrap (getQuorum() === 0)
    // keeps the self-finalize path, same federation test as the empty-set guard below.
    if (!this.hasDeterministicSnapshot(snapshot) && this.getQuorum() > 0) {
        logger.warn('Oracle: Round ' + round + ' has no deterministic price capability snapshot at block ' +
            btcBlockHeight + ' while this hub is federated; skipping rather than sizing quorum from this ' +
            'hub\'s live validator set, which peers do not share.');
        return 'no deterministic capability snapshot';
    }

    // A federation whose price-qualifying set is empty at this block must skip
    // the round, not self-finalize it: getQuorum(empty)=0 would otherwise take
    // the single-node bypass below and publish a one-signature PRICE v0 the
    // indexer's stake gate rejects (see _isEmptyFederationSnapshot). Genuine
    // single-node / regtest bootstrap (no federation) is unaffected and still
    // self-finalizes via the quorum===0 path.
    if (this.isEmptyFederationSnapshot(snapshot)) {
        logger.warn('Oracle: Round ' + round + ' qualified ZERO price validators at block ' +
            btcBlockHeight + ' while this hub is federated; skipping rather than self-finalizing a ' +
            'single-signature round the indexer stake gate would reject.');
        return 'empty qualifying validator snapshot';
    }
    return null;
}

// The same floor over the snapshot-member submissions the round will actually aggregate.
function memberSubmissionSkip(round, submissions) {
    if (!submissions || submissions.size === 0) return 'no submissions from snapshot members';
    if (submissions.size < this.minSubmissions) {
        logger.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
            ' snapshot-member submission(s); minimum is ' + this.minSubmissions + ', skipping');
        return 'below minimum member submissions threshold';
    }
    return null;
}

// The single-node bypass (quorum 0): aggregate, sign and store the round here, then announce it.
async function finalizeSoloRound(round, btcBlockHeight, btcBlockTime, submissions) {
    let aggregated = this.aggregateAll(submissions);
    // Mirror the federated proposeRound guard: aggregateAll can
    // legitimately return [] while submissions exist (every pair dropped
    // by the price clamp or the 2-source deviation gate). Without this,
    // storeSnapshot early-returns on empty prices (no finalized AND no
    // skipped row - a silent drop), yet markFinalized still resets the
    // stall gauges and round:finalized still emits an empty-pair PRICE v0
    // on-chain. Store a durable skipped-round row and stop instead.
    if (aggregated.length === 0) {
        await this.storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'aggregation yielded no prices');
        return;
    }
    // Sign locally and embed in the proof so the publisher can include the sig in PRICE v0
    // The round's admission map, pinned from this hub's own tips in the admission
    // era; no fresh tip means no round, never a guessed height (section 5.3).
    let soloAdmit = null;
    if (this.admission.isAdmissionEra(this.hub && this.hub.network, btcBlockHeight)) {
        soloAdmit = await this.resolveRoundAdmitBlocks();
        if (!soloAdmit) {
            logger.error('Oracle: refusing to finalize round ' + round + ' at anchor ' + btcBlockHeight +
                '; no fresh admission tip to stamp an admission height from');
            return;
        }
    }
    let mySig = this.signPriceV0(round, btcBlockTime, aggregated, btcBlockHeight, soloAdmit);
    let sigsArray = mySig ? [{ pubkey: mySig.pubkey, sig: mySig.sig }] : [];
    await this.storeSnapshot(round, aggregated, 1, JSON.stringify(sigsArray), btcBlockHeight, btcBlockTime, soloAdmit);
    // Mark the round finalized so the guard at the top of finalizeRound()
    // dedupes any subsequent call for this round (prevents a duplicate
    // snapshot store / PRICE v0 broadcast).
    this.markFinalized(round);
    // participants are SIGNING KEYS (see the federated emit below), so the
    // reward/slash path can pay a chain-attributed validator that the local
    // registry has no row for.
    let selfPk = this.selfPubkey();
    this.emit('round:finalized', {
        round:          round,
        btcBlockHeight: btcBlockHeight,
        btcBlockTime:   btcBlockTime,
        prices:         aggregated,
        admitBlocks:    soloAdmit,
        participants:   selfPk ? [selfPk] : [],
        signatures:     sigsArray,
        submissions:    submissions
    });
}

// Everything after the round's snapshot is locked: the snapshot guards, the member filter,
// the clamp-reference refresh, then the solo bypass or the seat split.
async function finalizeOnSnapshot(round, btcBlockHeight, btcBlockTime, submissions, weighted, snapshot) {
    let verdict = weightedSnapshotVerdict.call(this, round, weighted, snapshot);
    if (verdict === DOWNGRADE_TO_COUNT) {
        weighted = false;
        snapshot = this.hub.capabilitySnapshot
            ? await this.hub.capabilitySnapshot.getSnapshot('price', btcBlockHeight)
            : null;
    } else if (verdict) {
        await this.storeSkippedRound(round, btcBlockHeight, btcBlockTime, verdict);
        return;
    }

    let skip = snapshotSkip.call(this, round, btcBlockHeight, snapshot);
    if (skip) {
        await this.storeSkippedRound(round, btcBlockHeight, btcBlockTime, skip);
        return;
    }

    // Oracle M1: everything below (aggregation, minSubmissions floor, leader/
    // fallback election) must only see submissions from snapshot MEMBERS, one
    // per verified pubkey. Quorum is sized from the snapshot; letting any
    // merely-registered validator's submission through hands a no-stake key a
    // vote in the trimmed median every hub then co-signs. Null snapshot keeps
    // the unfiltered legacy map (graceful degradation, same as the quorum
    // fallback below).
    let memberPubkeys = this.memberPubkeySet(snapshot);
    submissions = this.filterSubmissionsToSnapshot(submissions, memberPubkeys);
    skip = memberSubmissionSkip.call(this, round, submissions);
    if (skip) {
        await this.storeSkippedRound(round, btcBlockHeight, btcBlockTime, skip);
        return;
    }

    // Before ANY path aggregates, bootstrap included: a hub clamping against an
    // older round emits a median its peers will not co-sign. After every skip
    // guard, so a skipped round costs no read.
    //
    // GATED on oracle_clamp_reference_activation.js, keyed on the round's own BTC
    // block height (the value that locked this round's snapshot above). Below it
    // the reference keeps its pre-alignment writers only, so a mixed-version fleet
    // never judges one round against two different references.
    if (ocr.isClampReferenceAlignActive(btcBlockHeight, this.hub ? this.hub.network : undefined)) {
        await this.refreshLastFinalizedForRound(round);
    }

    let quorum = snapshot
        ? this.hub.capabilitySnapshot.getQuorum(snapshot)
        : this.getQuorum();
    if (quorum === 0) return finalizeSoloRound.call(this, round, btcBlockHeight, btcBlockTime, submissions);

    // Past every early-skip branch: this hub has a usable submission set and a
    // quorum for the round, so from here the round is OPEN here whatever seat
    // this hub takes (leader, elected fallback, or a follower that only waits).
    // Arm the abandonment watchdog before the seat split so all three leave the
    // same durable record when the round dies. Disarmed by
    // clearRoundTracking on finalize and on an immediate skip.
    this.armRoundWatchdog(round, btcBlockHeight, btcBlockTime);
    takeSeat.call(this, round, submissions, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys);
}

module.exports = {

    // Minimum per-pair provider count observed across all of a round's submissions
    // (Infinity when no submission carries a per-pair `sources` count). A result of
    // <= 1 means at least one pair finalized this round with single-source (and thus
    // correlated, outlier-rejection-defeating) corroboration somewhere in the set.
    //
    // `capablePairs` (optional Set of coinPairs) restricts the scan to pairs that can
    // normally reach >=2 sources, so CoinGecko-only-by-design pairs (BTC/MXN, etc.,
    // which Kraken does not list) do not pin the minimum to 1 every healthy round.
    // Omitted -> no filtering (legacy behavior; relied on by unit tests).
    computeMinRoundSources(submissions, capablePairs) {
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
    },

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
        let skip = submissionCountSkip.call(this, round, submissions);
        if (skip) {
            await this.storeSkippedRound(round, btcBlockHeight, btcBlockTime, skip);
            return;
        }
        noteSourceDiversity.call(this, round, submissions);

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
        return finalizeOnSnapshot.call(this, round, btcBlockHeight, btcBlockTime, submissions, weighted, snapshot);
    }
};
