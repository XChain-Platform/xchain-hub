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
 * AttestationBatchPublisher: the batch signing round
 *
 * The leader half that collects a quorum over the batch canonical and the follower
 * half that co-signs only a window it can rebuild from its own rows. Installed on
 * AttestationBatchPublisher.prototype by src/attestation/batch_publisher.js.
 *
 ********************************************************************/

'use strict';

const swq               = require('../../stake_weighted_quorum.js');
const abw               = require('../../lib/attest_batch_wire.js');
const ValidatorIdentity = require('../../validators/identity.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { XATTESTB_SIGN_REQ, XATTESTB_SIGN, ANCHOR_MAX_LAG_BLOCKS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ------------------------------------------------------------ the signing round

    // Leader half. Resolves { met, sigs } once a quorum of the attestation set at the
    // anchor has co-signed the batch canonical, or { met:false } on timeout or a short
    // quorum. On met:false NOTHING is published for the window.
    async collectBatchSignatures(window, batchKey){
        let empty = { met: false, sigs: [] };
        if(!this.identity) return empty;

        let canonical = abw.buildAttestBatchCanonical({
            network:          window.network,
            window_start:     window.window_start,
            window_end:       window.window_end,
            row_count:        window.row_count,
            btc_block_height: window.btc_block_height,
            rows:             this.wireRows(window.rows)
        });

        let set = await this.resolveAttestationSet(window.btc_block_height);
        if(!set) return empty;
        let me = this.identity.getPubkeyHex().toLowerCase();
        // This hub must hold `attestation` at the anchor, or its own signature is not
        // counted by the verifier and the quorum arithmetic below is fiction.
        if(!set.some(v => v.pubkey === me)) return empty;

        this.stats.signRounds++;
        let mySig = this.identity.sign(canonical);
        let signatures = new Map([[me, mySig]]);

        let pm = this.hubPeerManager();
        if(set.length <= 1 || !pm || typeof pm.broadcast !== 'function'){
            // Genuine single-member set (membership proven above): this hub's signature
            // IS the quorum, matching the single-node bypass every other rail carries.
            this.stats.signQuorums++;
            return { met: true, sigs: [{ pubkey: me, sig: mySig }] };
        }

        return await new Promise((resolve) => {
            this.openSignRound(window, batchKey, canonical, signatures, set, pm, resolve);
        });
    },

    // The round the leader holds open: its timeout, and the request that asks every
    // co-signer to rebuild the bytes from its own rows. Called from inside the promise
    // executor, so it still runs synchronously with the promise's creation.
    openSignRound(window, batchKey, canonical, signatures, set, pm, resolve){
        let round = {
            batchKey, canonical, signatures, resolve, done: false, timer: null,
            windowStart: window.window_start, windowEnd: window.window_end,
            weighted: set.weighted === true,
            quorum:   bftQuorumOrSingle(set.count, 1),
            validators: set.map(v => ({ pubkey: v.pubkey, source: v.source, weight: v.weight }))
        };
        this._signRound = round;
        round.timer = setTimeout(() => {
            if(this._signRound === round && !round.done){
                round.done = true;
                this._signRound = null;
                this.stats.signTimeouts++;
                logger.warn('AttestationBatchPublisher: batch-signing round for window ' +
                    window.window_start + '-' + window.window_end + ' timed out at ' +
                    round.signatures.size + '/' + round.quorum + ' signatures; the window stays unpublished');
                resolve({ met: false, sigs: [] });
            }
        }, this.signTimeoutMs);
        if(round.timer.unref) round.timer.unref();

        // The request carries the canonical's INPUT, never its bytes: a peer must
        // rebuild those from its own rows, and shipping the bytes would invite it to
        // sign what it was handed.
        pm.broadcast(XATTESTB_SIGN_REQ, {
            network:          window.network,
            window_start:     window.window_start,
            window_end:       window.window_end,
            row_count:        window.row_count,
            btc_block_height: window.btc_block_height,
            rows:             this.wireRows(window.rows)
        });
        this.checkSignQuorum();
    },

    checkSignQuorum(){
        let round = this._signRound;
        if(!round || round.done) return;
        let met = round.weighted
            ? swq.meetsStakeThreshold(round.validators, round.signatures.keys())
            : (round.signatures.size >= round.quorum);
        if(!met) return;
        round.done = true;
        if(round.timer){ clearTimeout(round.timer); round.timer = null; }
        this._signRound = null;
        this.stats.signQuorums++;
        round.resolve({ met: true, sigs: Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig })) });
    },

    handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XATTESTB_SIGN_REQ:
                this.handleSignReq(envelope).catch(e =>
                    logger.error('AttestationBatchPublisher: XATTESTB_SIGN_REQ error: ' + (e && e.message)));
                break;
            case XATTESTB_SIGN:
                this.handleSign(envelope).catch(e =>
                    logger.error('AttestationBatchPublisher: XATTESTB_SIGN error: ' + (e && e.message)));
                break;
        }
    },

    // Follower half. Co-sign ONLY a window this hub can rebuild from its own mirror
    // rows. Every refusal is silent on the wire (logged locally, nothing sent): the only
    // honest answer to "I cannot reproduce that" is to withhold a signature, and a NACK
    // would be an unauthenticated claim about someone else's state.
    async handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !this.hubDb()) return;
        let pm = this.hubPeerManager();
        if(!pm || typeof pm.broadcast !== 'function') return;

        let sender = String(envelope.sig_pubkey || '').toLowerCase();
        if(sender && sender === this.identity.getPubkeyHex().toLowerCase()) return;   // own broadcast echo

        if(String(d.network) !== this.network) return;
        let bounds = this.signReqBounds(d);
        if(!bounds) return;
        let windowStart = bounds.windowStart, windowEnd = bounds.windowEnd;

        // The anchor is BOUNDED, not re-derived: two honest hubs never hold the same
        // tip. It must be a height this hub can already see (so the proposer cannot
        // reach forward past a set it can predict) and no further back than a day of
        // blocks (so it cannot reach back to a set it once controlled).
        let anchor = Number(d.btc_block_height);
        let myTip  = await this.resolveAnchor();
        if(!Number.isInteger(anchor) || anchor <= 0 || myTip === null ||
           anchor > myTip || anchor < myTip - ANCHOR_MAX_LAG_BLOCKS){
            this.refuse(windowStart, 'proposed anchor ' + anchor + ' is outside this hub\'s bounds (tip ' +
                         (myTip === null ? 'unresolved: ' + this._anchorFailure : myTip) +
                         ', max lag ' + ANCHOR_MAX_LAG_BLOCKS + ')',
                         myTip === null ? 'no_chain_tip' : null);
            return;
        }

        // This hub must hold `attestation` at the anchor, or its signature is dead
        // weight on the wire and the leader counts a quorum the chain will not.
        let set = await this.resolveAttestationSet(anchor);
        let me  = this.identity.getPubkeyHex().toLowerCase();
        if(!set || !set.some(v => v.pubkey === me)){
            this.refuse(windowStart, 'this hub holds no attestation capability at anchor ' + anchor);
            return;
        }
        // Same rows the leader wrote, from this hub's own resolution (deterministic,
        // INSERT IGNORE), so an indexer following THIS hub verifies the batch too.
        await this.persistAttestationSnapshot(anchor, set);

        let mine;
        try {
            mine = await this.selectWindowRows(windowStart, windowEnd);
        } catch(e){
            this.refuse(windowStart, 'local attestation_responses unreadable (' + (e && e.message) + ')');
            return;
        }
        let verdict = this.matchesLocalWindow(d.rows, mine);
        if(!verdict.ok){
            this.refuse(windowStart, verdict.why);
            return;
        }

        this.sendWindowSignature(d, windowStart, windowEnd, anchor, me, pm);
    },

    // The proposed window's own bounds and row list, checked before any DB work: the
    // cadence must be this hub's, and the count is proposer-chosen, so an unbounded row
    // list is a query-cost amplifier on every attestation validator. Returns the bounds,
    // or null having already refused.
    signReqBounds(d){
        let windowStart = Number(d.window_start), windowEnd = Number(d.window_end);
        if(!Number.isInteger(windowStart) || !Number.isInteger(windowEnd) ||
           windowStart < 0 || windowEnd !== windowStart + this.windowS) {
            this.refuse(windowStart, 'window bounds are not this hub\'s cadence');
            return null;
        }
        if(!Array.isArray(d.rows) || d.rows.length > abw.ATTEST_BATCH_MAX_ROWS){
            this.refuse(windowStart, 'row list is missing or over the consensus cap');
            return null;
        }
        if(Number(d.row_count) !== d.rows.length){
            this.refuse(windowStart, 'row_count does not match the rows sent');
            return null;
        }
        return { windowStart: windowStart, windowEnd: windowEnd };
    },

    // The co-signature itself, over bytes rebuilt from the proposed body this hub has
    // just matched against its own rows.
    sendWindowSignature(d, windowStart, windowEnd, anchor, me, pm){
        let canonical = abw.buildAttestBatchCanonical({
            network:          this.network,
            window_start:     windowStart,
            window_end:       windowEnd,
            row_count:        d.rows.length,
            btc_block_height: anchor,
            rows:             d.rows
        });
        pm.broadcast(XATTESTB_SIGN, {
            network:      this.network,
            window_start: windowStart,
            window_end:   windowEnd,
            pubkey:       me,
            sig:          this.identity.sign(canonical)
        });
        this.stats.signaturesProvided++;
    },

    // THE SAFETY PROPERTY. Every proposed row must exist locally and match field for
    // field, so a fabricated, altered or injected row is refused; and every local row of
    // the window must be proposed, so a leader cannot quietly drop coverage.
    //
    // The completeness half carries NO exemption, because the window is partitioned by
    // the signed effective time: two honest hubs holding one row put it in the same
    // window, so a difference here is a real disagreement about content and refusing it
    // is the point. A row a follower holds and the leader has not received yet is the
    // one benign case, and the forward margin already covers it: the row was written a
    // whole margin before this window could close.
    //
    // ROW IDENTITY IS (request_id, effective_time), the table's own key. A request can
    // hold two honest rows when its round finalized under two leader slots, and the
    // stamp is the only signed field that tells them apart; keying on request_id alone
    // read the second variant as "appears twice" on the hub that held both and as a
    // field mismatch on a hub that held one, so no such window could ever be co-signed
    // (regtest ladder, AT5 pass 19). The same request with the same stamp twice is
    // still a malformed window and is still refused.
    matchesLocalWindow(proposed, mine){
        const keyOf = (r) => String((r && r.request_id) || '').toLowerCase() + '@' +
                             String(r && r.effective_time == null ? '' : r.effective_time);
        let byKey = new Map(mine.map(r => [keyOf(r), r]));
        let seen  = new Set();
        for(let p of proposed){
            let rid = String((p && p.request_id) || '').toLowerCase();
            if(!rid) return { ok: false, why: 'a proposed row carries no request_id' };
            let key = keyOf(p);
            if(seen.has(key)) return { ok: false, why: 'request ' + rid.substring(0, 16) + '... appears twice' };
            seen.add(key);
            let local = byKey.get(key);
            if(!local)
                return { ok: false, why: 'request ' + rid.substring(0, 16) + '... at effective_time ' +
                         String(p.effective_time) + ' is proposed but not held here' };
            for(let f of abw.ATTEST_BATCH_ROW_FIELDS){
                if(String(p[f] == null ? '' : p[f]) !== String(local[f] == null ? '' : local[f]))
                    return { ok: false, why: 'request ' + rid.substring(0, 16) + '... differs on ' + f };
            }
        }
        for(let local of mine){
            if(seen.has(keyOf(local))) continue;
            return { ok: false, why: 'request ' + String(local.request_id).substring(0, 16) +
                     '... at effective_time ' + String(local.effective_time) +
                     ' is held here for this window but was not proposed' };
        }
        return { ok: true, why: null };
    },

    async handleSign(envelope){
        let d = envelope.data;
        let round = this._signRound;
        if(!round || round.done || !d) return;
        // A signature names the window it covers, and a late one for a PREVIOUS window
        // must not be counted into the round now open: the bytes differ, so it would be
        // a signature over content this batch does not carry. The verify below would
        // catch it anyway; refusing here is what keeps that from being the only guard.
        if(Number(d.window_start) !== round.windowStart || Number(d.window_end) !== round.windowEnd) return;
        let pubkey = String(d.pubkey || '').toLowerCase();
        if(!round.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.sig || ''), pubkey)) return;
        round.signatures.set(pubkey, String(d.sig));
        this.checkSignQuorum();
    },

    // reasonClass separates a distinct, actionable shape (no chain tip resolved at
    // all, so this hub refuses every proposal it is ever handed) from the generic
    // total, which mixes it with ordinary content and cadence disagreements.
    refuse(windowStart, why, reasonClass){
        this.stats.signRefusals++;
        if(reasonClass === 'no_chain_tip') this.stats.signRefusalsNoChainTip++;
        logger.warn('AttestationBatchPublisher: refusing to co-sign the batch for window ' +
                     windowStart + ': ' + why);
    }

};
