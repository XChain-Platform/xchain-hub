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
 * AttestationBatchPublisher: the BTC anchor and the signer set
 *
 * The height a batch quorum is judged at, the attestation capability set at that
 * height, its mirror into capability_snapshots, and the per-window publisher
 * election. Installed on AttestationBatchPublisher.prototype by
 * src/attestation/batch_publisher.js.
 *
 ********************************************************************/

'use strict';

const crypto    = require('crypto');
const swq       = require('../../stake_weighted_quorum.js');
const snapWrite = require('../../lib/capability_snapshot_write.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ------------------------------------------------------------ the anchor

    // The BTC height the batch quorum is judged at. Read from this hub's own view of
    // the Bitcoin tip and buried by nothing here: CapabilitySnapshot applies the reorg
    // buffer to every height it is handed, so burying twice would resolve a set from
    // twelve blocks back rather than six.
    //
    // A null answer records WHY in _anchorFailure. The commonest cause is a hub whose
    // Bitcoin indexer has never called `pushchaintip`, which is a one-line
    // configuration gap that otherwise presents as every window deferring forever with
    // nothing on chain and no coverage.
    // TWO SOURCES, PUSHED FIRST. A `chain_tips` row exists only on the hub a Bitcoin
    // indexer pushes to, and a federation that shares one indexer has exactly one such
    // hub; measured on testnet 2026-09-07, four of five validators deferred every
    // window and refused every co-sign for want of it, so no batch could reach its
    // quorum of five. Every attestation validator polls a Bitcoin indexer to find
    // requests, though, and that poll reports the tip, so the tip the round observed
    // is the fallback: the same height source the round's own leader ladder and
    // widening step already trust. The pushed row keeps precedence where it exists so
    // the one hub that has it behaves exactly as before.
    async resolveAnchor(){
        let db = this._db();
        if(!db){
            this._anchorFailure = 'this hub has no database handle';
            return null;
        }
        let tip = null, pushedFailure;
        try {
            if(typeof db.getChainTip !== 'function'){
                this._anchorFailure = 'the database layer exposes no getChainTip()';
                return null;
            }
            tip = await db.getChainTip('BTC', this.network);
        } catch(e){
            this._anchorFailure = 'reading the BTC chain tip failed (' + (e && e.message) + ')';
            return null;
        }
        let n = Number(tip && tip.blockHeight);
        if(Number.isFinite(n) && n > 0) return this.anchorResolved(Math.trunc(n), 'pushed');
        pushedFailure = tip
            ? 'the BTC chain_tips row holds no usable block_height (' + JSON.stringify(tip.blockHeight) + ')'
            : 'no BTC chain_tips row exists for network ' + (this.network || '<unset>') +
              '; the Bitcoin indexer has not called pushchaintip on this hub';

        let observed = this.observedBtcTip();
        let o = Number(observed && observed.blockHeight);
        if(Number.isFinite(o) && o > 0) return this.anchorResolved(Math.trunc(o), 'observed');

        this._anchorFailure = pushedFailure +
            ', and the attestation poll has not observed a BTC tip either';
        return null;
    },

    // The tip the attestation round's request poll last reported, or null on a hub
    // that runs no round (observer-only, or the round not yet started).
    observedBtcTip(){
        let round = this.hub && typeof this.hub.getAttestationRound === 'function'
            ? this.hub.getAttestationRound() : null;
        if(!round || typeof round.getObservedBtcTip !== 'function') return null;
        return round.getObservedBtcTip();
    },

    anchorResolved(height, source){
        // Both latches clear together: an outage that returns after the tip came back is
        // a NEW episode and has to say so, even when its cause reads the same.
        this._anchorFailure = null;
        this._anchorWarned  = null;
        // Say so once when the source changes: an operator reading "published" on a hub
        // with no chain_tips row should be able to see which height it anchored on.
        if(source !== this._anchorSource){
            this._anchorSource = source;
            logger.info('AttestationBatchPublisher: anchoring batches on the ' +
                (source === 'pushed' ? 'pushed BTC chain tip (chain_tips row)'
                                     : 'BTC tip observed by the attestation poll (no chain_tips row on this hub)'));
        }
        return height;
    },

    // One line per distinct cause, not one per window. The sweep runs every window, so
    // on a regtest cadence an unconditional warning is a line every few seconds for a
    // condition that cannot change without an operator; latching keeps the reason
    // visible without burying the log, and clearing it on a new cause lets a changed
    // failure speak.
    warnNoAnchor(windowStart){
        let why = this._anchorFailure || 'the BTC chain tip is unavailable';
        if(this._anchorWarned === why) return;
        this._anchorWarned = why;
        logger.warn('AttestationBatchPublisher: deferring window ' + windowStart +
            ' because the batch has no BTC anchor: ' + why + '. The anchor is the height ' +
            'the batch quorum is sized at, so no window can publish until it resolves and ' +
            'chain coverage is missing for every window deferred this way. Each deferred ' +
            'window keeps its rows and republishes byte-identical content once it does.');
    },

    // ------------------------------------------------------------ the signer set

    // The attestation-capable set at a BTC anchor, resolved exactly as the response
    // verifier resolves it: weight-keyed at and above the stake-weighted flag day,
    // count-keyed below, so leader, follower and the DOGE indexer size one quorum from
    // one source. Returns null when the snapshot cannot be resolved at all, which every
    // caller treats as "defer", never as "nobody is eligible".
    async resolveAttestationSet(anchor){
        let cs = this.hub && this.hub.capabilitySnapshot;
        if(!cs) return null;
        let weighted = swq.isStakeWeightedQuorumActive(anchor, this.network);
        let snap;
        try {
            snap = weighted ? await cs.getWeightSnapshot('attestation', anchor)
                            : await cs.getSnapshot('attestation', anchor);
        } catch(e){
            return null;
        }
        if(!snap || !Array.isArray(snap.validators) || snap.validators.length === 0) return null;
        // A truncated weight snapshot under-counts total stake, so the 2/3 bar could
        // pass a batch the full set would refuse. Same fail-closed reading the PRICE
        // rails carry.
        if(snap.truncated === true) return null;
        let set = snap.validators.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            weight: String((weighted ? v.weight : v.amount) != null ? (weighted ? v.weight : v.amount) : '0'),
            source: String(v.source != null ? v.source : '')
        }));
        set.weighted = weighted;
        set.count = Number.isFinite(parseInt(snap.count)) ? parseInt(snap.count) : set.length;
        return set;
    },

    // Mirror the attestation capability set at `anchor` into capability_snapshots, the
    // table an off-BTC verifier reads. The DOGE indexer judges a v5 head by
    // `getStakeWeightsByCapability('attestation', anchor)`, which on a chain with no
    // local stakes is `capability_snapshots WHERE capability='attestation' AND
    // snapshot_block = anchor`, mirrored from the hub it follows; with nobody writing
    // those rows every v5 head on DOGE read `invalid: insufficient signer stake`
    // (regtest ladder, AT5, 2026-09-05). Same contract as the PRICE batch
    // (OracleConsensus.persistCapabilitySnapshot): every signing hub writes, not just
    // the leader; the natural-key INSERT IGNORE makes the rows identical and a re-write
    // free; a TRUNCATED set is never mirrored (SWQ-TRUNC-MIRROR). Once per anchor per
    // process, because the same anchor recurs every window while the tip sits still.
    async persistAttestationSnapshot(anchor, set){
        let a = Number(anchor);
        if(!Number.isInteger(a) || a <= 0) return 0;
        if(!this._persistedAnchors) this._persistedAnchors = new Set();
        if(this._persistedAnchors.has(a)) return 0;
        if(!set) set = await this.resolveAttestationSet(a);
        if(!set || set.length === 0) return 0;          // unresolved / truncated: nothing to mirror
        let db = this._db();
        if(!db) return 0;
        let rows;
        try {
            rows = await snapWrite.writeCapabilitySnapshotRows(db, 'attestation', a, set);
        } catch(e){
            logger.warn('AttestationBatchPublisher: could not mirror the attestation capability snapshot at anchor ' +
                         a + ': ' + (e && e.message));
            return 0;
        }
        this._persistedAnchors.add(a);
        if(this._persistedAnchors.size > 256){
            let oldest = this._persistedAnchors.values().next().value;
            this._persistedAnchors.delete(oldest);
        }
        if(this.hub && this.hub.hubDbBroadcaster){
            for(let row of rows){
                let r = await db.getCapabilitySnapshot(a, 'attestation', row.signing_pubkey, row.source);
                if(r.length) this.hub.hubDbBroadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return rows.length;
    },

    // This hub's rank in the publisher election for one batch, or null when the set
    // cannot be resolved. Hash order over sha256(batchKey || pubkey), the ANCHOR
    // publisher election's rule: deterministic, unpredictable per window, and it needs
    // no coordination at all.
    async electionRank(anchor, batchKey){
        let set = await this.resolveAttestationSet(anchor);
        if(!set) return null;
        let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if(!me) return null;
        let ranked = set.map(v => ({
            pubkey: v.pubkey,
            order:  crypto.createHash('sha256').update(batchKey + v.pubkey, 'utf8').digest('hex')
        })).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
        let rank = ranked.findIndex(v => v.pubkey === me);
        // Not in the set: this hub holds no attestation capability at the anchor, so its
        // own signature would not count and it must not lead. A rank past the end defers
        // to every member forever, which is the honest reading of "not eligible".
        if(rank < 0) return { rank: Number.MAX_SAFE_INTEGER, count: ranked.length };
        return { rank: rank, count: ranked.length };
    }

};
