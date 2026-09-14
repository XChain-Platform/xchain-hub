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
 * XChain Hub - Oracle Publisher: the durable round buffer
 *
 * Where a finalized round waits between finalization and the window close that
 * turns it into one signed batch, and the two ways rounds leave it: an observed
 * on-chain batch, and the unconditional bound.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ================= PRICE batch rail (spec section 7) =================
    //
    // Ordering of the parts below: the buffer file, the window scheduler, window
    // assembly (leader election, self-check, splitting), wire construction, and the
    // marker-clearing seam the ingest side calls on a retraction.

    // ----- The durable round buffer -----

    // Normalize a round:finalized event into the ONE shape the canonical builder and
    // the signing round both take, so nothing downstream has to re-map it. Pair names
    // are read `coinPair || pair` and prices stringified exactly as the v0 producer
    // does, which is what keeps a v2 round object byte-identical to v0's own.
    //
    // The round's admission map rides the event as `admitBlocks` and is carried into the
    // entry only when present: it is part of the signed batch bytes for an admission-era
    // round, and absent is the legacy round, which is every round below the activation.
    bufferEntryFromEvent(event) {
        let entry = {
            round:          parseInt(event.round),
            timestamp:      parseInt(event.btcBlockTime),
            btcBlockHeight: parseInt(event.btcBlockHeight),
            pairs:          (event.prices || []).map(p => ({
                pair:  p.coinPair || p.pair,
                price: String(p.price)
            }))
        };
        if (event.admitBlocks !== null && event.admitBlocks !== undefined) entry.admitBlocks = event.admitBlocks;
        return entry;
    },

    // Append one finalized round to the durable buffer, same open('a') + fsync
    // discipline the publish queue and the dead-letter file use. A write failure is
    // FATAL to the caller for the same reason _enqueue's is: an unwritable buffer
    // means this hub silently loses an hour of price data it is the only holder of.
    async bufferFinalizedRound(event) {
        let entry = this.bufferEntryFromEvent(event);
        if (!Number.isFinite(entry.round)) return;

        // A re-finalization must land here whenever it CHANGED the round.
        // _storeSnapshot's ON DUPLICATE KEY UPDATE is last-write-wins, so a round that
        // finalizes twice leaves price_snapshots holding the second version. A
        // first-write-wins buffer would put the two stores permanently out
        // of step: the batch rail proposes from the BUFFER and every co-signer
        // re-derives from price_snapshots, so one diverged round makes the whole window
        // unsignable forever. Observed on testnet round 107, where the buffer held
        // timestamp 1787939400 with one price set and every hub's DB held 1787940000
        // with another, and window [102,107] was refused by three peers on every
        // re-proposal. An IDENTICAL re-finalization stays a no-op, so the common
        // replay/retry case still costs no disk.
        let prior = this._buffer.get(entry.round);
        if (prior && this.sameBufferedRound(prior, entry)) return;
        if (prior) {
            logger.warn('OraclePublisher: round ' + entry.round + ' re-finalized with different ' +
                'content; replacing the buffered copy so the batch rail proposes what ' +
                'price_snapshots actually holds');
        }
        entry.bufferedAt = Date.now();
        let line = JSON.stringify(entry) + '\n';
        try {
            this.appendDurableLine(this.bufferPath, line);
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: failed to buffer round %s for batching:', entry.round, e));
            throw e;
        }
        this._buffer.set(entry.round, entry);
        // The append above is the durable write (a crash between it and here recovers
        // the new copy, because hydrateBuffer replays the file in order and the LAST
        // line for a round wins). Compact only after that, so the truncating rewrite is
        // never the thing standing between a finalized round and disk.
        if (prior) this.rewriteBufferFile(this.bufferedRange(-Infinity, Infinity));
        this.enforceBufferBound();
    },

    // Do two buffer entries carry the same signable content? Compares exactly the
    // fields _buildPriceBatchPayload reads, pair order included only through a sorted
    // key, since the builder normalizes ordering itself. bufferedAt is metadata and is
    // deliberately excluded: re-stamping it would rewrite the file on every replay.
    sameBufferedRound(a, b) {
        if (parseInt(a.round) !== parseInt(b.round)) return false;
        if (parseInt(a.timestamp) !== parseInt(b.timestamp)) return false;
        if (parseInt(a.btcBlockHeight) !== parseInt(b.btcBlockHeight)) return false;
        return this.pairKey(a.pairs) === this.pairKey(b.pairs);
    },

    pairKey(pairs) {
        return (pairs || [])
            .map(p => String(p.coinPair || p.pair) + '=' + String(p.price))
            .sort()
            .join('|');
    },

    readBufferFile() {
        let raw = this.readDurableFile(this.bufferPath);
        if (raw === null) return [];
        return raw.split('\n').filter(l => l.trim().length > 0).map(l => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(e => e !== null && Number.isFinite(Number(e.round)));
    },

    // Truncating rewrite, used only by the two pruning paths. Returns false on a write
    // failure; the in-memory Map is the authority for this process either way, so a
    // failed prune costs disk, never correctness.
    rewriteBufferFile(entries) {
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            this.rewriteDurableFile(this.bufferPath, lines);
            return true;
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: failed to rewrite the v2 round buffer at ' +
                this.bufferPath + ':', e));
            return false;
        }
    },

    // Replays the file in order and lets the LAST line for a round win. That is load
    // bearing, not incidental: bufferFinalizedRound appends a replacement line when a
    // round re-finalizes with different content, and a first-wins reload would restore
    // the stale copy the batch rail can no longer get co-signed.
    hydrateBuffer() {
        this._buffer = new Map();
        for (let e of this.readBufferFile()) {
            let r = parseInt(e.round);
            if (!Number.isFinite(r)) continue;
            this._buffer.set(r, e);
        }
        if (this._buffer.size > 0) {
            logger.info('OraclePublisher: reloaded ' + this._buffer.size +
                ' buffered oracle round(s) from ' + this.bufferPath);
        }
        this.enforceBufferBound();
    },

    // The unconditional bound (D29's second half). Non-leaders normally shed a window
    // when they see its batch land, but a hub that never sees one (dark leader, chain
    // behind, a window nobody led) must still not accumulate forever. Oldest rounds go
    // first: a round old enough to fall off this end is far past any window a later
    // leader would still re-propose.
    enforceBufferBound() {
        if (this._buffer.size <= this.batchBufferMaxRounds) return;
        let ordered = Array.from(this._buffer.keys()).sort((a, b) => a - b);
        let drop    = ordered.slice(0, this._buffer.size - this.batchBufferMaxRounds);
        for (let r of drop) this._buffer.delete(r);
        logger.warn('OraclePublisher: v2 round buffer hit ORACLE_BATCH_BUFFER_MAX_ROUNDS (' +
            this.batchBufferMaxRounds + '); dropped ' + drop.length + ' round(s) up to ' +
            drop[drop.length - 1] + ' without publishing them');
        this.rewriteBufferFile(this.bufferedRange(-Infinity, Infinity));
    },

    // Buffered rounds inside a closed round range, ascending.
    bufferedRange(first, last) {
        let out = [];
        for (let [r, e] of this._buffer) {
            if (r >= first && r <= last) out.push(e);
        }
        return out.sort((a, b) => parseInt(a.round) - parseInt(b.round));
    },

    // The [first_round, last_round] a batch-sourced consensus_proof claims, or null
    // when the value is not one (a v0 proof is a bare signature ARRAY) or is malformed.
    // Only ever applied to shed BUFFERED rounds, so a wrong answer costs a re-proposal or
    // a stale buffer entry, never a wire; parse defensively and fall back to nothing.
    batchProofRange(proofJson) {
        if (typeof proofJson !== 'string') return null;
        let parsed;
        try { parsed = JSON.parse(proofJson); } catch (e) { return null; }
        let b = parsed && parsed.batch;
        if (!b) return null;
        let first = parseInt(b.first_round);
        let last  = parseInt(b.last_round);
        if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
        return { first, last };
    },

    // D29's first half: shed the rounds of a window whose batch this hub can already
    // see in its OWN price_snapshots. Batch-sourced rows are the ones whose
    // consensus_proof is the {"batch":...} object of D23; a v0-sourced row's proof is
    // a bare signature array, so the prefix discriminates exactly (the same test
    // PriceAggregator's retraction path uses). Best-effort: a DB error just leaves the
    // rounds buffered until the bound above collects them.
    async pruneObservedWindow(first, last) {
        if (!this.db) return 0;
        let rows;
        try {
            rows = await this.db.findPriceSnapshotsByRoundNumberAndConsensusProof(first, last);
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: cannot check for an on-chain batch covering rounds ' +
                first + '..' + last + '; leaving them buffered: ', e && e.message));
            return 0;
        }
        // Prune the whole range each observed batch CLAIMS, not just the rows that
        // carry its proof. receiveBatch dedupes per round: a round already
        // finalized from the v0 rail is counted a duplicate and keeps its v0 proof, so
        // a landed six-round batch typically stamps only the one round this hub was
        // missing. Keying the prune on the stamped rows alone therefore left five of
        // six rounds buffered after a window had demonstrably published, and every
        // later leader re-proposed that published window forever. The proof's own
        // header names the range it covers, so use it.
        let pruned = 0;
        for (let row of (rows || [])) {
            let r = parseInt(row.round_number);
            if (Number.isFinite(r) && this._buffer.delete(r)) pruned++;
            let covered = this.batchProofRange(row.consensus_proof);
            if (!covered) continue;
            for (let n of Array.from(this._buffer.keys())) {
                if (n >= covered.first && n <= covered.last && this._buffer.delete(n)) pruned++;
            }
        }
        if (pruned > 0) {
            this.rewriteBufferFile(this.bufferedRange(-Infinity, Infinity));
            logger.info('OraclePublisher: pruned ' + pruned + ' buffered round(s) in ' + first +
                '..' + last + ' after observing their batch on-chain');
        }
        return pruned;
    },

};
