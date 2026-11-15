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
const { splitJsonLines } = require('../../lib/fs/durable_file.js');
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
    // FATAL to the caller for the same reason enqueue's is: an unwritable buffer
    // means this hub silently loses an hour of price data it is the only holder of.
    async bufferFinalizedRound(event) {
        let entry = this.bufferEntryFromEvent(event);
        if (!Number.isFinite(entry.round)) return;

        // A re-finalization must land here whenever it CHANGED the round.
        // storeSnapshot's ON DUPLICATE KEY UPDATE is last-write-wins, so a round that
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
    // fields buildPriceBatchPayload reads, pair order included only through a sorted
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

    // The buffer file split into usable round entries and the raw lines that are not
    // (a torn append, a hand edit), plus whether the last line lacks its newline, which
    // would let the next append glue onto it. Null when the file could not be read.
    readBufferFile() {
        let raw;
        try {
            raw = this.readDurableFileStrict(this.bufferPath);
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: failed to read the v2 round buffer at ' +
                this.bufferPath + ':', e));
            return null;
        }
        if (raw === null) return { entries: [], rejected: [], unterminated: false };
        let split = splitJsonLines(raw, e => Number.isFinite(Number(e.round)));
        split.unterminated = raw.length > 0 && !raw.endsWith('\n');
        return split;
    },

    // Copy the buffer lines that are not usable rounds into the dead-letter file before
    // a rewrite drops them. Returns the lines that could not be copied, which every
    // rewrite keeps verbatim, so none leaves the disk unrecorded.
    quarantineBufferLines(lines) {
        if (!lines || lines.length === 0) return [];
        let kept = lines.filter(raw => !this.quarantineQueueLine(raw, 'unparseable round buffer line'));
        this.corruptBufferLines = (this.corruptBufferLines || 0) + lines.length;
        logger.error('OraclePublisher: ' + lines.length + ' unparseable line(s) in the v2 round buffer at ' +
            this.bufferPath + '; moved ' + (lines.length - kept.length) + ' to ' + this.deadLetterPath +
            ' and kept ' + kept.length + ' in the buffer. Operator: inspect them for a round to restore.');
        return kept;
    },

    // Atomic rewrite (rewriteDurableFile), used by the pruning paths. An unread
    // startup buffer is latched so no later compaction can replace data that was
    // never loaded into memory.
    rewriteBufferFile(entries) {
        if (this._bufferUnread) {
            logger.error('OraclePublisher: skipped rewrite of unread v2 round buffer at ' +
                this.bufferPath + '; restart after the read fault is fixed');
            return false;
        }
        let all   = entries.map(e => JSON.stringify(e)).concat(this._bufferKeptRaw || []);
        let lines = all.join('\n') + (all.length > 0 ? '\n' : '');
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
        let state = this.readBufferFile();
        this._bufferUnread = state === null;
        if (this._bufferUnread) {
            logger.error('OraclePublisher: rewrites are suspended because the v2 round buffer at ' +
                this.bufferPath + ' could not be read; fix the fault and restart to recover its rounds');
            return;
        }
        for (let e of state.entries) {
            let r = parseInt(e.round);
            if (!Number.isFinite(r)) continue;
            this._buffer.set(r, e);
        }
        // The quarantine copy is fsync'd before any rewrite can drop the lines. A torn
        // tail is rewritten away at once, so the next append cannot glue a good round onto it.
        this._bufferKeptRaw = this.quarantineBufferLines(state.rejected);
        if (state.rejected.length > 0 || state.unterminated) {
            this.rewriteBufferFile(this.bufferedRange(-Infinity, Infinity));
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
