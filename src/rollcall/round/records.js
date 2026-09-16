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
 * XChain Hub - ROLLCALL round: durable records and status
 *
 * The fsync'd spend and signature logs, what a restart recovers from them, and
 * the publisher-state view the status RPC serves.
 *
 * src/rollcall/round.js installs every method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods, so callers and tests keep
 * reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const path  = require('path');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ── durable records ──────────────────────────────────────────────────────

    // Append one fsync'd line. Returns true only on a confirmed durable write;
    // the intent call gates on that result, the outcome calls are best-effort
    // because the fee is already committed by then.
    appendLine(file, obj){
        let line = JSON.stringify(obj) + '\n';
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            let fd = fs.openSync(file, 'a');
            try { fs.writeSync(fd, line); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            return true;
        } catch(e){
            logger.error(nodeUtil.format('RollcallRound: failed to write ' + file + ':', e && e.message ? e.message : e));
            return false;
        }
    },

    // Every durable record names the identity that wrote it, so a log that
    // holds another hub's lines (a copied config dir, a shared audit path) can
    // be told apart from this hub's own on the next boot.
    ownPubkey(){
        return this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
    },

    recordSpend(entry){
        return this.appendLine(this.spendLogPath,
            Object.assign({ ts: Date.now(), effector: 'ROLLCALL_PUBLISH', pubkey: this.ownPubkey() || undefined }, entry));
    },

    // A signature costs nothing on chain, so an unwritable path must not stop the
    // hub answering an epoch; it only costs the restart re-emit.
    recordSignature(entry){
        return this.appendLine(this.signLogPath, Object.assign({ ts: Date.now() }, entry));
    },

    // Fold the append-only spend log into the set of epochs whose fee is already
    // committed. Same sticky rules the other effectors use: a terminal 'sent' or
    // 'ambiguous' is committed and never cleared; a bare 'intent' counts as
    // committed (the transaction may have reached the node); only a 'failed', the
    // definitive pre-send failure, clears a bare intent so a genuine retry runs.
    //
    // LAST-RECORD-WINS below the sticky 'sent', not first: an epoch that failed
    // definitively and then retried appends a SECOND intent, and that intent must
    // re-arm the guard exactly like the first.
    loadSpendLog(){
        let text;
        try { text = fs.readFileSync(this.spendLogPath, 'utf8'); }
        catch(e){ return; }
        let mine = this.ownPubkey();
        let outcome = new Map();
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }   // a torn tail line
            let epoch = Number(rec.epoch);
            if(!Number.isFinite(epoch)) continue;
            // Another identity's spend is not this hub's commitment. A record
            // naming no pubkey predates the field and is kept as this hub's own.
            if(mine && rec.pubkey && String(rec.pubkey).toLowerCase() !== mine) continue;
            let key   = rec.kind === 'self' ? (epoch + ':self') : String(epoch);
            let prior = outcome.get(key);
            if(rec.phase === 'sent' || rec.phase === 'ambiguous') outcome.set(key, 'sent');
            else if(prior === 'sent') continue;
            else if(rec.phase === 'failed') outcome.set(key, 'failed');
            else if(rec.phase === 'intent') outcome.set(key, 'intent');
        }
        for(let [key, st] of outcome) if(st === 'sent' || st === 'intent') this._committed.add(key);
    },

    // Last write wins: a re-signature for the same epoch (a reorg changed the
    // ledger_hash under us) supersedes the earlier one.
    //
    // ONLY THIS HUB'S OWN LINES. A restored signature is re-emitted under this
    // hub's pubkey without re-signing, so a line another identity wrote would be
    // broadcast as ours: every peer drops it at verification, this hub records
    // nothing of its own for the epoch, and it reads as ABSENT while believing
    // it signed. Measured on the regtest acceptance venue on 2026-09-04, where
    // three in-process hubs shared one log and the restarted hub carried a
    // peer's signature on its own self-publish.
    loadSignLog(){
        let text;
        try { text = fs.readFileSync(this.signLogPath, 'utf8'); }
        catch(e){ return; }
        let mine = this.ownPubkey();
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }
            let epoch = Number(rec.epoch);
            let lh    = String(rec.ledger_hash || '').toLowerCase();
            let sig   = String(rec.sig || '').toLowerCase();
            if(!Number.isFinite(epoch)) continue;
            if(!/^[0-9a-f]{64}$/.test(lh) || !/^[0-9a-f]{128}$/.test(sig)) continue;
            if(mine && String(rec.pubkey || '').toLowerCase() !== mine) continue;
            this._signatures.set(epoch, { ledgerHash: lh, sig });
        }
    },

    // ── status ───────────────────────────────────────────────────────────────

    // PUBLISHER STATE ONLY. No ledger facts (last_rolled_epoch, absent_streak)
    // live here: those are the BTC indexer's and are authoritative there, and
    // serving a per-epoch view of who did and did not sign is a pre-eviction
    // targeting surface, which is why the RPC is in SENSITIVE_READ_METHODS.
    getStatus(){
        let epochs = Array.from(this.rounds.keys()).sort((a, b) => b - a);
        let state  = epochs.length > 0 ? this.rounds.get(epochs[0]) : null;
        if(!state){
            return { epoch: null, signed: false, gossiped_count: 0, on_chain_count: null,
                     leader: null, our_rank: -1, txids: [], broadcast_capable: this.broadcastCapable() };
        }
        return {
            epoch:             state.epoch,
            signed:            state.signed,
            gossiped_count:    state.sigs.size,
            on_chain_count:    state.onChainCount,
            leader:            state.leader,
            our_rank:          state.myRank,
            txids:             state.txids.slice(),
            broadcast_capable: this.broadcastCapable()
        };
    }
};
