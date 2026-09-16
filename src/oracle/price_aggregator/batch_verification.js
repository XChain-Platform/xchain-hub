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
 * XChain Hub - Price Aggregator: PRICE batch verification
 *
 * The one pass that decides whether a pushed batch is the federation's: the
 * quorum mode, the validator snapshot at the batch anchor, the canonical bytes,
 * the signature tally and the threshold, plus the proof the stored rows carry.
 *
 ********************************************************************/

const ValidatorIdentity = require('../../validators/identity.js');
// The verify-first tally rule is a registry row read by literal key (W5), on the
// batch's BTC anchor height.
const gateRegistry      = require('../../consensus/gate_registry');
const PRICE_SIG_TALLY_KEY = 'price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION';
const swq               = require('../../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// THE VALIDATOR SNAPSHOT RESOLVES ON THE BATCH'S SIGNED BTC ANCHOR, NOT ON THE
// LANDING BLOCK. Capability staking lives only on Bitcoin, so the qualifying set
// is BTC-anchored everywhere: the hub reads it from the BTC indexer at a BTC
// height, and the indexer twin reads the mirrored capability_snapshots whose
// snapshot_block IS a BTC height. Keying this on block_index made the two agree
// only on Bitcoin, where the landing block IS the BTC block. Off Bitcoin a
// Dogecoin or Litecoin height names no BTC block at all, the read resolved
// nothing, and every batch a four-validator federation signed and landed on
// chain was refused here as 'validator snapshot unavailable' while the chain
// had accepted it. A hub keyed differently from the chain silently drops an
// hour of rounds the chain finalized, and under batching this action is the
// sole carrier of those rounds.
//
// The reorg buffer CapabilitySnapshot subtracts before resolving keeps meaning
// what it always meant, and only now means it off Bitcoin too: it buries a BTC
// height by BTC confirmations, rather than subtracting six landing-chain blocks
// from a number that was never a BTC height.
async function resolveBatchSnapshot(weighted, btcBlockHeight) {
    let capSnap  = this.hub.capabilitySnapshot;
    let snapshot = null;
    if (capSnap) {
        snapshot = weighted
            ? (typeof capSnap.getWeightSnapshot === 'function'
                ? await capSnap.getWeightSnapshot('price', btcBlockHeight)
                : null)
            : await capSnap.getSnapshot('price', btcBlockHeight);
    }
    return snapshot;
}

// Fail closed: without the snapshot the sigs cannot be checked against the
// qualified set, so the batch is refused rather than stored on trust.
function refuseUnusableBatchSnapshot(snapshot, weighted) {
    if (!snapshot || !Array.isArray(snapshot.validators)) {
        return 'validator snapshot unavailable';
    }
    // SWQ-TRUNC parity (see receiveValidatedRound): a truncated weight snapshot
    // under-counts total stake, so the strict 2/3 bar could pass a batch the full
    // set would refuse.
    if (weighted && snapshot.truncated === true) {
        return 'validator snapshot truncated';
    }
    return null;
}

// ADMISSION ERA, PER ROUND, FAIL CLOSED IN BOTH DIRECTIONS. Every round in the
// admission era must carry its own map and every legacy round must carry none; the
// batch canonical enforces that inside buildPriceBatchPayload, which throws for a
// mismatch in either direction, and a throw there is a whole-batch refusal here
// rather than a stored legacy row. The mirror admission activation is in the
// straddle rule above for the same reason the other two gates are: a window whose
// rounds sit on both sides of it would carry a mixed set, and the ruling is one map
// per round with every round in one era, so the publisher splits at the boundary
// exactly as it does at the older gates. Without the per-round rule an admission-era
// batch would VERIFY and store its rounds as legacy rows above the very activation
// that is supposed to bind them by height, the fail-OPEN direction.
//
// ONE verification pass over the batch canonical. buildPriceBatchPayload is the
// byte-for-byte twin of the indexer's and OracleConsensus's builders; never
// inline the JSON here, or the three copies drift and every honest batch fails.
function buildBatchPayload(head, rounds, network) {
    try {
        return { payload: this.buildPriceBatchPayload(head.firstRound, head.lastRound, head.btcBlockHeight, rounds) };
    } catch (e) {
        // The era rule firing: an admission-era round with no map, or a legacy round
        // handed one. Never silent, or an operator reading only "rejected" hunts a
        // signature bug on a rail the activation just armed.
        logger.warn('PriceAggregator: refusing PRICE batch [' + head.firstRound + '..' + head.lastRound +
            '] at anchor ' + head.btcBlockHeight + ' on ' + String(network) + ': ' + (e && e.message));
        return { reason: 'admission map does not match the round\'s era' };
    }
}

// One signature pass over the batch canonical, on the v0 rules: at most one count
// per qualified pubkey, and PRICE_SIG_TALLY decides where the pubkey enters the
// dedupe set (see verifyRoundSigs in round_ingest.js).
function verifyBatchSigs(sigs, snapshot, payload, btcBlockHeight, network) {
    let qualified    = new Set(snapshot.validators.map(v => String(v.pubkey).toLowerCase()));
    let seenPubkey   = new Set();
    let verifiedSigs = [];
    let verifyFirst  = gateRegistry.activeAt(PRICE_SIG_TALLY_KEY, network, null, btcBlockHeight, null);

    for (let s of sigs) {
        if (seenPubkey.has(s.pubkey)) continue;        // duplicate pubkey counts once
        if (!verifyFirst) seenPubkey.add(s.pubkey);
        if (!qualified.has(s.pubkey)) continue;        // not price-qualified at this block
        if (!ValidatorIdentity.verify(payload, s.sig, s.pubkey)) continue;
        if (verifyFirst) seenPubkey.add(s.pubkey);
        verifiedSigs.push(s);
    }
    return verifiedSigs;
}

// The batch threshold, in whichever mode the batch anchor selected; identical to
// the single-round gate, because the chain applies one rule to both.
function batchQuorumReason(weighted, snapshot, verifiedSigs) {
    if (weighted) {
        if (!swq.meetsStakeThreshold(snapshot.validators, verifiedSigs.map(s => s.pubkey))) {
            return 'insufficient signer stake (' + verifiedSigs.length + ' verified signers)';
        }
    } else {
        let setSize = Number.isFinite(parseInt(snapshot.count)) ? parseInt(snapshot.count) : snapshot.validators.length;
        let quorum  = bftQuorumOrSingle(setSize, 1);   // majority-floored BFT quorum
        if (verifiedSigs.length < quorum) {
            return 'insufficient quorum (' + verifiedSigs.length + '/' + quorum + ')';
        }
    }
    return null;
}

// Batch consensus proof (D23). Key order is PINNED: the acceptance test compares
// this serialized value across a replaying node and a live one, so a reordering
// here would read as a mismatch even with identical content. The `batch` object
// is also what tells a batch-sourced row from a v0-sourced one, whose proof is a
// bare signature ARRAY; retractFromActionIndex relies on that.
function batchProofJson(head, verifiedSigs) {
    return JSON.stringify({
        batch: {
            first_round:      head.firstRound,
            last_round:       head.lastRound,
            btc_block_height: head.btcBlockHeight
        },
        sigs: verifiedSigs
    });
}

// The whole verification half: quorum mode, snapshot, canonical bytes, signatures
// and threshold. Async only because the snapshot read is; every await inside is one
// the single-pass path always made, in the same order.
async function verifyBatchQuorum(sigs, head, rounds) {
    let network = this.hub && this.hub.network;
    // Both quorum gates resolve on the BATCH anchor, which is what the indexer twin
    // keys on for a batch action, and the straddle rule above is what makes one
    // resolution sound for every round in the window.
    let weighted = swq.isStakeWeightedQuorumActive(head.btcBlockHeight, network);
    let snapshot = await resolveBatchSnapshot.call(this, weighted, head.btcBlockHeight);
    let snapshotReason = refuseUnusableBatchSnapshot(snapshot, weighted);
    if (snapshotReason) return { reason: snapshotReason };

    let built = buildBatchPayload.call(this, head, rounds, network);
    if (built.reason) return { reason: built.reason };

    let verifiedSigs = verifyBatchSigs(sigs, snapshot, built.payload, head.btcBlockHeight, network);
    let quorumReason = batchQuorumReason(weighted, snapshot, verifiedSigs);
    if (quorumReason) return { reason: quorumReason };
    return { verifiedSigs, validatorCount: verifiedSigs.length, proofJson: batchProofJson(head, verifiedSigs) };
}

module.exports = { verifyBatchQuorum };
