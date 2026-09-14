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
 * XChain Hub - Oracle Consensus: proposing a round
 *
 * The proposer side: pin the round admission map, sign the canonical payload, open the
 * pending round with its locked snapshot and quorum, and broadcast the PROPOSE every
 * follower co-signs.
 *
 ********************************************************************/

'use strict';

const { ORACLE_PROPOSE } = require('./constants.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Open the leader's pending round: the locked snapshot and quorum, this hub's own seeded
// vote and signature, and any early PREPARE/COMMIT replayed into it.
function openLeaderRound(ctx, mySig) {
    let { round, aggregated, digest, btcBlockHeight, btcBlockTime, admitBlocks, snapshot, quorum, weighted, memberPubkeys } = ctx;
    let pending = {
        round:          round,
        prices:         aggregated,
        digest:         digest,
        btcBlockHeight: btcBlockHeight,
        btcBlockTime:   btcBlockTime,
        admitBlocks:    admitBlocks,
        prepares:       new Set(),
        commits:        new Set(),
        signatures:     new Map(),  // pubkey (hex) -> sig (hex)
        finalized:      false,
        timer:          null,
        // Snapshot of the validator set at this round's block boundary.
        // Locked here so checkPrepareQuorum/checkCommitQuorum compute
        // against the same N for the round's full lifecycle, even when
        // on-chain stake state changes mid-round (capability-staking spec §6).
        snapshot:       snapshot || null,
        quorum:         (typeof quorum === 'number' && quorum >= 0) ? quorum : this.getQuorum(),
        // STAKE_WEIGHTED_QUORUM round? Carry the source-keyed validator weights so
        // checkPrepareQuorum/checkCommitQuorum can tally signer stake (the count
        // quorum above is ignored when weighted).
        weighted:       !!weighted,
        validators:     this.normalizeValidators(snapshot, weighted),
        // Snapshot member pubkeys for the count-mode vote tally (Oracle M1).
        // Null (no usable snapshot) keeps the legacy raw-sender count.
        memberPubkeys:  memberPubkeys || null
    };

    // Vote sets hold PROVEN SIGNING KEYS, not sender addrs: quorum is a count of
    // distinct staked signers, and an addr is a self-asserted wire field that one
    // key could vary to forge a quorum. Seed our own key the same way.
    let selfPk = this.selfPubkey();
    if (selfPk) pending.prepares.add(selfPk);
    if (mySig) pending.signatures.set(mySig.pubkey, mySig.sig);
    this.pendingRounds.set(round, pending);
    // Replay any PREPARE/COMMIT that beat this proposal (finding F7).
    this.drainEarlyMessages(round);
    return pending;
}

// The leader seat's finalization timeout: an evicted round is counted and logged, never
// stored, so a late quorum can still finalize it.
function armProposalTimeout(round, pending) {
    pending.timer = setTimeout(() => {
        if (!pending.finalized) {
            // Count leader-seat quorum loss symmetrically with the follower-side
            // PROPOSE-round timeout in _handlePropose (review 1469): before this,
            // the eviction left no countable trace, so a leader repeatedly stuck
            // below commit quorum was invisible to the dashboard's oracle stall
            // ladder until lastSuccessAge aged past its warn band. Deliberately
            // NOT a storeSkippedRound: that marks the round finalized locally
            // and would refuse a late-arriving quorum, unlike the follower path.
            this._roundTimeouts = (this._roundTimeouts || 0) + 1;
            logger.warn('Oracle: Finalization timeout for round ' + round + ' ('
                + pending.prepares.size + ' prepares, '
                + pending.commits.size + ' commits, quorum ' + pending.quorum + ')');
            this.pendingRounds.delete(round);
        }
    }, this.finalizationTimeout);
}

// Broadcast the PROPOSE the followers co-sign, then count this hub's own PREPARE.
function broadcastProposal(ctx, submissions, isFallback, mySig) {
    let { round, aggregated, digest, btcBlockHeight, btcBlockTime, admitBlocks } = ctx;
    // Broadcast ORACLE_PROPOSE (includes proposer's signature on the canonical PRICE v0 payload).
    // submissionKeys carries the proposer's own view of the submission set (sorted) purely as a
    // diagnostic/wire-compat hint. Receivers do NOT trust it for fallback-proposer legitimacy;
    // that check is made solely against each receiver's locally-observed submissions (see
    // _handlePropose), since a peer-supplied set is attacker-controllable.
    // The leader's map travels in the PROPOSE, because every follower must co-sign
    // the SAME map: a follower pinning its own tips would sign bytes no quorum shares.
    // Absent below the activation, so an un-upgraded peer sees the frame it always saw.
    let proposeBody = {
        round:          round,
        prices:         aggregated,
        digest:         digest,
        btcBlockHeight: btcBlockHeight,
        btcBlockTime:   btcBlockTime,
        submissionKeys: [...submissions.keys()].sort(),
        sig_pubkey:     mySig ? mySig.pubkey : null,
        sig:            mySig ? mySig.sig    : null
    };
    if (admitBlocks !== null) proposeBody.admitBlocks = admitBlocks;
    this.peerManager.broadcast(ORACLE_PROPOSE, proposeBody);

    let tag = isFallback ? '[FALLBACK] ' : '';
    logger.info('Oracle: ' + tag + 'Proposed round ' + round + ' with ' + aggregated.length +
        ' prices (' + submissions.size + ' submissions)');

    this.checkPrepareQuorum(round);
}

module.exports = {

    // Propose a round (used both by the real leader and the fallback proposer).
    // snapshot + quorum are captured in finalizeRound() at the block boundary
    // and threaded through so the entire round uses the same locked validator
    // set. Without the snapshot, falls back to live getQuorum() per legacy.
    //
    // Async only for the admission era: the leader pins the round's admission map from
    // this hub's own tips before it signs, and that read is the ONE await in here. Below
    // the activation nothing awaits, so the body runs to completion synchronously exactly
    // as before and a caller that does not await it observes no change. A hub with no
    // fresh tip proposes nothing rather than a guessed height (section 5.3); the fallback
    // seat then takes the round on the same rule.
    async proposeRound(round, submissions, isFallback, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys) {
        let aggregated = this._aggregateAll(submissions);
        if (aggregated.length === 0) {
            this.storeSkippedRound(round, btcBlockHeight, btcBlockTime, 'aggregation yielded no prices').catch(err =>
                logger.error(nodeUtil.format('Oracle: Error storing skipped round ' + round + ':', err.message)));
            return;
        }

        let admitBlocks = null;
        if (this.admission.isAdmissionEra(this.hub && this.hub.network, btcBlockHeight)) {
            admitBlocks = await this.resolveRoundAdmitBlocks();
            if (!admitBlocks) {
                logger.error('Oracle: refusing to propose round ' + round + ' at anchor ' + btcBlockHeight +
                    '; no fresh admission tip to stamp an admission height from');
                return;
            }
            if (this.finalized.has(round) || this.pendingRounds.has(round)) return;   // decided while the tip was read
        }

        let digest = this._digest(round, aggregated);

        // Sign the canonical PRICE v0 payload locally (this validator's contribution
        // to the on-chain anchor). Embedded in the published PRICE v0 transaction along
        // with sigs from other validators.
        let mySig = this._signPriceV0(round, btcBlockTime, aggregated, btcBlockHeight, admitBlocks);

        let ctx = { round, aggregated, digest, btcBlockHeight, btcBlockTime, admitBlocks, snapshot, quorum, weighted, memberPubkeys };
        let pending = openLeaderRound.call(this, ctx, mySig);
        armProposalTimeout.call(this, round, pending);
        broadcastProposal.call(this, ctx, submissions, isFallback, mySig);
    }
};
