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
 * XChain Hub - Attestation cross-chain relay: the at-most-once WAL and its bound
 *
 * The durable record that stops a restart from re-spending a relay fee, the
 * deadline index that bounds it, eviction past each origin request's own deadline,
 * and the atomic compaction that follows eviction. Installed on
 * AttestationRelay.prototype by src/attestation/relay.js.
 *
 ********************************************************************/

'use strict';

const fs       = require('fs');
const path     = require('path');
const nodeUtil = require('node:util');
const { ORIGIN_CHAINS, MAX_TRACKED_DEADLINES } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- durable at-most-once -----

    appendWal(entry){
        // Stamp the eviction key from one place rather than at each call site,
        // so no record can be written that a later process cannot re-anchor: a record
        // without a deadline is one the eviction pass can never retire.
        let d = this._deadlines.get(String((entry && entry.rid) || '').toLowerCase());
        if(d) entry = Object.assign({}, entry, { deadline_chain: d.coin, deadline_block: d.block });
        try {
            fs.mkdirSync(path.dirname(this.walPath), { recursive: true });
            let fd = fs.openSync(this.walPath, 'a');
            fs.writeSync(fd, JSON.stringify(entry) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch(e){
            this._walFailures++;
            logger.error(nodeUtil.format('AttestationRelay: failed to append the relay WAL at ' + this.walPath + ':', e));
            return false;
        }
    },

    // Seed the at-most-once sets from the WAL. An `intent` with no terminal record is
    // a crash mid-broadcast: treated as SENT, because a duplicate leg burns a real fee
    // for an action the indexer rejects, while a missed relay merely lets the origin
    // request expire on its own deadline. Fail closed toward not spending.
    //
    // Records are keyed on (leg, request_id), the same idempotency key the round ids
    // use, so one request's v3 and v4 never occupy the same slot. A record written
    // before the response leg existed carries no `leg` and is a request-leg record by
    // construction.
    //
    // Each record also carries the eviction key, so the deadline index that
    // bounds these sets survives the restart with them. A record written before this
    // key existed carries none: that leg is simply never evicted, which retains state
    // rather than spending, and the first poll that still sees the request re-indexes
    // it anyway.
    //
    // Returns { records, keys } so start() can tell a file that is one record per live
    // key from a history that has earned a compaction.
    loadWal(){
        let text;
        try { text = fs.readFileSync(this.walPath, 'utf8'); }
        catch(e){ return { records: 0, keys: 0 }; }   // absent on a first run
        let outcome = new Map();
        let records = 0;
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }
            let rid = String(rec.rid || '').toLowerCase();
            if(!rid) continue;
            records++;
            this.noteDeadline(rec.deadline_chain, rid, rec.deadline_block);
            let leg = (String(rec.leg || '') === 'response') ? 'response' : 'request';
            let key = leg + '|' + rid;
            let prior = outcome.get(key);
            // 'sent' is terminal and sticky; 'failed' only clears a bare intent.
            if(rec.phase === 'sent') outcome.set(key, 'sent');
            else if(rec.phase === 'failed' && prior !== 'sent') outcome.set(key, 'failed');
            else if(rec.phase === 'intent' && prior === undefined) outcome.set(key, 'intent');
        }
        let keys = 0;
        for(let [key, state] of outcome){
            if(state !== 'sent' && state !== 'intent') continue;
            let split = key.indexOf('|');
            this.legState(key.substring(0, split)).published.mark(key.substring(split + 1));
            keys++;
        }
        return { records: records, keys: keys };
    },

    // ----- deadline-anchored eviction -----

    // The absolute deadline_block of an origin request row, or null when the row cannot
    // supply a usable one. Null means "never evict this leg": retention is the safe
    // direction, since the only cost is memory and the cost of the other direction is a
    // duplicate broadcast that burns a real fee.
    absoluteOriginDeadline(originReq){
        let block = Number(originReq && originReq.deadline_block);
        return (Number.isInteger(block) && block > 0) ? block : null;
    },

    // A follower's re-derivation of the threaded deadline. Indexes its OWN reading first,
    // then accepts the row only if the leader's copy agrees (or is absent, from a
    // leader running code that predates this field). Never adopts the leader's number.
    checkOriginDeadline(row, originReq){
        let rid  = String(row.request_id || '').toLowerCase();
        let mine = this.absoluteOriginDeadline(originReq);
        this.noteDeadline(row.origin_chain, rid, mine);
        if(row.origin_deadline_block == null) return true;
        return mine != null && Number(row.origin_deadline_block) === mine;
    },

    noteDeadline(coin, rid, deadlineBlock){
        coin  = String(coin || '');
        rid   = String(rid  || '').toLowerCase();
        let block = Number(deadlineBlock);
        if(ORIGIN_CHAINS.indexOf(coin) === -1) return false;
        if(!/^[0-9a-f]{64}$/.test(rid)) return false;
        if(!Number.isInteger(block) || block <= 0) return false;
        let prior = this._deadlines.get(rid);
        if(prior && prior.coin === coin && prior.block === block) return true;
        if(!prior && this._deadlines.size >= MAX_TRACKED_DEADLINES){
            logger.warn('AttestationRelay: deadline index full at ' + MAX_TRACKED_DEADLINES +
                         ' entries; ' + rid.substring(0, 16) + '... will be retained rather than evicted');
            return false;
        }
        this._deadlines.set(rid, { coin: coin, block: block });
        return true;
    },

    // The one definition of "dead beyond recall", shared by the eviction pass and by
    // both re-entry paths. They MUST use the same horizon: if a request could still be
    // proposed after its records were forgotten, eviction would be exactly the
    // double-broadcast it is supposed to prevent. False whenever the chain's tip is
    // unknown, so an unread chain evicts nothing and blocks nothing.
    pastEvictionHorizon(coin, deadlineBlock){
        let tip   = Number(this._originLatest[String(coin || '')]);
        let block = Number(deadlineBlock);
        if(!Number.isFinite(tip) || !Number.isInteger(block)) return false;
        return tip > block + this.evictGraceBlocks + Number(this.confirmations[String(coin)] || 0);
    },

    // Forget every leg whose origin request is dead beyond recall, and compact the WAL
    // down to what is left. THE SAFETY ARGUMENT, which is the whole of this feature:
    //
    //   a leg is evicted only when the ORIGIN chain's tip is past the request's own
    //   deadline_block by that chain's confirmation depth PLUS the grace window. Past
    //   that point the origin indexer's expiry sweep has taken the row out of 'pending'
    //   and no reorg this driver honours can put it back, and BOTH re-entry paths here
    //   (maybeMaterialize, maybeRelayResponse) refuse the same horizon on their way in.
    //   So there is no path from a forgotten key back to a second broadcast.
    //
    // A chain whose tip we have never read is skipped: eviction runs off observed
    // heights only, never off wall clock or off a chain we cannot see.
    evictExpired(){
        let expired = [];
        for(let [rid, d] of this._deadlines){
            if(!this.pastEvictionHorizon(d.coin, d.block)) continue;
            expired.push(rid);
        }
        if(!expired.length) return 0;

        for(let rid of expired){
            this._deadlines.delete(rid);
            for(let phase of ['request', 'response']){
                let state = this.legState(phase);
                state.published.delete(rid);
                state.wire.delete(rid);
            }
            this._evicted++;
        }
        logger.info('AttestationRelay: evicted ' + expired.length + ' relay leg(s) whose origin deadline is ' +
                    'buried past recall (' + this._published.size + ' request + ' + this._publishedResponses.size +
                    ' response record(s) retained)');
        // Only ever after the in-memory eviction: a compaction that failed leaves the
        // fuller file on disk, so a restart re-learns the keys and holds them another
        // window. The reverse order could drop a record that is still live.
        this.compactWal('eviction');
        return expired.length;
    },

    // The same fold loadWal applies, over the file's own text, tracking the record that
    // carried each key's state so the retained line is the original rather than a
    // synthesized one. Returns { keep, lines }.
    foldWalRecords(text){
        let state = new Map();
        let keep  = new Map();
        let lines = 0;
        for(let line of text.split('\n')){
            if(!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch(_){ continue; }
            let rid = String(rec.rid || '').toLowerCase();
            if(!rid) continue;
            lines++;
            let leg   = (String(rec.leg || '') === 'response') ? 'response' : 'request';
            let key   = leg + '|' + rid;
            let prior = state.get(key);
            if(rec.phase === 'sent'){ state.set(key, 'sent'); keep.set(key, rec); }
            else if(rec.phase === 'failed' && prior !== 'sent'){ state.set(key, 'failed'); keep.set(key, rec); }
            else if(rec.phase === 'intent' && prior === undefined){ state.set(key, 'intent'); keep.set(key, rec); }
        }
        return { keep: keep, lines: lines };
    },

    // One line per surviving at-most-once key: the record that decided it, restamped
    // with the live deadline, plus a synthetic 'sent' for a key with no line left.
    compactedWalLines(keep){
        let out  = [];
        let seen = new Set();
        for(let [key, rec] of keep){
            let split = key.indexOf('|');
            let leg   = key.substring(0, split);
            let rid   = key.substring(split + 1);
            // Dropped here: keys this pass just evicted, and keys whose last word was a
            // definitive 'failed' (absent and 'failed' mean the same thing on reload).
            if(!this.legState(leg).published.has(rid)) continue;
            let d = this._deadlines.get(rid);
            out.push(JSON.stringify(Object.assign({}, rec, {
                leg: leg, compacted: true,
                deadline_chain: d ? d.coin  : rec.deadline_chain,
                deadline_block: d ? d.block : rec.deadline_block
            })));
            seen.add(key);
        }
        for(let leg of ['request', 'response']){
            for(let rid of this.legState(leg).published.keys()){
                if(seen.has(leg + '|' + rid)) continue;
                let d = this._deadlines.get(rid);
                out.push(JSON.stringify({
                    ts: Date.now(), rid: rid, leg: leg, phase: 'sent', compacted: true, synthesized: true,
                    deadline_chain: d ? d.coin : undefined, deadline_block: d ? d.block : undefined
                }));
            }
        }
        return out;
    },

    // Rewrite the WAL as ONE record per surviving at-most-once key, atomically. The
    // retained record is the original line that decided the key's state, so a txid an
    // operator may need to trace is preserved rather than synthesized away; a key with
    // no line left (only possible if a record was lost) gets a synthetic 'sent' so
    // compaction can never be the thing that un-suppresses a broadcast.
    compactWal(reason){
        let text;
        try { text = fs.readFileSync(this.walPath, 'utf8'); }
        catch(e){ return false; }   // nothing on disk yet: nothing to compact

        let folded = this.foldWalRecords(text);
        let lines  = folded.lines;
        let out    = this.compactedWalLines(folded.keep);

        let tmp = this.walPath + '.compact';
        try {
            fs.mkdirSync(path.dirname(this.walPath), { recursive: true });
            let fd = fs.openSync(tmp, 'w');
            fs.writeSync(fd, out.length ? out.join('\n') + '\n' : '');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            // Atomic: a crash here leaves the OLD file, which is the conservative one.
            fs.renameSync(tmp, this.walPath);
            this._walCompactions++;
            logger.info('AttestationRelay: compacted the relay WAL (' + reason + '): ' +
                        lines + ' record(s) -> ' + out.length);
            return true;
        } catch(e){
            this._walFailures++;
            try { fs.unlinkSync(tmp); } catch(_){ /* best effort */ }
            logger.error(nodeUtil.format('AttestationRelay: WAL compaction (' + reason + ') failed at ' + this.walPath +
                          '; the uncompacted file stands:', e));
            return false;
        }
    }

};
