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

// Settle a batch a crash left open, from its chunk plan and the sent set. The first
// chunk whose pubkeys were not all sent may have reached the node, so its pubkeys join
// the sent set; the chunks after it were never sent. True when the batch has an unsent
// tail to retry, false when it finished or has no plan to judge it by.
function settleOpenBatch(k){
    k.open = false;
    if(!k.plan) return false;
    let cut = k.plan.findIndex(chunk => !chunk.every(pk => k.sent.has(pk)));
    if(cut < 0) return false;
    for(let pk of k.plan[cut]) k.sent.add(pk);
    return cut < k.plan.length - 1;
}

module.exports = {

    // ── durable records ──────────────────────────────────────────────────────

    // Append one fsync'd line. Returns true only on a confirmed durable write;
    // the intent call gates on that result, the outcome calls are best-effort
    // because the fee is already committed by then.
    //
    // A file whose last byte is not a newline ends in a torn line from a write that
    // died mid-way; this line starts on a fresh one, so the torn fragment stays one
    // unparseable line and never swallows the record written after it.
    appendLine(file, obj){
        let line = JSON.stringify(obj) + '\n';
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            let fd = fs.openSync(file, 'a+');
            try {
                let size = fs.fstatSync(fd).size;
                if(size > 0){
                    let last = Buffer.alloc(1);
                    fs.readSync(fd, last, 0, 1, size - 1);
                    if(last[0] !== 0x0a) line = '\n' + line;
                }
                fs.writeSync(fd, line); fs.fsyncSync(fd);
            }
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
    // committed, one key per epoch and role. An 'intent' opens a batch with its chunk
    // plan; 'sent' lines add the pubkeys each chunk carried; a 'failed' (the
    // definitive pre-send failure of every chunk not yet sent) or an 'ambiguous'
    // closes it. An 'ambiguous' is committed and never cleared. A batch left open by
    // a crash is judged by its plan against the SENT SET, never by counting lines, so
    // a duplicated or torn line cannot shift it: the first plan chunk whose pubkeys
    // were not all sent may have reached the node and counts as on the wire, and every
    // chunk after it was never sent. A new 'intent' over an open batch (the retry after
    // a restart) settles the open batch the same way before it starts. A finished
    // batch stays committed; a cut-off one is cleared so its unsent tail is retried. A
    // bare intent or a 'sent' line written without pubkeys cannot say what went out,
    // so its key stays committed.
    //
    // The same pass rebuilds which signatures this hub may already have on the wire
    // for each epoch, which the chain has shown landed ('landed'), and which a reorg
    // has since taken off it ('reorged'); restoreDelivered hands them to the round.
    loadSpendLog(){
        let text;
        try { text = fs.readFileSync(this.spendLogPath, 'utf8'); }
        catch(e){ return; }
        let mine = this.ownPubkey();
        let keys = new Map();
        // <epoch>:<ledger_hash>:<pubkey> for each signature a 'rescue' line took off the
        // wire and no later 'sent' or 'ambiguous' line carried again. They stay in the
        // per-key sent sets, which still judge each batch and its commitment, and are
        // left out of the delivery memory only, so the self-publish sends them again.
        let lifted = new Set();
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }   // a torn line
            let epoch = Number(rec.epoch);
            if(!Number.isFinite(epoch)) continue;
            // Another identity's spend is not this hub's commitment. A record
            // naming no pubkey predates the field and is kept as this hub's own.
            if(mine && rec.pubkey && String(rec.pubkey).toLowerCase() !== mine) continue;
            this.foldSpendRecord(keys, epoch, rec, lifted);
        }
        for(let [key, k] of keys){
            let held = k.ambiguous || k.blind;
            if(k.open){ let tail = settleOpenBatch(k); held = held || !tail; }
            if(held) this._committed.add(key);
            let base = k.epoch + ':' + (k.ledgerHash || '') + ':';
            for(let pk of k.sent){
                if(!lifted.has(base + pk)) this.memoryFor(this._delivered, k.epoch, k.ledgerHash).add(pk);
            }
        }
    },

    // One spend-log line into the per-key fold loadSpendLog finishes; `lifted` collects
    // the signatures a 'rescue' took off the wire (see loadSpendLog).
    foldSpendRecord(keys, epoch, rec, lifted){
        let key = rec.kind === 'self' ? (epoch + ':self') : String(epoch);
        if(!keys.has(key)) keys.set(key, { epoch, ledgerHash: null, open: false, plan: null,
                                           ambiguous: false, blind: false, sent: new Set() });
        let k = keys.get(key);
        let pubkeys = Array.isArray(rec.pubkeys) ? rec.pubkeys.map(p => String(p).toLowerCase()) : null;
        if(rec.ledger_hash) k.ledgerHash = String(rec.ledger_hash).toLowerCase();
        this.foldTipFloors(epoch, k.ledgerHash, rec, pubkeys);
        // This line's prefix in `lifted`: a 'rescue' adds its pubkeys there, and a 'sent'
        // or 'ambiguous' that carries one of them again puts it back on the wire.
        let lift = epoch + ':' + (k.ledgerHash || '') + ':';
        if(rec.phase === 'landed' && pubkeys){
            for(let pk of pubkeys) this.memoryFor(this._seenOnChain, epoch, k.ledgerHash).add(pk);
        } else if(rec.phase === 'rescue' && pubkeys){
            this._rescued.add(epoch + ':' + (k.ledgerHash || ''));
            for(let pk of pubkeys){ k.sent.delete(pk); lifted.add(lift + pk); }
            Object.assign(k, { open: false, ambiguous: false });
        } else if(rec.phase === 'reorged' && pubkeys){
            for(let pk of pubkeys){
                k.sent.delete(pk);
                this.memoryFor(this._seenOnChain, epoch, k.ledgerHash).delete(pk);
            }
            Object.assign(k, { open: false, ambiguous: false });
        } else if(rec.phase === 'intent'){
            if(k.open && !k.blind && !settleOpenBatch(k)) k.blind = true;
            let plan = Array.isArray(rec.plan) && rec.plan.every(Array.isArray)
                ? rec.plan.map(c => c.map(p => String(p).toLowerCase())) : null;
            Object.assign(k, { open: true, plan });
        } else if(rec.phase === 'sent'){
            if(pubkeys) for(let pk of pubkeys){ k.sent.add(pk); lifted.delete(lift + pk); } else k.blind = true;
        } else if(rec.phase === 'ambiguous'){
            for(let pk of (pubkeys || [])){ k.sent.add(pk); lifted.delete(lift + pk); }
            Object.assign(k, { open: false, ambiguous: true });
        } else if(rec.phase === 'failed'){
            k.open = false;
        }
    },

    // The tip floors delivery.js counts the reorg wait above: the highest tip this
    // hub's signatures were seen landed at ('landed', 'missing'), and the highest tip a
    // send carrying the own signature went out at ('sent', 'ambiguous').
    foldTipFloors(epoch, ledgerHash, rec, pubkeys){
        let tip = (rec.tip === null || rec.tip === undefined) ? NaN : Number(rec.tip);
        if(!Number.isFinite(tip)) return;
        let state = { epoch, ledgerHash };
        if(rec.phase === 'landed' || rec.phase === 'missing') this.raiseTipFloor(this._seenTip, state, tip);
        else if((rec.phase === 'sent' || rec.phase === 'ambiguous') && pubkeys && pubkeys.includes(this.ownPubkey()))
            this.raiseTipFloor(this._sentTip, state, tip);
    },

    // The Set an epoch's delivery memory keeps under its ledger_hash, created on first
    // use. A signature is only worth what its ledger_hash is, so a re-signed epoch
    // starts empty instead of inheriting the set the old hash carried.
    memoryFor(map, epoch, ledgerHash){
        let key = epoch + ':' + (ledgerHash || '');
        if(!map.has(key)) map.set(key, new Set());
        return map.get(key);
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
