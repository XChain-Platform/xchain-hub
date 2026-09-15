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
 * XChain Hub - PRICE batch-signing round: the follower side
 *
 * Co-signing only what this hub can reproduce byte for byte from its OWN
 * finalized price_snapshots. Every refusal is silent (logged locally, nothing
 * sent), because a NACK is an unauthenticated claim about someone else's state
 * and acting on one would hand a Byzantine peer a veto.
 *
 ********************************************************************/

'use strict';

const { PRICE_BATCH_MAX_ROUND_COUNT } = require('../../price_batch_compression.js');

module.exports = {

    // Follower: co-sign a proposed batch ONLY when this hub reproduces its canonical
    // bytes byte-for-byte from its OWN finalized price_snapshots. Every refusal is
    // SILENT (logged locally, nothing sent), because the only honest answer to "I
    // cannot reproduce that" is to withhold a signature.
    async handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !this.peerManager || !this.db) return;

        let sender = String(envelope.sig_pubkey || '').toLowerCase();
        if(sender && sender === this.identity.getPubkeyHex().toLowerCase()) return;   // own broadcast echo

        let first = parseInt(d.first_round);
        let last  = parseInt(d.last_round);
        if(!Number.isFinite(first) || !Number.isFinite(last) || first < 0 || last < first) return;
        // Bound the proposed window BEFORE any DB work: first/last are attacker-chosen,
        // and an unbounded range is a query-cost amplifier on every price validator.
        if((last - first + 1) > PRICE_BATCH_MAX_ROUND_COUNT) return;
        if(!Array.isArray(d.rounds) || d.rounds.length === 0 || d.rounds.length > PRICE_BATCH_MAX_ROUND_COUNT) return;

        let mine;
        try {
            mine = await this.deriveWindow(first, last);
        } catch(e){
            this.refuse(first, last, 'local price_snapshots unreadable (' + (e && e.message) + ')');
            return;
        }
        // No finalized round of our own in the window: we have nothing to attest with.
        // This is the honest "the whole window is skipped here" case as well.
        if(mine.length === 0){ this.refuse(first, last, 'no finalized rounds in the window locally'); return; }

        let myAnchor = this.signableBatchAnchor(first, last, mine);
        if(myAnchor === null) return;

        // Only co-sign if WE hold `price` at the batch anchor: otherwise the indexer
        // drops this signature from the tally and it is dead weight on the wire.
        let signingSet;
        try {
            signingSet = await this.resolvePriceSet(myAnchor);
        } catch(e){
            this.refuse(first, last, 'price capability set unresolvable at anchor ' + myAnchor);
            return;
        }
        let me = this.identity.getPubkeyHex().toLowerCase();
        if(!signingSet.some(v => v.pubkey === me)){
            this.refuse(first, last, 'this hub does not hold `price` at anchor ' + myAnchor);
            return;
        }

        this.signIfReproduced(d, first, last, mine, myAnchor, me);
    },

    // The anchor this window would be signed under, or null when it is not signable
    // content at all.
    //
    // A round this hub ingested from a batch that ALREADY LANDED cannot be
    // re-derived here. PriceAggregator.receiveBatch pins
    // price_snapshots.reference_block to the LANDING chain's block_index (spec
    // §5.7 / D8), not to the round's own BTC anchor, so the row simply no longer
    // carries the height the canonical needs; on testnet round 116 was stored at
    // DOGE height 67856096 where its BTC anchor was 150176. Comparing that as if
    // it were a BTC anchor produced a bare "does not match" refusal on every
    // re-proposal of window [114,119] - a window that had in fact already
    // published. Say so instead: an already-landed round is not signable content.
    signableBatchAnchor(first, last, mine){
        let landed = mine.filter(r => r.batchSourced).map(r => r.round);
        if(landed.length){
            this.refuse(first, last, 'round(s) ' + landed.join(',') + ' here came from a batch that ' +
                'already landed on chain, so their own BTC anchor is no longer recoverable from ' +
                'price_snapshots (reference_block holds the landing block); this window has ' +
                'already published and there is nothing left to co-sign');
            return null;
        }

        // The batch anchor is the LAST included round's own anchor (spec section 4).
        // Deriving it rather than trusting d.btc_block_height is what keeps a lying
        // header from steering which capability set and which flag-day verdict this
        // signature is judged under; a mismatch also fails the byte comparison below.
        let myAnchor    = parseInt(mine[mine.length - 1].btcBlockHeight);
        let firstAnchor = parseInt(mine[0].btcBlockHeight);

        // A window straddling an armed oracle flag day is INVALID on the chain
        // (spec section 5.4): a batch resolves the sig-tally and stake-weighted gates
        // ONCE on the batch anchor, so signing a straddling window would judge its
        // earlier rounds under a rule set they never finalized under.
        if(this.straddlesArmedOracleFlagDay(firstAnchor, myAnchor)){
            this.refuse(first, last, 'window straddles an armed oracle flag day (anchors ' +
                         firstAnchor + '..' + myAnchor + ')');
            return null;
        }
        return myAnchor;
    },

    // THE SAFETY PROPERTY. `theirs` is built from the proposal exactly as sent;
    // `ours` from our own rows. Equality of the two canonical STRINGS is the only
    // thing that unlocks a signature, so a fabricated price, a dropped round, an
    // injected round, a shifted timestamp or a re-pointed anchor all land here as
    // an ordinary string inequality. Both go through the ONE canonical builder
    // (OracleConsensus.buildPriceBatchPayload), so there is no second spelling of
    // the format for the two sides to disagree about.
    signIfReproduced(d, first, last, mine, myAnchor, me){
        let ours, theirs;
        try {
            ours   = this._canonical(first, last, myAnchor, mine);
            theirs = this._canonical(d.first_round, d.last_round, d.btc_block_height, d.rounds);
        } catch(e){
            this.refuse(first, last, 'canonical build failed (' + (e && e.message) + ')');
            return;
        }
        if(ours !== theirs){
            // Name WHAT diverged. The bare form of this line was the whole
            // diagnostic an operator got for a window that never published, and it
            // cannot be reproduced after the fact: the leader's proposal is not
            // persisted anywhere. One bounded clause naming the first differing round
            // and field is the difference between "the federation disagrees" and a
            // fix. Never dump the pair lists themselves - a 37-pair round would put
            // kilobytes per refusal into the log.
            this.refuse(first, last, 'proposal does not match this hub\'s own finalized rounds (' +
                         this.describeMismatch(d, mine, myAnchor) + ')');
            return;
        }

        this.stats.batchSignaturesProvided++;
        // Note the co-signature BEFORE it goes out: from here on the leader can
        // broadcast at any moment, and a takeover armed against this window must
        // treat "not on chain" as ambiguous rather than as leader silence.
        this.noteCoSigned(first, last);
        this.peerManager.broadcast(this.constructor.XPRICEB_SIGN, {
            first_round: first,
            last_round:  last,
            pubkey:      me,
            sig:         this.identity.sign(ours)
        });
    },

    // One bounded clause naming the FIRST real difference between a proposal and this
    // hub's own rows. Diagnostic only: the refusal is already decided by the canonical
    // byte comparison, and nothing here may change that verdict.
    //
    // Deliberately shallow. It reports the first differing round and the first
    // differing field within it, never a full diff, so a hub refusing an entire window
    // every ten minutes cannot flood its own log.
    describeMismatch(proposal, mine, myAnchor){
        let parts = [];
        let theirAnchor = parseInt(proposal.btc_block_height);
        if(Number.isFinite(theirAnchor) && theirAnchor !== myAnchor)
            parts.push('batch anchor proposed ' + theirAnchor + ', derived ' + myAnchor);

        let theirRounds = Array.isArray(proposal.rounds) ? proposal.rounds : [];
        let theirByRound = new Map();
        for(let r of theirRounds){
            let n = parseInt(r && r.round);
            if(Number.isFinite(n)) theirByRound.set(n, r);
        }
        let mineByRound = new Map(mine.map(r => [r.round, r]));

        let onlyProposed = Array.from(theirByRound.keys()).filter(n => !mineByRound.has(n)).sort((a,b) => a-b);
        let onlyMine     = Array.from(mineByRound.keys()).filter(n => !theirByRound.has(n)).sort((a,b) => a-b);
        if(onlyProposed.length) parts.push('round(s) ' + onlyProposed.join(',') + ' proposed but not finalized here');
        if(onlyMine.length)     parts.push('round(s) ' + onlyMine.join(',') + ' finalized here but not proposed');

        for(let n of Array.from(mineByRound.keys()).sort((a,b) => a-b)){
            let t = theirByRound.get(n);
            if(!t) continue;
            let m    = mineByRound.get(n);
            let diff = this.firstRoundFieldDiff(n, t, m);
            if(diff){ parts.push(diff); break; }
        }
        return parts.length ? parts.join('; ') : 'no field-level difference found, so the two sides ' +
               'disagree on the canonical ENCODING rather than its content';
    },

    // The first differing field of one round, or null when the two agree. Pair sets
    // are compared by name and price; only the first offending pair is named.
    firstRoundFieldDiff(round, theirs, mine){
        let at = 'round ' + round + ' ';
        if(parseInt(theirs.btcBlockHeight != null ? theirs.btcBlockHeight : theirs.btc_block_height) !== mine.btcBlockHeight)
            return at + 'anchor proposed ' +
                   parseInt(theirs.btcBlockHeight != null ? theirs.btcBlockHeight : theirs.btc_block_height) +
                   ', derived ' + mine.btcBlockHeight;
        if(parseInt(theirs.timestamp) !== mine.timestamp)
            return at + 'timestamp proposed ' + parseInt(theirs.timestamp) + ', derived ' + mine.timestamp;
        // The admission map, spelled through the encoder so the comparison is over the
        // bytes that would be signed; an unspellable proposed map is named as such rather
        // than thrown on, because this helper only ever explains a refusal.
        let spell = (m) => { if(m === null || m === undefined) return '(none)';
                             try { return this.admission.encodeAdmitBlocks(m); } catch(e){ return '(unspellable)'; } };
        let theirAdmit = spell(theirs.admitBlocks != null ? theirs.admitBlocks : theirs.admit_blocks);
        let mineAdmit  = spell(mine.admitBlocks);
        if(theirAdmit !== mineAdmit)
            return at + 'admission map proposed ' + theirAdmit + ', derived ' + mineAdmit;

        let theirPairs = new Map((Array.isArray(theirs.pairs) ? theirs.pairs : [])
            .map(p => [String(p.coinPair || p.pair), String(p.price)]));
        let minePairs  = new Map(mine.pairs.map(p => [String(p.pair), String(p.price)]));
        for(let [name, price] of theirPairs){
            if(!minePairs.has(name)) return at + 'pair ' + name + ' proposed but not finalized here';
            if(minePairs.get(name) !== price)
                return at + 'pair ' + name + ' price proposed ' + price + ', derived ' + minePairs.get(name);
        }
        for(let name of minePairs.keys())
            if(!theirPairs.has(name)) return at + 'pair ' + name + ' finalized here but not proposed';
        return null;
    },

    // Rebuild the canonical builder's `rounds` input from THIS hub's own finalized
    // price_snapshots, ascending.
    //
    // status = 'finalized' rather than "not skipped" is the deliberate reading of
    // spec section 6's "non-skipped row": the third enum value, 'disputed', marks a
    // row a reorg RETRACTED (ReorgHandler.js:628), and retracted content must never
    // be signed into a batch. The same filter also drops the per-pair 'skipped'
    // markers storeSnapshot writes for pairs absent from an otherwise-finalized
    // round, which is what keeps a round's pair list identical to the one the v0
    // canonical for that round carried.
    // proof_head is the first characters of consensus_proof, which is the ONE field
    // that tells a batch-sourced row from a locally-finalized one: a v0 row's proof is
    // a bare signature ARRAY, a batch-sourced row's is the {"batch":...} object of D23
    // (the same prefix test OraclePublisher.pruneObservedWindow and
    // PriceAggregator.retractFromActionIndex use). It matters here because a
    // batch-sourced row's reference_block is the LANDING chain's height, not the
    // round's BTC anchor, so reading it as an anchor invents a number.
    async deriveWindow(firstRound, lastRound){
        let rows = await this.db.findPriceSnapshotsByRoundNumber(firstRound, lastRound, 'finalized');

        let byRound = new Map();
        for(let r of (rows || [])){
            let key = parseInt(r.round_number);
            if(!Number.isFinite(key)) continue;
            // The round's admission map, read back from the columns the finalizing hub
            // stored it in; null is a legacy round. Part of the signed batch bytes, so it is
            // rebuilt from THIS hub's rows exactly as the header fields are and never taken
            // from the proposal.
            let admit = this.admission.columnsAdmitBlocks(r);
            let entry = byRound.get(key);
            if(!entry){
                entry = { round: key, timestamp: parseInt(r.block_timestamp),
                          btcBlockHeight: parseInt(r.reference_block), pairs: [],
                          batchSourced: String(r.proof_head || '').indexOf('{"batch"') === 0 };
                if(admit !== null) entry.admitBlocks = admit;
                byRound.set(key, entry);
            } else if(parseInt(r.block_timestamp) !== entry.timestamp ||
                      parseInt(r.reference_block) !== entry.btcBlockHeight ||
                      (admit === null) !== (entry.admitBlocks === undefined) ||
                      (admit !== null && this.admission.encodeAdmitBlocks(admit) !== this.admission.encodeAdmitBlocks(entry.admitBlocks))){
                // One round's rows are written by a single multi-row INSERT, so a
                // per-pair disagreement means local corruption. Fail the whole window
                // closed rather than pick a winner and sign an invented round header.
                throw new Error('inconsistent anchor/timestamp/admission map across round ' + key);
            }
            entry.pairs.push({ pair: String(r.coin_pair), price: String(r.price) });
        }
        return Array.from(byRound.values()).sort((a, b) => a.round - b.round);
    },

};
