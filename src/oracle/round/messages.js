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
 * XChain Hub - Oracle Round Gossip Ingest
 *
 * The receiving half of the submission gossip: who may submit, one submission
 * per proven key per round, which prices survive the canonical filter, and the
 * audit row that follows. Synchronous throughout, as the peer manager's
 * message handler requires.
 *
 ********************************************************************/

const { isAdmissibleSigner, provenPubkey } = require('../../lib/chain_signer_admission.js');
const { canonicalPrice } = require('../canonical_price.js');
const { ORACLE_PRICE_SUBMIT } = require('./message_types.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Handle incoming gossip messages
    // A submission counts only if the chain-effective signer set or the local
    // registry attributes its PROVEN signing key. Shared definition (and the full
    // security argument) in lib/chain_signer_admission.js.
    isRegisteredSender(envelope) {
        return isAdmissibleSigner(this.peerManager, envelope);
    },

    handleMessage(envelope) {
        if (envelope.type !== ORACLE_PRICE_SUBMIT) return;

        let { round, prices, sources } = envelope.data;
        if (!admissibleSubmission.call(this, envelope, round, prices)) return;

        // Initialize submission map for this round if needed
        if (!this.submissions.has(round)) {
            this.submissions.set(round, new Map());
        }

        // Record the submission (first submission per sender per round wins)
        let roundSubs = this.submissions.get(round);
        if (roundSubs.has(envelope.sender)) return; // Already have a submission from this sender

        let senderPubkey = provenPubkey(envelope);
        if (droppedAsDuplicateOrOverCap.call(this, roundSubs, envelope, round, senderPubkey)) return;

        let validPrices = canonicalSubmittedPrices.call(this, prices, envelope, round);
        if (validPrices === null) return;

        roundSubs.set(envelope.sender, {
            prices:    validPrices,
            sources:   sources || 0,
            timestamp: envelope.timestamp,
            // Proven signing key (lowercase hex), or null only on a pre-bootstrap
            // envelope that carried none. OracleConsensus keys its snapshot
            // membership filter on this.
            pubkey:    senderPubkey
        });

        logger.info('Oracle: Received submission from ' + envelope.sender +
            ' for round ' + round + ' (' + roundSubs.size + ' total)');

        persistPeerSubmission.call(this, round, envelope, validPrices, senderPubkey);
    }

};

// May this envelope's submission be recorded at all: right shape, an attributed
// signer, and a round this hub is still collecting for. A late submission for the
// current round is admitted and announced, exactly as before.
function admissibleSubmission(envelope, round, prices) {
    // Round 0 is a real, valid round (first interval after ORACLE_EPOCH_START); guard
    // on integer/non-negative, not falsiness, or a genesis round-0 submission is dropped.
    if (!Number.isInteger(round) || round < 0 || !prices || !Array.isArray(prices)) return false;

    // Drop submissions whose signing key neither the chain nor the registry
    // attributes. Without this gate a single authorized key can broadcast many
    // submissions, each naming a distinct fake `sender`, Sybil-stuffing the
    // trimmed-median aggregate and the ORACLE_MIN_SUBMISSIONS diversity floor
    // from one node. The dedup below closes that off for good by keying on the
    // proven key rather than on the self-asserted sender.
    if (!this.isRegisteredSender(envelope)) return false;

    // Only accept submissions for current or next round
    if (round < this.currentRound - 1 || round > this.currentRound + 1) return false;

    // Check if we're still within the submission window
    let elapsed = Date.now() - this.roundStartTime;
    if (round === this.currentRound && elapsed > this.submissionWindow) {
        // Late submission: still record it but log
        logger.info('Oracle: Late submission from ' + envelope.sender + ' for round ' + round);
    }
    return true;
}

