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
 * XChain Hub - Oracle Consensus: judging a PROPOSE
 *
 * The follower side of admission: bound the leader-supplied height against this hub own
 * tip, lock the same snapshot the leader locked, and accept the message only from the
 * round leader or a legitimate fallback proposer.
 *
 ********************************************************************/

'use strict';

const swq               = require('../../stake_weighted_quorum.js');
const ocr               = require('../../oracle_clamp_reference_activation.js');
const { provenPubkey }  = require('../../lib/chain_signer_admission.js');
const { noteDrop }      = require('../../consensus/diagnostics');
const { coSignGateRejects } = require('./cosign_gate.js');
const { bindAndCoSign } = require('./follower_round.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Tells _handlePropose's steps to drop the message; distinct from a legitimate null or 0.
const DROP = Symbol('drop this PROPOSE');
// Tells lockProposeSnapshot to re-resolve the round in count mode rather than drop it.
const DOWNGRADE_TO_COUNT = Symbol('downgrade to a count quorum');

// The cheap refusals, taken before any snapshot or indexer work is done for this sender.
function proposalAdmissible(envelope, proposal) {
    let { round, prices, digest } = proposal;
    // Round 0 is a real, valid round (the first ORACLE_ROUND_INTERVAL after
    // ORACLE_EPOCH_START); guard on integer/non-negative, not falsiness, so a
    // genesis round-0 PROPOSE is not silently dropped as malformed.
    if (!Number.isInteger(round) || round < 0 || !prices || !digest) return false;
    if (this.finalized.has(round)) return false;

    // Discard proposals from senders that are not registered validators
    // before doing any snapshot/indexer work for them.
    if (!this._isKnownSender(envelope)) {
        noteDrop({ reason: 'unknown_sender', phase: 'propose', sender: envelope.sender, envelope });
        return false;
    }

    // Verify digest
    let computedDigest = this._digest(round, prices);
    if (computedDigest !== digest) {
        logger.warn('Oracle: PROPOSE digest mismatch from ' + envelope.sender + ' for round ' + round);
        return false;
    }
    return true;
}

// Mirror the finalizeRound() fallback: if weighted but no validators in the
// snapshot, degrade to count mode so the round can finalize normally.
function weightedProposeVerdict(round, wt, snap) {
    if (wt && (!snap || !Array.isArray(snap.validators) || snap.validators.length === 0)) {
        // Federation-split guard (fail closed), mirroring the leader-side guard
        // in finalizeRound (#1222). swq.isStakeWeightedQuorumActive is a pure
        // function of (block, network) every honest hub computes identically, so
        // degrading THIS follower to a count quorum on its own weight-snapshot
        // reachability (e.g. a per-RPC getstakeweightsbycapability failure) forks
        // the finalization THRESHOLD: peers tally summed stake while this hub
        // tallies a count over the same N. Skip the round rather than diverge.
        // A single-node / regtest hub (getQuorum()===0) has no peer to split
        // from, so it keeps the graceful count fallback below.
        if (this.getQuorum() > 0) {
            logger.warn('Oracle: dropping PROPOSE for round ' + round + ': weighted mode ' +
                'active but weight snapshot unavailable while federated; refusing to open a ' +
                'count-mode pending round this hub\'s peers are not using.');
            return DROP;
        }
        return DOWNGRADE_TO_COUNT;
    }
    return null;
}

// Follower twin of the leader-side deterministic-snapshot gate in
// finalizeRound, in BOTH quorum modes and in the same position relative to
// the empty-snapshot check, so a leader and a follower refuse exactly the
// same rounds. Without it this follower opens a pending round sized from
// its own live set (quorumForRound falls through to getQuorum below) with
// memberPubkeys null, so its vote tally is unfiltered and its leader
// election is live-set rotation: three ways to disagree with every peer at
// the same height on nothing but its own indexer reachability.
function proposeSnapshotQuorum(round, blockHeight, snap) {
    if (!this.hasDeterministicSnapshot(snap) && this.getQuorum() > 0) {
        logger.warn('Oracle: dropping PROPOSE for round ' + round + ': no deterministic price ' +
            'capability snapshot at block ' + blockHeight + ' while federated; refusing to open a ' +
            'pending round sized from this hub\'s live validator set.');
        return DROP;
    }
    let quorumForRound = snap
        ? this.hub.capabilitySnapshot.getQuorum(snap)
        : this.getQuorum();
    // Refuse to open a pending round on an empty federation snapshot: quorum
    // would be 0 and quorumMet (count mode) returns `size >= 0` = true, so a
    // single PREPARE/COMMIT would finalize. A legitimate leader skips such a
    // round (finalizeRound), so a PROPOSE for one is spurious/Byzantine; drop
    // it. Genuine single-node hubs receive no PROPOSEs, and a healthy
    // federation snapshot is non-empty, so this only bites the bad case.
    if (this.isEmptyFederationSnapshot(snap)) {
        logger.warn('Oracle: dropping PROPOSE for round ' + round + ': empty price-qualifying ' +
            'snapshot at block ' + blockHeight + ' on a federated hub (a legitimate leader skips ' +
            'such a round; not accepting a single-signature finalization).');
        return DROP;
    }
    return quorumForRound;
}

// Whether this PROPOSE comes from a legitimate fallback proposer, judged only against the
// submissions this hub has itself seen.
function electedFallback(round, envelope, submissions, leader) {
    let isFallback = false;
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
        let leaderSubAddr   = this.leaderSubmissionAddr(submissions, leader);
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
    return isFallback;
}

// Resolve and lock the round's snapshot, quorum and member set, then judge the proposer.
async function lockProposeSnapshot(envelope, proposal, blockHeight) {
    let { round } = proposal;
    // Resolve the round's locked snapshot BEFORE validating the proposer
    // (Oracle M1): the fallback-proposer election below must run over the
    // same snapshot-member-filtered submission set every hub's finalizeRound
    // uses, or a non-member submitter could skew which sender this follower
    // accepts as the legitimate fallback. A pending round reuses its locked
    // member set; otherwise the snapshot is resolved here, ahead of the
    // pending creation that consumes it. The round's anchor height is
    // resolved and bounded above, before the clamp-reference read.
    let wt = false, snap = null, quorumForRound = null;
    let memberPubkeys = null;
    {
        let existing = this.pendingRounds.get(round);
        if (existing) {
            memberPubkeys = existing.memberPubkeys || null;
        } else {
            // Same activation gate + weight snapshot the leader locked in finalizeRound,
            // so this follower tallies the round identically (weighted on stake or legacy
            // on count), keyed on the round's BTC block boundary + the hub's network.
            wt = swq.isStakeWeightedQuorumActive(blockHeight, this.hub.network);
            snap = this.hub.capabilitySnapshot
                ? (wt
                    ? await this.hub.capabilitySnapshot.getWeightSnapshot('price', blockHeight)
                    : await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight))
                : null;
            let verdict = weightedProposeVerdict.call(this, round, wt, snap);
            if (verdict === DROP) return;
            if (verdict === DOWNGRADE_TO_COUNT) {
                wt   = false;
                snap = this.hub.capabilitySnapshot
                    ? await this.hub.capabilitySnapshot.getSnapshot('price', blockHeight)
                    : null;
            }
            let quorum = proposeSnapshotQuorum.call(this, round, blockHeight, snap);
            if (quorum === DROP) return;
            quorumForRound = quorum;
            memberPubkeys = this.memberPubkeySet(snap);
        }
    }
    return judgeProposer.call(this, envelope, proposal, { blockHeight, wt, snap, quorumForRound, memberPubkeys });
}

