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
 * XChain Hub - Price Aggregator: single-round PRICE v0 ingest
 *
 * Receives ONE validated PRICE v0 round: re-verifies its signature set against
 * the canonical payload, sizes the quorum in the mode the round's flag day
 * selects, and stores the round as one atomic multi-row insert.
 *
 ********************************************************************/

const ValidatorIdentity = require('../../validators/identity.js');
const priceSigTally     = require('../../price_sig_tally_activation.js');
const swq               = require('../../stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { validateRoundFields, validateRoundPairs, validateRoundSigs } = require('./round_validation.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Dedupe: if a NON-SKIPPED row exists for this round_number, this is a
// duplicate of an already-finalized round. 'skipped' placeholder rows
// (written by OracleConsensus.storeSkippedRound when this hub had no
// local submissions) must NOT count as a duplicate. A real validated
// round for the same round_number can still arrive from a peer chain that
// did reach quorum, and it must be allowed to overwrite the placeholders
// (see the ON DUPLICATE KEY UPDATE on the insert below).
function duplicateRoundRead(round) {
    return this.db.getPriceSnapshotByRoundNumber(round);
}

// STAKE_WEIGHTED_QUORUM: at/above activation the chain finalizes a PRICE v0 on the
// summed STAKE of its qualified signers rather than their COUNT (actions/price.js).
// This method is the hub's MIRROR of that same verification, not a producer, so it
// has to switch on the identical key or hub and chain read one signed round under
// two rules: the hub withholds on a round the chain finalized under stake weight
// (fewer signatures than the count bar), or stores one the chain refused (many
// small signers, insufficient distinct-source stake).
//
// Keyed on btcBlockHeight, the round's signed BTC anchor, which is exactly what the
// indexer twin keys on. Keying on referenceBlock (the height of the chain the PRICE
// landed on) would flip LTC/DOGE months early, their heights already dwarfing the
// BTC activation height. Unlike the pair-name gate above there is no
// timestamp-vs-block-time asymmetry to accept: btc_block_height rides in the push
// payload and is validated at the top of this method, so hub and chain evaluate the
// same number and cannot straddle the flag day. Hub and indexer are PEERS here:
// deploy both before the activation height.
//
// The snapshot BLOCK stays referenceBlock in both modes. The twin resolves its
// weights at the PRICE's own BLOCK_INDEX, so moving this key would trade one
// divergence for another.
function weightedModeFor(btcBlockHeight) {
    return swq.isStakeWeightedQuorumActive(btcBlockHeight, this.hub && this.hub.network);
}

// Resolve the deterministic price-capability validator set at the
// round's block. Fail closed: without the snapshot the sigs cannot be
// checked against the qualified set, so the round is rejected rather
// than stored on trust. A weight snapshot the hub cannot resolve rejects
// too and never falls back to the count quorum: unlike OracleConsensus
// (a producer, which may skip a round) this is the verifier, and
// downgrading its threshold locally would accept rounds the chain rejects.
function refuseUnusableSnapshot(snapshot, weighted) {
    if (!snapshot || !Array.isArray(snapshot.validators)) {
        return 'validator snapshot unavailable';
    }
    // SWQ-TRUNC parity: a truncated weight snapshot has silently-dropped sources, so
    // its total stake S is under-counted and the strict 2/3 bar could pass a round the
    // full set would refuse. meetsStakeThreshold fails closed on the flag, but reads it
    // off the validators ARRAY while getWeightSnapshot carries it on the snapshot, so
    // refuse here rather than relying on a flag that would never arrive.
    if (weighted && snapshot.truncated === true) {
        return 'validator snapshot truncated';
    }
    return null;
}

// The canonical bytes the validators signed. The admission map comes off the pushed
// round, because the producer signed THAT map and a map re-resolved from this hub's own
// tips would rebuild bytes no signature covers. An absent map is the legacy round. A map
// the canonical encoder refuses is a REJECTED push and never a thrown request: the era
// gate and the spelling rules both report through this reason, so an operator sees which
// round was refused instead of a 500 on the ingest path.
function buildRoundPayload(round, timestamp, roundData, btcBlockHeight) {
    try {
        return { payload: this._buildPriceV0Payload(round, timestamp, roundData.pairs, btcBlockHeight,
                                                    roundData.admit_blocks) };
    } catch (e) {
        return { reason: 'admission map unusable: ' + e.message };
    }
}

// Verify each sig over the canonical payload, counting at most one per
// qualified pubkey. Unknown or invalid sigs are skipped rather than
// fatal (same semantics as the indexer's PRICE v0 parser), so any
// round the indexer accepted on-chain also verifies here, but only
// cryptographically-valid sigs from snapshot members count for quorum.
//
// PRICE_SIG_TALLY: WHERE the pubkey enters the dedupe set. At/above
// the gate it enters only after a successful verify, so a garbage signature
// carrying a qualified oracle's pubkey cannot be ordered ahead of that
// oracle's real one to consume its slot and under-count the round. Below the
// gate the legacy mark-on-first-encounter ordering is preserved verbatim.
// Either way a pubkey counts AT MOST ONCE.
//
// Keyed on btcBlockHeight, the round's signed BTC anchor, which is EXACTLY
// what the indexer twin keys on (actions/price.js). Unlike the pair-name gate
// above there is no timestamp-vs-block-time asymmetry to accept here: the push
// payload carries btc_block_height and it is validated at the top of this
// method, so the hub and the chain evaluate the identical number and can never
// straddle the flag-day. Hub and indexer are PEERS across this gate, not
// producer and consumer: deploy both before the activation height, or the hub
// finalizes rounds the chain rejects (or withholds on rounds it accepts).
function verifyRoundSigs(sigs, snapshot, payload, btcBlockHeight) {
    let qualified  = new Set(snapshot.validators.map(v => String(v.pubkey).toLowerCase()));
    let seenPubkey = new Set();
    let verifiedSigs = [];
    let verifyFirst = priceSigTally.isPriceSigTallyVerifyFirstActive(
        btcBlockHeight, this.hub && this.hub.network);

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

// Finalization threshold, in whichever mode the flag day above selected. Both
// branches are the same threshold the indexer enforces when validating the
// action, which is the whole point of the gate: at/above activation it tallies
// the summed source-deduped STAKE of the verified signers (3*tally > 2*S), below
// it the PBFT quorum over the snapshot size, floored at a simple majority
// (max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2))).
function roundQuorumReason(weighted, snapshot, verifiedSigs) {
    if (weighted) {
        // Tallied over the verified signer PUBKEYS, the same set the twin passes as
        // qualifiedSigners. meetsStakeThreshold source-dedupes internally, so a source
        // that signed with several keys counts once.
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

// Source-chain reorg fence (item 5308): the generation the source indexer
// carried on this push. Stamped on the row so a later deferred retraction
// (which carries the rollback's generation) deletes only stale rows and a
// re-published row at a recycled action_index (higher generation) survives.
function pushGenerationOf(roundData) {
    let pushGeneration = parseInt(roundData.push_generation);
    if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;
    return pushGeneration;
}

// The rows this round contributes to price_snapshots, in the column order the
// mirror stream and every positional reader of the insert already expect.
function priceSnapshotRows(round, roundData, sourceChain, stamps, admitCols) {
    let insertedRows = [];
    for (let p of roundData.pairs) {
        insertedRows.push({
            round_number:        round,
            coin_pair:           p.pair,
            price:               p.price,
            reference_block:     stamps.referenceBlock,
            reference_chain:     sourceChain || null,
            block_timestamp:     stamps.timestamp,
            validator_count:     stamps.validatorCount,
            consensus_round:     1,
            consensus_proof:     stamps.proofJson,
            status:              'finalized',
            source_chain:        sourceChain || null,
            source_action_index: stamps.sourceActionIndex,
            push_generation:     stamps.pushGeneration,
            created_at:          stamps.createdAt,
            admit_block_btc:     admitCols.admit_block_btc,
            admit_block_ltc:     admitCols.admit_block_ltc,
            admit_block_doge:    admitCols.admit_block_doge
        });
    }
    return insertedRows;
}

// Upsert (not a plain INSERT): a 'skipped' placeholder row may already occupy
// this (round_number, coin_pair) unique key from storeSkippedRound. Overwrite
// it with the real finalized data rather than colliding on the key. For an
// already-finalized row this is an idempotent no-op of identical data (failover
// double-publish safe). created_at is intentionally NOT overwritten so it
// preserves when the hub first recorded the round.
//
// ONE multi-row INSERT lands the whole round atomically; a getfeequote /
// getpricesnapshots reader (or the id-ordered mirror bootstrap) can never observe
// a torn round (some pairs from this round, others from the prior round). The hub
// Database has no transaction API, so a single statement is the atomicity tool.
function pushedRoundInsert(round, roundData, sourceChain, stamps, admitCols) {
    return this.db.setPushedPriceSnapshotRound(round, roundData.pairs, stamps.referenceBlock, sourceChain || null,
        stamps.timestamp, stamps.validatorCount, stamps.proofJson, stamps.sourceActionIndex, stamps.pushGeneration,
        stamps.createdAt, admitCols);
}

// Announce a stored round: the mirror rows, the accepted line, and the coverage check.
function announceStoredRound(round, sourceChain, roundData, insertedRows, validatorCount) {
    // Emit row events so the hub DB sync channel can broadcast to subscribers
    for (let row of insertedRows) {
        this.emit('row:inserted', { table: 'price_snapshots', row: row });
    }

    logger.info('PriceAggregator: accepted round ' + round + ' from ' + (sourceChain || 'unknown') + ' (' + roundData.pairs.length + ' pairs, ' + validatorCount + ' sigs)');

    // Per-pair coverage check (item 5335): name any pair this chain had been sending and
    // this round did not carry, so an ingest hub's silent pair drop is as visible as the
    // producer path's droppedPairs. Diagnostics only, and guarded: the round is already
    // stored and must never be flipped to rejected by a coverage warning.
    try {
        this.checkIngestPairCoverage(sourceChain, round, roundData.pairs);
    } catch (e) {
        logger.warn(nodeUtil.format('PriceAggregator: pair-coverage check failed for round ' + round + ':', e.message));
    }
}

// The store half, after the round has cleared verification and quorum: the stale-replay
// fence, the atomic insert and the announcements. Async because those are its own awaits;
// the caller returns its result directly, so nothing of the caller's runs after it.
async function storeVerifiedRound(sourceChain, roundData, head, verifiedSigs) {
    let { round, timestamp, referenceBlock } = head;
    // Only the verified signatures are stored as the consensus proof
    let proofJson = JSON.stringify(verifiedSigs);
    let validatorCount = verifiedSigs.length;
    let sourceActionIndex = roundData.action_index || null;
    let pushGeneration = pushGenerationOf(roundData);

    // HUB-RETRACT-4: same stale-replay ingest fence as receiveOraclePrice. A PBFT round push
    // that arrives after its source action was rolled back and retracted (carrying the pre-reorg
    // generation) is rejected; the re-published canonical round carries a higher generation. No
    // action_index (older sender) => no fence, as before.
    let roundActionIndex = parseInt(sourceActionIndex);
    if (Number.isFinite(roundActionIndex)) {
        let wm = await this.db.getPriceIngestWatermark(sourceChain || '', this.fenceNetwork());
        if (wm && pushGeneration <= wm.retraction_generation && roundActionIndex >= wm.from_action_index) {
            // Never silent: a rebuilt indexer trips this fence on every push.
            this.warnIngestFenceRejection(sourceChain, 'PRICE v0 round', pushGeneration, roundActionIndex, wm);
            return { accepted: false, reason: 'stale (retracted generation)' };
        }
    }

    // Capture a single hub-side timestamp before the loop so all pairs in this round
    // share the same created_at and it propagates to operators via the WS broadcast row.
    let createdAt = new Date();
    let stamps = { referenceBlock, timestamp, validatorCount, proofJson, sourceActionIndex, pushGeneration, createdAt };
    let insertedRows = [];
    if (roundData.pairs.length) {
        // The round's admission map, the one the verified signatures cover, stored in its
        // per-chain columns (NULL for a legacy round, never 0), appended AFTER created_at
        // so every positional reader of this INSERT keeps its index.
        let admitCols = this.admission.admitBlocksToColumns(roundData.admit_blocks == null ? null : roundData.admit_blocks);
        insertedRows = priceSnapshotRows(round, roundData, sourceChain, stamps, admitCols);
        try {
            await pushedRoundInsert.call(this, round, roundData, sourceChain, stamps, admitCols);
        } catch (err) {
            logger.error(nodeUtil.format('PriceAggregator: error inserting round ' + round + ':', err));
            return { accepted: false, reason: 'db error' };
        }
    }

    announceStoredRound.call(this, round, sourceChain, roundData, insertedRows, validatorCount);
    return { accepted: true };
}

module.exports = {

    // The pusher's local validation is NOT trusted: before any row is stored
    // as 'finalized', every signature is re-verified here against the
    // canonical payload, signers must be in the price-capability validator
    // snapshot at block_index, and the verified count must meet PBFT quorum.
    // Returns: { accepted, reason } where reason explains the rejection
    async receiveValidatedRound(sourceChain, roundData) {
        let head = validateRoundFields.call(this, sourceChain, roundData);
        if (head.reason) return { accepted: false, reason: head.reason };
        let { round, timestamp, referenceBlock, btcBlockHeight } = head;

        let pairsReason = validateRoundPairs.call(this, roundData, timestamp);
        if (pairsReason) return { accepted: false, reason: pairsReason };

        let structural = validateRoundSigs(roundData);
        if (structural.reason) return { accepted: false, reason: structural.reason };

        let existing = await duplicateRoundRead.call(this, round);
        if (existing && existing.length > 0) {
            return { accepted: false, reason: 'duplicate' };
        }

        let weighted = weightedModeFor.call(this, btcBlockHeight);
        let capSnap  = this.hub.capabilitySnapshot;
        let snapshot = null;
        if (capSnap) {
            snapshot = weighted
                ? (typeof capSnap.getWeightSnapshot === 'function'
                    ? await capSnap.getWeightSnapshot('price', referenceBlock)
                    : null)
                : await capSnap.getSnapshot('price', referenceBlock);
        }
        let snapshotReason = refuseUnusableSnapshot(snapshot, weighted);
        if (snapshotReason) return { accepted: false, reason: snapshotReason };

        let built = buildRoundPayload.call(this, round, timestamp, roundData, btcBlockHeight);
        if (built.reason) return { accepted: false, reason: built.reason };

        let verifiedSigs = verifyRoundSigs.call(this, structural.sigs, snapshot, built.payload, btcBlockHeight);
        let quorumReason = roundQuorumReason(weighted, snapshot, verifiedSigs);
        if (quorumReason) return { accepted: false, reason: quorumReason };

        return storeVerifiedRound.call(this, sourceChain, roundData, head, verifiedSigs);
    }

};
