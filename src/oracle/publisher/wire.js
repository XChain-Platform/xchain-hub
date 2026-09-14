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
 * XChain Hub - Oracle Publisher: the PRICE batch wire: packing, signing and emission
 *
 * The bytes a window becomes. Packing measures an estimated wire, the signing round
 * measures the real one, and emission picks whichever form is smaller. The ceiling
 * is two bounds, and missing the second one spends a fee on a body no reader will
 * finish inflating.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { compressPriceBatchBody, PRICE_BATCH_COMPRESSION_MARKER,
        PRICE_BATCH_MAX_ROUND_COUNT } = require('../../price_batch_compression.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // How many signatures to SIZE against before the signing round has produced any.
    // The price-capable set at the anchor is the upper bound on what can come back, so
    // packing against it never under-splits; the post-signing measurement in
    // signAndSizeRange is the authority either way.
    async _priceSetSizeHint(anchor, fallback) {
        try {
            if (this.hub && this.hub.capabilitySnapshot) {
                let snap = await this.hub.capabilitySnapshot.getSnapshot('price', anchor);
                if (snap && Array.isArray(snap.validators) && snap.validators.length > 0) {
                    return snap.validators.length;
                }
            }
        } catch (e) { /* the hint is advisory; fall through to the publisher set size */ }
        return Math.max(1, fallback || 1);
    },

    // Signature-shaped filler for pre-signing size estimates. Byte-exact in length for
    // the uncompressed form (64-hex pubkey, 128-hex signature), and high-entropy so the
    // COMPRESSED estimate is not flattered: repeating one placeholder would deflate to
    // almost nothing and the packer would then over-fill every wire.
    _placeholderSigs(count) {
        let out = [];
        for (let i = 0; i < count; i++) {
            let a = crypto.createHash('sha256').update('xpriceb-size-pubkey-' + i).digest('hex');
            let b = crypto.createHash('sha256').update('xpriceb-size-sig-a-' + i).digest('hex') +
                    crypto.createHash('sha256').update('xpriceb-size-sig-b-' + i).digest('hex');
            out.push({ pubkey: a, sig: b });
        }
        return out;
    },

    // Largest leading run of `rounds` whose estimated wire fits the ceiling. Returns 0
    // when even the first round overflows; the caller still proposes that single round,
    // so the loud-ceiling path measures a REAL wire rather than an estimate.
    _packSegment(rounds, sigCount) {
        let sigs = this._placeholderSigs(sigCount);
        let n    = Math.min(rounds.length, PRICE_BATCH_MAX_ROUND_COUNT);
        while (n >= 1) {
            let sub = rounds.slice(0, n);
            let emitted = this._emitWire(sub[0].round, sub[n - 1].round,
                sub[n - 1].btcBlockHeight, sub, sigs);
            if (this._wireFits(emitted)) return n;
            n--;
        }
        return 0;
    },

    // Run the signing round for a range, then measure the wire the signatures actually
    // produced. Shrinks and re-signs while the real wire overflows, because the sig set
    // is only known after quorum and a bigger-than-estimated set can push a range over.
    //
    // Returns { wire, bytes, rounds, ... } on success, a { unpublishable: true } record
    // when a single round cannot fit at all, or null when quorum was not reached.
    async signAndSizeRange(signer, range) {
        let candidate = range;
        while (candidate.length >= 1) {
            let first  = parseInt(candidate[0].round);
            let last   = parseInt(candidate[candidate.length - 1].round);
            let anchor = parseInt(candidate[candidate.length - 1].btcBlockHeight);

            let result;
            try {
                result = await signer.collectBatchSignatures(first, last, anchor, candidate);
            } catch (e) {
                logger.error(nodeUtil.format('OraclePublisher: batch-signing round for [' + first + ',' + last +
                    '] threw; window stays unpublished: ', e));
                return null;
            }
            // met:false means quorum was not reached. Those signatures are observability
            // only; publishing them would put a wire on chain that no indexer accepts and
            // spend a DOGE fee for it.
            if (!result || result.met !== true || !Array.isArray(result.sigs) || result.sigs.length === 0) {
                logger.warn('OraclePublisher: no signing quorum for batch [' + first + ',' + last +
                    ']; window stays unpublished (a later leader re-proposes it)');
                return null;
            }

            let emitted = this._emitWire(first, last, anchor, candidate, result.sigs);
            if (this._wireFits(emitted)) {
                return {
                    wire:       emitted.wire,
                    bytes:      emitted.bytes,
                    compressed: emitted.compressed,
                    firstRound: first,
                    lastRound:  last,
                    anchor:     anchor,
                    sigCount:   result.sigs.length,
                    rounds:     candidate
                };
            }

            if (candidate.length === 1) {
                return this.deadLetterUnfittableRound(first, last, anchor, candidate, result.sigs, emitted);
            }
            candidate = candidate.slice(0, candidate.length - 1);
        }
        return null;
    },

    // THE CEILING. One round plus its signature set does not fit either wire
    // form, so no split can rescue it and the federation has outgrown the
    // 8,189-byte payload limit. v0 already counts oversized drops and
    // dead-letters them; what is new here is the CRITICAL-level line and a
    // batch-specific counter an operator can alert on.
    deadLetterUnfittableRound(first, last, anchor, candidate, sigs, emitted) {
        let max = this.constructor.PRICE_WIRE_MAX_BYTES;
        this.batchUnpublishableCount++;
        let bound = emitted.bytes > max
            ? 'the encoder payload limit (' + emitted.bytes + ' bytes on the wire, ' +
              (emitted.compressed ? 'compressed' : 'uncompressed') + ')'
            : 'the reader\'s inflated-body cap (' + emitted.bodyBytes + ' body bytes; ' +
              'the wire itself is only ' + emitted.bytes + ')';
        logger.error('OraclePublisher: CRITICAL - PRICE v0 round ' + first +
            ' alone does not fit with ' + sigs.length + ' signature(s): it breaches ' +
            bound + ', over the ' + max + '-byte limit. No split can fit ' +
            'it: this federation has outgrown the PRICE wire. The round is dead-lettered to ' +
            this.deadLetterPath + ' and NOTHING publishes for it.');
        this.deadLetter({
            round:          first,
            batchFirstRound: first,
            batchLastRound:  last,
            btcBlockHeight: anchor,
            rounds:         candidate,
            sigs:           sigs
        }, 'PRICE v0 single round exceeds encoder limit of ' + max +
           ' (wire ' + emitted.bytes + ' bytes, body ' + emitted.bodyBytes + ' bytes)');
        return { unpublishable: true, rounds: candidate };
    },

    // ----- The batch wire -----

    // Everything after `PRICE|0|` in the uncompressed form. Rounds are re-sorted and
    // pairs re-normalized here exactly as the canonical builder does, so the wire and
    // the signed canonical describe the same content in the same order.
    buildPriceBatchBody(firstRound, lastRound, btcBlockHeight, rounds, sigs) {
        let ordered = [...rounds].sort((a, b) => parseInt(a.round) - parseInt(b.round));
        // The batch header's BTC_BLOCK_HEIGHT must EQUAL the LAST included round's own
        // anchor: both verifiers now reject a mismatch, so a wire built from a freely
        // chosen anchor is a DOGE fee spent on an action the chain refuses. Derived
        // here rather than taken on trust, which is what makes a mismatched header
        // unrepresentable, and the caller's value is cross-checked so a split that
        // forgot to re-derive for its sub-range is LOUD instead of merely wrong.
        let derivedAnchor = parseInt(ordered[ordered.length - 1].btcBlockHeight);
        if (parseInt(btcBlockHeight) !== derivedAnchor) {
            throw new Error('OraclePublisher: PRICE batch anchor ' + parseInt(btcBlockHeight) +
                ' does not equal the last included round\'s anchor ' + derivedAnchor +
                '; both verifiers reject this wire. The anchor must be re-derived for every split.');
        }
        let parts = [String(parseInt(firstRound)), String(parseInt(lastRound)),
                     String(derivedAnchor), String(ordered.length)];
        for (let r of ordered) {
            let pairs = r.pairs.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }))
                .sort((a, b) => {
                    if (a.pair < b.pair) return -1;
                    if (a.pair > b.pair) return 1;
                    return 0;
                });
            parts.push(String(parseInt(r.round)));
            parts.push(String(parseInt(r.timestamp)));
            parts.push(String(parseInt(r.btcBlockHeight)));
            parts.push(String(pairs.length));
            for (let p of pairs) { parts.push(p.pair); parts.push(p.price); }
            // The round's ADMIT_BLOCKS slot, present exactly when the round's own anchor is
            // in the admission era and absent otherwise, which is the declared slot the
            // parser reads; the builder throws for a map in the wrong era, so no wire is
            // emitted that its verifiers would refuse.
            let admit = this.admission.admissionCanonicalValue('OraclePublisher', this.network, parseInt(r.btcBlockHeight),
                                                   r.admitBlocks === undefined ? null : r.admitBlocks);
            if (admit !== null) parts.push(admit);
        }
        parts.push(String(sigs.length));
        for (let s of sigs) { parts.push(s.pubkey); parts.push(s.sig); }
        return parts.join('|');
    },

    // Emit whichever form is smaller. A batch that deflates larger (short bodies, or
    // content deflate cannot exploit) simply rides uncompressed; both forms are equally
    // valid and the reader distinguishes them on the `Z` in the FIRST_ROUND slot.
    _emitWire(firstRound, lastRound, btcBlockHeight, rounds, sigs) {
        let body  = this.buildPriceBatchBody(firstRound, lastRound, btcBlockHeight, rounds, sigs);
        let plain = 'PRICE|0|' + body;
        let plainBytes = Buffer.byteLength(plain, 'utf8');
        let bodyBytes  = Buffer.byteLength(body, 'utf8');
        try {
            let packed      = 'PRICE|0|' + PRICE_BATCH_COMPRESSION_MARKER + '|' + compressPriceBatchBody(body);
            let packedBytes = Buffer.byteLength(packed, 'utf8');
            if (packedBytes < plainBytes) {
                return { wire: packed, bytes: packedBytes, compressed: true, bodyBytes: bodyBytes };
            }
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: deflate of the PRICE v0 body failed; ' +
                'emitting the uncompressed form: ', e && e.message));
        }
        return { wire: plain, bytes: plainBytes, compressed: false, bodyBytes: bodyBytes };
    },

    // TWO bounds, and missing the second one spends a DOGE fee on an action no reader
    // will accept. The encoder's payload limit binds the bytes actually broadcast, and
    // `price_batch_compression.js` binds the INFLATED body to the same number
    // (`outputCap = Math.min(PRICE_WIRE_MAX_BYTES, ratioCap)`), so a compressed wire
    // that comfortably fits the encoder can still carry a body every indexer refuses to
    // finish inflating. Compression therefore buys FEE, not round capacity: it relaxes
    // this predicate by the 8 bytes of the `PRICE|0|` prefix and nothing more.
    _wireFits(emitted) {
        let max = this.constructor.PRICE_WIRE_MAX_BYTES;
        return emitted.bytes <= max && emitted.bodyBytes <= max;
    },

};
