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
 * XChain Hub - Oracle Consensus: storing a round
 *
 * What a finalized or skipped round leaves behind: the capability snapshot mirrored at
 * its anchor, the one atomic multi-row insert, the per-pair skip markers, and the
 * broadcast that hands the rows to the hub-DB mirror subscribers.
 *
 ********************************************************************/

'use strict';

const PriceFetcher      = require('../price_fetcher.js');
const { DERIVED_PAIRS } = require('../../constants.js');
const swq               = require('../../stake_weighted_quorum.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The rest of a stored round: the per-pair skip markers for pairs it dropped, the clamp
// reference the next round is judged against, then the mirror broadcast.
async function finishStoredRound(round, prices, referenceBlock, blockTimestamp) {
    // Durable per-pair skip markers (item #180). A pair can drop out of a
    // round that otherwise finalizes (aggregation clamp/deviation-gate/trim
    // returns null, or the leader simply didn't propose it); before this,
    // that pair got neither a 'finalized' nor a 'skipped' row, so consumers
    // silently fell back to the previous round with no observable signal.
    // Write a 'skipped' row (same shape as storeSkippedRound) for every
    // configured pair absent from the finalized set, so the drop is durable,
    // countable, and visible to getSubmissionsInfo/dashboard health. This is
    // derived from the finalized proposal + local pair config, so every hub
    // writes the same rows deterministically. Best-effort: never fail the
    // finalized write over the marker.
    try {
        let finalizedPairs = new Set(prices.map(p => p.coinPair));
        let missingPairs = this.markerPairs(round).filter(pair => !finalizedPairs.has(pair));
        if (missingPairs.length) {
            logger.warn('Oracle: round ' + round + ' finalized without ' + missingPairs.length
                + ' configured pair(s): ' + missingPairs.join(', ')
                + '; recording per-pair skipped snapshot(s)');
            await this.db.setSkippedPriceSnapshotRound(round, missingPairs, referenceBlock, blockTimestamp);
        }
    } catch (e) {
        logger.error(nodeUtil.format('Oracle: error recording per-pair skipped snapshot(s) for round %s:', round, e.message));
    }

    // Update the in-memory last-finalized-price cache so the co-sign gate in
    // _handlePropose can apply a historical-deviation check for pairs a hub
    // did not price locally in the current round (seq 4083).
    // Retain the reference THIS round's aggregate clamped against, before the round
    // being stored overwrites it. SlashDetector needs it to tell a pair the clamp
    // actually moved from one it did not (item 5833); nothing is added to
    // round:finalized and no wire format changes, so evidence bodies and their
    // hashes are byte-identical. One round is kept, replaced on the next store.
    this._clampReference = { round: round, prices: new Map(this._lastFinalizedPrices || []) };
    this.updateLastFinalizedPrices(prices, round);

    return broadcastStoredRound.call(this, round);
}

// Stream the freshly stored rows to the hub-DB mirror subscribers, dropping them for a
// resync when the re-read fails: a silent gap would certify a round no subscriber received.
async function broadcastStoredRound(round) {
    // Broadcast the finalized rows to hub-DB mirror subscribers (distributed indexers),
    // mirroring StateCheckpointEngine/CrossChainDexEngine. This must happen AFTER the
    // atomic write so a subscriber never sees a partial round. Without this the round
    // is written via a bare INSERT that emits nothing, so a replica's price mirror never
    // receives it live and _priceSyncSatisfied passes while the round is absent, causing
    // the replica to validate native-coin fees against the prior round (ledger divergence).
    // Never block finalize, but never SWALLOW a failure either: the watermark heartbeat
    // advances on its own wall-clock timer and would certify the stream complete past a
    // round no subscriber ever received, re-opening the exact divergence this broadcast
    // closes. A failed re-read therefore drops the subscribers so each one reconnects and
    // its bootstrap max-id gap detection re-drains the round (item 4459).
    if (this.hub && this.hub.hubDbBroadcaster) {
        try {
            let rows = await this.db.findPriceSnapshotsForRound(round);
            for (let row of rows) this.hub.hubDbBroadcaster.broadcastRow({ table: 'price_snapshots', row });
        } catch (e) {
            logger.error('Oracle: post-commit price-round broadcast failed for round ' + round
                + '; forcing subscriber resync: ' + (e && e.message));
            try { this.hub.hubDbBroadcaster.dropAllForResync('price-round broadcast gap'); }
            catch (err) { /* the repair itself must not fail finalize */ }
        }
    }
}

module.exports = {

    // `admitBlocks` is the round's admission map, stored in its per-chain columns with every
    // federation column named (NULL for a legacy round, never 0), so the batch signer and
    // the publisher rebuild the map the quorum signed from the row rather than from memory.
    async _storeSnapshot(round, prices, validatorCount, proof, btcBlockHeight, btcBlockTime, admitBlocks) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        if (!prices || prices.length === 0) return;

        // Mirror the round's `price` validator set into capability_snapshots at the
        // round's BTC anchor, BEFORE the round's own rows land.
        //
        // Capability staking is BTC-only at the protocol level (coins/DOGE.js and
        // coins/LTC.js declare CAPABILITIES: {}), so a non-BTC indexer resolves the
        // price-capable set from the hub-mirrored capability_snapshots or not at all.
        // Nothing on the oracle path ever wrote a `price` row: finalizeRound and
        // _handlePropose resolve the set through CapabilitySnapshot, which is a cached
        // RPC read against the BTC indexer and persists nothing. The mirror therefore
        // carried only cross_chain and oracle_publish rows, and every PRICE action
        // published off BTC resolved an EMPTY set, summed to zero stake and recorded
        // 'invalid: insufficient signer stake' with signatures that all verify.
        //
        // EVERY hub persists, not just the leader: an indexer verifies a PRICE action
        // against capability_snapshots in whichever hub DB it mirrors, and a follower's
        // DB may be the only one it reads. Deterministic from the BTC stakes at the
        // anchor plus INSERT IGNORE, so every hub writes identical rows and a re-finalize
        // of the same round is a no-op (same idempotency contract as the cross_chain and
        // oracle_publish writers).
        //
        // Ordered first, and fail-closed by throwing, for the reason StateCheckpointEngine
        // states for its oracle_publish persist: a mirror subscriber must never receive a
        // quorum-signed row it cannot verify. A throw here skips the price_snapshots
        // INSERT and its broadcast entirely; finalizeCommittedRound's retry loop then
        // retains the round and re-drives it, and OracleRound's finalizeRound .catch logs
        // the single-node path.
        //
        // referenceBlock is the same value the round resolved its snapshot at
        // (finalizeRound's btcBlockHeight, threaded through pending.btcBlockHeight), so
        // every chain's indexer reads the SAME snapshot block for the same round. Never
        // the local processing height.
        await this._persistCapabilitySnapshot('price', referenceBlock);

        // Write the whole round in ONE multi-row INSERT (mirrors db.setParams) so the
        // round lands atomically. The per-pair loop this replaced let a getfeequote /
        // getpricesnapshots reader observe a torn round (some pairs from round N, others
        // from N-1) mid-loop, and the id-ordered mirror bootstrap could persist that torn
        // read to a replica. The hub Database exposes no transaction API, so a single
        // statement is the atomicity primitive here.
        let admitCols = this.admission.admitBlocksToColumns(admitBlocks === undefined ? null : admitBlocks);
        await this.db.setFinalizedPriceSnapshotRound(round, prices, referenceBlock, blockTimestamp, validatorCount, proof, admitCols);

        return finishStoredRound.call(this, round, prices, referenceBlock, blockTimestamp);
    },

    // Resolve the qualifying validator set for `capability` at a BTC block, normalized to
    // { pubkey, source, weight, amount }. Same shape and same activation gate as
    // StateCheckpointEngine/CrossChainDexEngine.resolveCapabilityValidators: at/above
    // STAKE_WEIGHTED_QUORUM activation (keyed on the BTC block + this hub's network) the
    // SOURCE-KEYED weights, below it the legacy count set (source='', weight=amount), so
    // the rows this hub mirrors match the rows those engines mirror for the same block.
    // A degraded snapshot (indexer RPC error / auth mismatch surfaces as null) normalizes
    // to [], which persists nothing rather than inventing membership.
    async resolveCapabilityValidators(capability, block) {
        let validators = [];
        let capSnapshot = this.hub ? this.hub.capabilitySnapshot : null;
        if (!capSnapshot) return validators;
        let weighted = swq.isStakeWeightedQuorumActive(block, this.hub.network);
        if (weighted) {
            let snap = await capSnapshot.getWeightSnapshot(capability, block);
            if (snap && Array.isArray(snap.validators)) {
                validators = snap.validators.map(v => ({
                    pubkey: v.pubkey,
                    source: String(v.source != null ? v.source : ''),
                    weight: String(v.weight != null ? v.weight : '0'),
                    amount: String(v.weight != null ? v.weight : '0')
                }));
                // Carry the truncation marker through the .map so the persist below can
                // refuse an over-cap set (SWQ-TRUNC parity with the other writers).
                if (snap.truncated === true) validators.truncated = true;
            }
        } else {
            let snap = await capSnapshot.getSnapshot(capability, block);
            if (snap && Array.isArray(snap.validators)) {
                validators = snap.validators.map(v => ({
                    pubkey: v.pubkey,
                    source: '',
                    weight: String(v.amount != null ? v.amount : '0'),
                    amount: String(v.amount != null ? v.amount : '0')
                }));
                // getSnapshot marks an over-cap COUNT set truncated too, and the persist
                // guard reads the marker off this array, so carry it in both modes or the
                // mirror takes a partial set below the stake-weighted flag day.
                if (snap.truncated === true) validators.truncated = true;
            }
        }
        return validators;
    },

    // item 3521 - the pair set the per-pair drop markers are written over. It must
    // track the ADMISSION set (OracleRound.canonicalPairs = the 36 API pairs plus
    // DERIVED_PAIRS), not getCoinPairs() alone, or the one pair produced by derivation
    // rather than fetch is the sole pair that can vanish with no durable trace: no
    // status='skipped' row, nothing in getSubmissionsInfo().droppedPairs, and the
    // stale prior snapshot still reading alive. DERIVED_PAIRS joins only when the
    // XCHAIN activation gate is open FOR THIS ROUND, since below the gate the pair was
    // never due and a skip row would be noise. The gate is round-keyed, not
    // currentRound-keyed: the stored round may already be behind. Fails closed the same
    // way the composition gate does, so an unreachable OracleRound narrows the marker
    // set back to the fetched pairs rather than inventing a row.
    markerPairs(round) {
        let pairs = PriceFetcher.getCoinPairs();
        try {
            if (this.oracleRound && typeof this.oracleRound.xchainPriceGateOpenFor === 'function'
                && this.oracleRound.xchainPriceGateOpenFor(round))
                return [...pairs, ...DERIVED_PAIRS];
        } catch (e) { /* fail closed to the fetched pairs */ }
        return pairs;
    },

    // reason: short string describing why the round was skipped ('no submissions',
    // 'below minimum submissions threshold', etc.); surfaced in the skip log so
    // operators can tell a full outage apart from a quorum shortfall.
    async storeSkippedRound(round, btcBlockHeight, btcBlockTime, reason) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        let coinPairs = this.markerPairs(round);
        // One multi-row INSERT so the skipped round lands atomically (same torn-read
        // rationale as _storeSnapshot).
        if (coinPairs.length) {
            await this.db.setSkippedPriceSnapshotRound(round, coinPairs, referenceBlock, blockTimestamp);
        }
        // Broadcast the skipped-round rows to hub-DB mirror subscribers, mirroring
        // _storeSnapshot. Both insert paths into the mirrored price_snapshots table must
        // feed HubDbBroadcaster or a live streaming mirror never receives the skipped
        // rows (it gets them only on the next re-bootstrap), diverging from a
        // freshly-bootstrapped mirror. Best-effort; never block finalize.
        if (coinPairs.length && this.hub && this.hub.hubDbBroadcaster) {
            try {
                let rows = await this.db.findPriceSnapshotsForRound(round);
                for (let row of rows) this.hub.hubDbBroadcaster.broadcastRow({ table: 'price_snapshots', row });
            } catch (e) { /* broadcast is best-effort */ }
        }
        // #7: mark as LOCALLY skipped, not finalized, so a legitimate later PROPOSE
        // from the federation still processes and can upgrade the 'skipped' rows to
        // 'finalized'. markFinalized would have frozen this round's NULL price here.
        this.markLocallySkipped(round);
        this.clearRoundTracking(round);
        logger.info('Oracle: Round ' + round + ' skipped (' + (reason || 'no submissions') + ')');
    }
};