// Whether this submission is a second one from a key already counted this round,
// or one past the per-round cap.
//
// The PROVEN signing key of this envelope, which the admission gate above has
// already established the chain or the registry attributes. Taken from the
// envelope rather than looked up by addr in the registry: a chain-attributed
// validator has no registry row, so the old lookup returned null for it and
// its submission was dropped downstream as unresolvable. Dedup on this key:
// one key may present under several addrs, so a sender-keyed first-wins
// alone lets a single signing key submit once per addr, multiplying its
// weight in the trimmed median and the ORACLE_MIN_SUBMISSIONS floor.
function droppedAsDuplicateOrOverCap(roundSubs, envelope, round, senderPubkey) {
    if (senderPubkey) {
        for (let sub of roundSubs.values()) {
            if (sub && sub.pubkey === senderPubkey) {
                logger.warn('Oracle: dropping duplicate submission for round ' + round +
                    ' from ' + envelope.sender + ': pubkey ' + senderPubkey.substring(0, 16) +
                    '... already submitted under another sender');
                return true;
            }
        }
    }

    // Enforce max submissions per round
    if (roundSubs.size >= this.maxSubmissionsPerRound) {
        logger.warn('Oracle: Max submissions per round reached for round ' + round + '; dropping from ' + envelope.sender);
        return true;
    }
    return false;
}

// Validate individual prices: filter to positive finite values within bounds
// AND to the canonical pair whitelist (reject fabricated/novel coin pairs).
// Returns null when nothing survives, which discards the whole submission.
//
// The spelling is checked before the bounds, and the CANONICAL spelling is
// what the entry carries onward. parseFloat alone is prefix-tolerant, so a
// peer's '100junk' admitted as 100 and was then kept verbatim: it reached
// the round's submission map, the trimmed median, and the oracle_submissions
// audit row, where bcmath reads it as 0 (bcnum coerces a non-numeric). Same
// value, two readings. lib/canonical_price.js carries the full argument.
function canonicalSubmittedPrices(prices, envelope, round) {
    let validPrices = [];
    for (let p of prices) {
        if (!p || !this.canonicalPairs.has(p.coinPair)) continue;
        let canon = canonicalPrice(p.price);
        if (canon === null) continue;
        let val = parseFloat(canon);
        if (!(Number.isFinite(val) && val > 0 && val < this.priceMax)) continue;
        // Rebuild only when the spelling actually differed, so an honest
        // submission's entry stays the object every other field came from.
        validPrices.push(canon === p.price ? p : Object.assign({}, p, { price: canon }));
    }
    // Surface both drop paths (item ce5a2d5d): the sibling drops at lines 531/545
    // already log, this filter was the one silent gap. A partial drop masks a peer
    // degrading pair coverage; a zero-valid drop masks the true cause of a
    // below-minimum-submissions round skip.
    if (validPrices.length < prices.length)
        logger.warn('Oracle: dropped ' + (prices.length - validPrices.length) + ' invalid/non-canonical pair(s) from '
            + envelope.sender + ' for round ' + round);
    if (validPrices.length === 0) {
        logger.warn('Oracle: submission from ' + envelope.sender + ' for round ' + round
            + ' had zero valid pairs (of ' + prices.length + '); discarding entire submission');
        return null;
    }
    return validPrices;
}

// Write the audit row for a peer's accepted submission.
function persistPeerSubmission(round, envelope, validPrices, senderPubkey) {
    // Resolve sender's validator pubkey. Drop the DB persist if unresolved:
    // keeps the in-memory submission for aggregation but avoids placeholder rows.
    let validatorPubkey = null;
    if (this.peerManager.validatorPubkeys) {
        let pk = this.peerManager.validatorPubkeys.get(envelope.sender);
        if (pk) validatorPubkey = pk;
    }
    if (!validatorPubkey) {
        // The registry is a hand-maintained addr->key table, so a hub that holds no
        // federation identity of its own has no reason to carry a row for every peer
        // whose frames it merely receives: it dropped the audit row for the WHOLE
        // federation and its database showed no view of the network at all. The
        // envelope already carries a signature-proven key, and the stake-weight feed
        // can say whether that key holds qualifying stake at the round's block, which
        // is a stronger attribution than a typed row and is the same set the round's
        // own aggregation filters submissions down to. Registering the peers is NOT
        // the alternative: it puts a key in a local table without telling this hub
        // anything about the stake behind it.
        this.persistFromStakeWeight(round, envelope, validPrices, senderPubkey);
        return;
    }
    // Remote peer submission: handleMessage is a synchronous message handler, so this
    // stays fire-and-forget, but persistSubmissions now counts its own failures
    // internally (via allSettled) and never rejects, so the drop is still observable.
    this.persistSubmissions(round, envelope.sender, validPrices, validatorPubkey);
}
