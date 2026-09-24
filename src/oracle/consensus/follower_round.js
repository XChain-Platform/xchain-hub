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
 * XChain Hub - Oracle Consensus: co-signing a round
 *
 * The last leg of an accepted PROPOSE: bind the leader admission map under the follower
 * bound, open the pending round against the locked snapshot, and broadcast this hub
 * PREPARE with its own signature over the same canonical bytes.
 *
 ********************************************************************/

'use strict';

const { ORACLE_PREPARE } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Tells bindAndCoSign to refuse the PROPOSE; distinct from a legitimate false era.
const DROP = Symbol('refuse this PROPOSE');

// THE FOLLOWER BOUND on the leader's admission map (section 5.3, C3), the price
// rail's twin of CrossChainDexConsensus.admissionBoundHolds. In the admission era
// the PROPOSE must carry a map, every chain in it must sit inside this hub's own
// window above its own tip, and the map must name every chain this federation
// serves (the price read set is every chain). Refused rather than co-signed on any
// miss, and never re-resolved from this hub's tips: the bytes co-signed below are
// the LEADER's map or nothing. Below the activation a map is refused the other way.
function admissionEraOf(round, envelope, blockHeight, admitBlocks) {
    let net = this.hub && this.hub.network;
    let era = this.admission.isAdmissionEra(net, blockHeight);
    let has = admitBlocks !== null && admitBlocks !== undefined;
    if (era !== has) {
        logger.warn('Oracle: refusing PROPOSE for round ' + round + ' from ' + envelope.sender + ': ' +
            (era ? 'admission-era round carries no admission map' : 'legacy-era round carries an admission map'));
        return DROP;
    }
    return era;
}

// Create or update pending round. The validator-set snapshot was locked
// at the round's block boundary BEFORE the proposer validation above
// (same snapshot the leader used in finalizeRound) so PREPARE/COMMIT
// checks use the same N on every hub. blockHeight/wt/snap/quorumForRound
// are only populated when no pending round existed at the top of this
// handler; a concurrent handler creating one during the await is caught
// by the has() re-check here.
function openFollowerRound(proposal, locked, proposedAdmit) {
    let { round, prices, digest, btcBlockTime } = proposal;
    let { blockHeight, wt, snap, quorumForRound, memberPubkeys } = locked;
    if (!this.pendingRounds.has(round) && quorumForRound !== null) {
        let quorum = quorumForRound;
        let pending = {
            round:          round,
            prices:         prices,
            digest:         digest,
            btcBlockHeight: blockHeight,
            btcBlockTime:   btcBlockTime   || Math.floor(Date.now() / 1000),
            admitBlocks:    proposedAdmit,
            prepares:       new Set(),
            commits:        new Set(),
            signatures:     new Map(),  // pubkey (hex) -> sig (hex)
            finalized:      false,
            snapshot:       snap || null,
            quorum:         quorum,
            weighted:       !!wt,
            validators:     this.normalizeValidators(snap, wt),
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
                    logger.warn('Oracle: PROPOSE round ' + round + ' timed out before commit quorum ('
                        + (p.prepares ? p.prepares.size : 0) + ' prepares, '
                        + (p.commits ? p.commits.size : 0) + ' commits, quorum ' + p.quorum + ')');
                }
                this.pendingRounds.delete(round);
            }, this.finalizationTimeout)
        };
        this.pendingRounds.set(round, pending);
        // A PROPOSE is the other way a round becomes OPEN on this hub: a seat
        // whose own finalizeRound never ran for this round (its round scheduler
        // missed the boundary, or it had no submissions of its own) still
        // observed the round through gossip and must hold a record of it.
        // Idempotent with the finalizeRound arming.
        this.armRoundWatchdog(round, pending.btcBlockHeight, pending.btcBlockTime);
        // Replay any PREPARE/COMMIT that arrived while this handler was
        // awaiting the snapshot fetch above (finding F7).
        this.drainEarlyMessages(round);
    }
}

// Count the proposer's PREPARE and this hub's own, verify any signature the PROPOSE
// carried, sign the round here and broadcast this hub's PREPARE.
function prepareOnPropose(envelope, proposal, proposedAdmit) {
    let { round, prices, digest, sig_pubkey, sig } = proposal;
    let pending = this.pendingRounds.get(round);
    // Guard against a second PROPOSE for the same round with a different
    // digest (mirrors the Consensus.handlePrePrepare fix in b8f5143).
    // Adding the sender to pending.prepares and broadcasting ORACLE_PREPARE
    // with the incoming digest would inflate the A-round prepare tally and
    // emit an orphaned PREPARE for digest B, the same protocol-noise pattern
    // the config engine fixed. COMMIT quorum still guards finalization, but
    // we should not mutate prepares or broadcast at all for a conflicting digest.
    if (pending.digest !== digest) {
        logger.warn('Oracle: PROPOSE digest conflict for round ' + round +
            ' from ' + envelope.sender + ': expected ' + pending.digest + ', got ' + digest);
        return;
    }
    // A second PROPOSE for a round already pending must carry the SAME map, or two
    // leaders are collecting signatures over two byte strings under one digest.
    if (this.spellAdmit(pending.admitBlocks) !== this.spellAdmit(proposedAdmit)) {
        logger.warn('Oracle: PROPOSE admission-map conflict for round ' + round + ' from ' + envelope.sender);
        return;
    }
    this.addVote(pending.prepares, envelope);
    let selfPkOnPropose = this.selfPubkey();
    if (selfPkOnPropose) pending.prepares.add(selfPkOnPropose);

    if (sig_pubkey && sig) {
        this.verifyAndStoreSig(pending, sig_pubkey, sig);
    }

    let mySig = this.signPriceV0(round, pending.btcBlockTime, prices, pending.btcBlockHeight, pending.admitBlocks);
    if (mySig && !pending.signatures.has(mySig.pubkey)) {
        pending.signatures.set(mySig.pubkey, mySig.sig);
    }

    this.peerManager.broadcast(ORACLE_PREPARE, {
        round:      round,
        digest:     digest,
        sig_pubkey: mySig ? mySig.pubkey : null,
        sig:        mySig ? mySig.sig    : null
    });

    this.checkPrepareQuorum(round);
}

// Bind the leader's admission map (or refuse the round), open the pending round and co-sign it.
async function bindAndCoSign(envelope, proposal, locked) {
    let { round, digest, admitBlocks } = proposal;
    let { blockHeight } = locked;
    let proposedAdmit = null;
    {
        let era = admissionEraOf.call(this, round, envelope, blockHeight, admitBlocks);
        if (era === DROP) return;
        if (era) {
            let verdict = await this.checkProposedAdmit(admitBlocks);
            if (!verdict.ok) {
                logger.warn('Oracle: refusing PROPOSE for round ' + round + ' from ' + envelope.sender +
                    ': admission map ' + verdict.reason);
                return;
            }
            proposedAdmit = verdict.map;
        }
    }

    // An exact repeat of a round already open (same digest, same admission map):
    // keep the first round's votes and timer, and skip re-opening and re-broadcasting.
    let pending = this.pendingRounds.get(round);
    if (pending && pending.digest === digest &&
        this.spellAdmit(pending.admitBlocks) === this.spellAdmit(proposedAdmit)) {
        logger.info('Oracle: ignoring duplicate PROPOSE for round ' + round + ' from ' + envelope.sender);
        return;
    }

    openFollowerRound.call(this, proposal, locked, proposedAdmit);
    prepareOnPropose.call(this, envelope, proposal, proposedAdmit);
}

module.exports = { bindAndCoSign };