// Accept the PROPOSE only from the round's leader or a legitimate fallback, and only once
// its prices clear the co-sign gate.
function judgeProposer(envelope, proposal, locked) {
    let { round, prices } = proposal;
    let { memberPubkeys } = locked;
    // Accept PROPOSE if sender is the deterministic leader OR an authorized
    // fallback (lowest-addr submitter when the leader has no submission).
    // The fallback path salvages rounds where the leader's price fetch
    // failed but other hubs have prices. The local submission view is
    // filtered to snapshot members (Oracle M1) so the election and the
    // deviation reference only see qualified validators.
    let leader       = this._getLeader(round, memberPubkeys);
    let submissions  = this.filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
    // Identify the proposer by the key that PROVABLY signed this envelope
    // (PeerManager verified it, and binds a registered sender to its
    // registered key), not by a registry lookup on the sender addr. The
    // registry is only a legacy fallback for unsigned envelopes: a hub with
    // an empty registry (freshly staked, or a non-validator observer) would
    // otherwise admit the leader's PROPOSE via the chain-effective set and
    // then reject it as "non-leader" because it could not name its key.
    let proposerPk   = provenPubkey(envelope) || this.resolveSenderPubkey(envelope.sender);
    let isRealLeader = this.isLeaderIdentity(leader, envelope.sender, proposerPk);
    let isFallback   = false;
    if (!isRealLeader) isFallback = electedFallback.call(this, round, envelope, submissions, leader);

    if (!isRealLeader && !isFallback) {
        logger.warn('Oracle: PROPOSE from non-leader ' + envelope.sender + ' for round ' + round);
        return;
    }

    if (isFallback) {
        logger.info('Oracle: Accepting [FALLBACK] PROPOSE from ' + envelope.sender +
            ' for round ' + round + ' (leader ' + (leader ? leader.addr : 'unknown') + ' has no submission)');
    }
    if (coSignGateRejects.call(this, round, envelope, prices, submissions)) return;

    return bindAndCoSign.call(this, envelope, proposal, locked);
}

module.exports = {

    // Resolve the round's snapshot anchor from the wire-supplied btcBlockHeight and
    // bound it against this hub's own BTC tip. Returns the height to pin the round at,
    // or null when the PROPOSE must be dropped (the caller returns on null; it has
    // already logged the reason). Separate from _handlePropose so the bound can run
    // ahead of every other reader of the wire height, the clamp-reference activation
    // gate included.
    async boundedProposeHeight(round, btcBlockHeight) {
        // Fix (#1225): do NOT substitute the round id for a missing BTC block
        // height on a federated hub. The leader locked the price snapshot at the
        // real round block in finalizeRound; pinning the follower's snapshot at
        // block_index = round (not a BTC boundary) locks a DIFFERENT (price, block)
        // set/quorum than the leader for the same round, or degrades to the null
        // path. Only reachable from a peer that omits the height (old peer mid
        // rolling deploy, or a malformed envelope) -- current honest senders always
        // populate it. Fail closed: drop the PROPOSE rather than pin to a fake block.
        // A single-node / regtest hub (getQuorum()===0) has no peer to split from,
        // so it keeps the legacy round-as-anchor fallback for bootstrap.
        let blockHeight = btcBlockHeight;
        if (!Number.isInteger(blockHeight) || blockHeight <= 0) {
            if (this.getQuorum() > 0) {
                logger.warn('Oracle: dropping PROPOSE for round ' + round + ': no BTC block ' +
                    'height in envelope on a federated hub; refusing to pin the price snapshot ' +
                    'at the round id (not a BTC block boundary), which would diverge from the ' +
                    'leader\'s snapshot for this round.');
                return null;
            }
            return round;
        }
        // Freshness bound (fail closed), the missing half of the guard above,
        // which closes only the ABSENT-height case. A present but ancient
        // height is refused by nothing downstream: CapabilitySnapshot's echo
        // check rejects a MISMATCHED echo, and the indexer fail-closes only
        // above its own tip, so an old-but-indexed block resolves a perfectly
        // valid snapshot. That hands the proposer four choices at once: the
        // quorum denominator (getQuorum(snap)), the member set that
        // _getLeader elects from (so it can pick a height where it is the
        // round's leader and the legitimacy check then validates it against
        // its own choice), the weighted-vs-count mode the snapshot guards call
        // a federation-split hazard, and the side of the clamp-reference
        // activation gate this hub takes for the round. Bound the wire height
        // against our own resolved BTC tip before any of the four read it, and
        // decline when we cannot resolve a tip of our own. Same shape and
        // tolerance as StateCheckpointEngine's co-sign guard. Federated hubs
        // only, like every other fail-closed guard on this path.
        if (this.getQuorum() > 0) {
            let myTip = this.hub && this.hub.resolveBtcLatestBlock
                ? await this.hub.resolveBtcLatestBlock()
                : null;
            if (!Number.isFinite(Number(myTip))) {
                logger.warn('Oracle: dropping PROPOSE for round ' + round + ': cannot resolve ' +
                    'our own BTC tip to bound the leader-supplied snapshot height ' +
                    '(federated hub).');
                return null;
            }
            if (Math.abs(Number(myTip) - Number(blockHeight)) > this.snapshotToleranceBlocks) {
                logger.warn('Oracle: dropping PROPOSE for round ' + round + ': block height ' +
                    blockHeight + ' deviates from our own BTC tip ' + myTip + ' by more than ' +
                    this.snapshotToleranceBlocks + ' blocks (federated hub); a stale height would ' +
                    'let the proposer select the price snapshot, the round leader, the ' +
                    'quorum mode and the clamp-reference gate.');
                return null;
            }
        }
        return blockHeight;
    },

    async _handlePropose(envelope) {
        let { round, prices, digest, btcBlockHeight, btcBlockTime, sig_pubkey, sig, admitBlocks } = envelope.data;
        // One snapshot of the wire fields, taken once, so every step below judges the
        // same values however long the awaits below take.
        let proposal = { round, prices, digest, btcBlockHeight, btcBlockTime, sig_pubkey, sig, admitBlocks };
        if (!proposalAdmissible.call(this, envelope, proposal)) return;

        // Bound the wire-supplied height against our own BTC tip BEFORE anything else
        // in this handler reads it (operator ruling 2026-09-11). Every later reader of
        // btcBlockHeight is a choice the proposer would otherwise get to make for one
        // round: the clamp-reference activation gate immediately below, and the
        // snapshot / leader / quorum-mode resolution further down. One drop decision,
        // taken once, ahead of all of them. A height the bound refuses leaves this
        // handler having touched nothing.
        let blockHeight = await this.boundedProposeHeight(round, btcBlockHeight);
        if (blockHeight === null) return;

        // Align the clamp reference to THIS round before the co-sign gate below reads
        // it. Placed after the digest, known-sender and freshness checks so neither an
        // unsigned or forged PROPOSE nor one carrying a height this hub is about to
        // refuse can make a hub query its database or flip which side of the gate it
        // takes for the round.
        //
        // GATED on oracle_clamp_reference_activation.js, keyed on the envelope's own
        // btcBlockHeight: the same field bounded above and the same one that anchors
        // the weighted-quorum gate below, so the follower and the leader evaluate one
        // round against one height.
        if (ocr.isClampReferenceAlignActive(btcBlockHeight, this.hub ? this.hub.network : undefined)) {
            await this.refreshLastFinalizedForRound(round);
        }
        return lockProposeSnapshot.call(this, envelope, proposal, blockHeight);
    }
};
