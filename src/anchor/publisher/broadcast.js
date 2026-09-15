/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - broadcast, rate limits and confirmations
 *
 * The retry ladder around one DOGE send, the rate-limit waits it honours, the
 * balance gate, and the watchdog over anchors that have not confirmed.
 *
 ********************************************************************/

'use strict';

const { isAmbiguousSendError } = require('../../lib/idempotent_broadcast.js');
const { sumUtxosCoins } = require('../../lib/utxo_balance.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Parse an RFC 7231 Retry-After value to milliseconds, or null when absent or
// unparseable. Both forms are in play: the encoder's per-IP limiter sends
// delta-seconds and a proxy in front of it may rewrite that to an HTTP-date.
// A past date yields 0 (retry now), never a negative wait.
function parseRetryAfterMs(raw){
    if(raw === null || raw === undefined) return null;
    let value = Array.isArray(raw) ? raw[0] : raw;
    let text = String(value).trim();
    if(text === '') return null;
    if(/^\d+$/.test(text)) return Number(text) * 1000;
    let at = Date.parse(text);
    if(Number.isNaN(at)) return null;
    return Math.max(0, at - Date.now());
}

module.exports = {

    // Back-to-back spends from the one publisher wallet race the UTXO
    // tracker's mempool view and collide on input selection
    // (txn-mempool-conflict), so every anchor broadcast retries with a pause
    // for the previous spend to become visible. Throws the last error once
    // attempts are exhausted.
    // Broadcast with retry, WITHOUT double-spending on a lost ACK.
    //
    // Each attempt intentionally rebuilds a FRESH PSBT from fresh UTXOs (conflict
    // avoidance for back-to-back multi-chain anchors), which is exactly why a
    // retry after an AMBIGUOUS send failure (the DOGE node may have accepted the
    // tx but the ACK was lost in transport) would double-broadcast and burn the
    // fee twice: the rebuilt tx spends different UTXOs, so both can confirm.
    // Mirrors AttestationPublisher's authoritative pre-replay existence check
    // (fetchPendingRequestIds): when the caller can answer "did this anchor
    // already land?" it passes `existsCheck`, consulted BEFORE every attempt
    // (attempt 0 too, closing the lost-ACK-from-a-previous-flush window) and
    // POLLED after an ambiguous send error before giving up.
    //
    // existsCheck() contract: resolves { exists: true, txid } when a matching
    // anchor is already on-chain (any depth), a falsy value when definitively
    // absent from the mined view, and THROWS when it cannot determine (indexer
    // unreachable / not wired).
    //
    // Rules:
    //   - existsCheck says exists        -> adopt it; never re-broadcast.
    //   - definitive pre-send/reject err -> safe: retry with a fresh PSBT.
    //   - ambiguous send err (tagged `anchorAmbiguousSend` by defaultBroadcast)
    //     -> the tx may sit in the DOGE mempool where the indexer cannot see it
    //     yet; poll existsCheck briefly, then DEFER (throw) instead of
    //     re-broadcasting. The row stays pending; the next flush's pre-broadcast
    //     existence check settles it once mined (adopt) or confirms absence
    //     (safe re-broadcast). Same defer-over-risk choice AttestationPublisher
    //     makes when its indexer is unreachable.
    async broadcastWithRetry(broadcaster, payload, attempts, existsCheck){
        attempts = attempts || 5;
        let token = this.reserveBroadcastBudget();
        try {
            let lastErr = null;
            // Explicit attempt counter rather than a `for` step: a rate-limit wait below
            // retries WITHOUT consuming an attempt (the encoder is telling us when to come
            // back, which is not a transient send failure), and `delayMs` carries the wait
            // that branch chose so the loop top never double-sleeps it with the flat delay.
            let attempt = 0, delayMs = 0, rateLimitWaits = 0;
            while(attempt < attempts){
                if(delayMs > 0) await this._sleep(delayMs);
                delayMs = this.chunkRetryDelayMs;
                if(existsCheck){
                    let found;
                    try { found = await existsCheck(); }
                    catch(e){ found = undefined; }   // undetermined
                    if(this.adoptedExistingAnchor(found, lastErr, token)) return found;
                }
                this.refuseWhilePaused(token, lastErr);
                try {
                    let sent = await broadcaster(payload);
                    // A fresh broadcast actually spent a fee; keep the reserved budget
                    // as the recorded spend. The adopt path above returns an already
                    // on-chain tx and deliberately releases instead (no new spend).
                    this.spendGuard.commit(token);
                    return sent;
                }
                catch(e){
                    lastErr = e;
                    this.releaseOnUnfundedBuild(e, token);
                    if(e && e.anchorAmbiguousSend){
                        // The send may have been accepted; give the anchor a bounded
                        // window to reach the indexer's mined view, then defer. Either
                        // way the fee is treated as spent.
                        let found = existsCheck ? await this.pollAmbiguousSend(existsCheck) : null;
                        this.spendGuard.commit(token);
                        if(found) return found;   // our send is what landed
                        throw e;   // defer to a later flush; never rebuild+re-broadcast
                    }
                    let rlWaitMs = this.rateLimitRetryDelay(e, rateLimitWaits, token);
                    if(rlWaitMs !== null){
                        rateLimitWaits++;
                        delayMs = rlWaitMs;
                        continue;   // deliberately does NOT consume an attempt
                    }
                    attempt++;
                }
            }
            // Retries only continue on definitive failures, so an exhausted loop sent
            // nothing; the release below hands the budget back.
            throw lastErr || new Error('broadcast failed');
        }
        finally {
            // Backstop, not the settle point: release() is a no-op on a token already
            // committed or released, so an exit that forgot to settle gives the budget
            // back rather than leaking a reservation that over-counts the window.
            this.spendGuard.release(token);
        }
    },

    // flush() checks the pause + per-window
    // ceiling ONCE, but a single flush broadcasts N times (one per pending
    // checkpoint plus one per archive chunk), each spending a fee. Gate per
    // broadcast here so the ceiling and the runtime pause bind every send, not
    // just the first (fail-closed, like the sibling AttestationPublisher).
    //
    // The gate is a RESERVATION, not the old allow()/await/record() pair:
    // allow() and record() straddle the awaited send, so concurrent flushes all
    // read the same pre-send budget and all spend, and every exit that did not
    // reach record() charged nothing even when the transaction had gone out
    // (a lost ACK spends a real fee). reserve() runs the same gates, consumes
    // the budget in one synchronous turn and PERSISTS it before the send
    // (spend_guard.js:259-268); the reservation IS the record, so record() must
    // never be called on this path or the spend is counted twice.
    //
    // Retries of the SAME payload do not re-reserve: one call publishes at most
    // one transaction, so the reservation is per row/chunk and is settled exactly
    // once on whichever exit the call takes. commit() on every outcome where the
    // transaction may have reached the node (including both ambiguous exits:
    // over-charging a send that never landed fails closed and ages out within one
    // window), release() only on definitive never-sent exits.
    reserveBroadcastBudget(){
        let token = this.spendGuard.reserve();
        if(!token){
            let err = new Error(this.spendGuard.noteBlocked() + '; skipping remaining broadcasts this flush');
            err.spendBlocked = true;
            throw err;
        }
        return token;
    },

    // The pre-send existence answer `found`, judged: true when the anchor is already
    // on-chain (the budget is handed back and the caller adopts `found`); throws the
    // earlier ambiguous error when the answer is undetermined after a send that may
    // have gone out; false when the attempt may proceed.
    adoptedExistingAnchor(found, lastErr, token){
        if(found && found.exists){
            logger.info('StateAnchorPublisher: anchor already on-chain (txid ' +
                        (found.txid || '?') + '); adopting instead of re-broadcasting');
            this.spendGuard.release(token);   // nothing was sent in this call
            return true;
        }
        // Undetermined + a send may already have gone out: never risk it.
        if(found === undefined && lastErr && lastErr.anchorAmbiguousSend){
            this.spendGuard.commit(token);    // the send may have landed
            throw lastErr;
        }
        return false;
    },

    // Re-read the operator pause before EVERY attempt. The pause is an
    // out-of-band runtime toggle (the control RPC flips an in-memory flag),
    // so the entry reservation cannot see one asserted during the awaited
    // retry delay or existence check above, and an operator halt has to stop
    // the sends that have not gone out yet. Only the PAUSE is re-read: the
    // ceiling stays gated once per row/chunk because a retry of the same
    // payload consumes no new budget, and re-gating it would refuse
    // legitimate retries. Same idiom as RollcallRound's per-chunk re-check.
    refuseWhilePaused(token, lastErr){
        if(this.spendGuard.isPaused()){
            // An earlier ambiguous attempt keeps its own error: the caller
            // withdraws the anchor intent markers for every failure NOT flagged
            // anchorAmbiguousSend, and dropping them after a send that may have
            // reached the network invites a second anchor for the same payload.
            if(lastErr && lastErr.anchorAmbiguousSend){
                this.spendGuard.commit(token);
                throw lastErr;
            }
            this.spendGuard.release(token);       // this attempt never went out
            let err = new Error(this.spendGuard.noteBlocked() + '; skipping remaining broadcasts this flush');
            err.spendBlocked = true;
            throw err;
        }
    },

    // No confirmed input to build from. Pre-send, nothing was signed or
    // sent, and a 2.5 s retry cannot confirm an output; surface it as the
    // deferral it is instead of burning the attempt budget on it.
    releaseOnUnfundedBuild(e, token){
        if(e && e.anchorNoConfirmedUtxo){
            this.spendGuard.release(token);   // pre-send; nothing left the hub
            throw e;
        }
    },

    // After an ambiguous send, poll the caller's existence check a bounded number of
    // times; the mined anchor when one appears, else null.
    async pollAmbiguousSend(existsCheck){
        for(let p = 0; p < this.ambiguousPollAttempts; p++){
            await new Promise(r => setTimeout(r, this.ambiguousPollDelayMs));
            let found = null;
            try { found = await existsCheck(); } catch(_e){ found = null; }
            if(found && found.exists){
                logger.info('StateAnchorPublisher: ambiguous send confirmed on-chain (txid ' +
                            (found.txid || '?') + '); adopting');
                return found;
            }
        }
        return null;
    },

    // Encoder rate limiting. Safe to retry by the shared classifier's own
    // rule: a sub-500 response is a definitive refusal, so nothing reached
    // the coin node and no double spend is possible. The reservation was
    // taken once at method entry and covers the whole call, so a free
    // retry here re-charges nothing.
    // The wait to honour before the next attempt, null when `e` is not a rate limit;
    // throws `e` once the per-broadcast wait budget is spent.
    rateLimitRetryDelay(e, rateLimitWaits, token){
        let rlWaitMs = this.rateLimitWaitMs(e);
        if(rlWaitMs === null) return null;
        if(rateLimitWaits >= this.rateLimitMaxWaits){
            this.spendGuard.release(token);   // definitive refusal; never sent
            throw e;
        }
        logger.warn('StateAnchorPublisher: encoder rate-limited the anchor broadcast; ' +
                     'waiting ' + rlWaitMs + 'ms (Retry-After honoured, capped at ' +
                     this.rateLimitMaxWaitMs + 'ms), ' +
                     (this.rateLimitMaxWaits - rateLimitWaits - 1) + ' rate-limit wait(s) left ' +
                     'before this anchor defers to a later flush');
        return rlWaitMs;
    },

    // Sleep indirection so the retry paths above are testable without real waits
    // (the test tree's blind-sleep gate rejects fixed waits in tests).
    async _sleep(ms){
        return new Promise(r => setTimeout(r, ms));
    },

    // Rate-limit wait for a failed encoder call, or null when the error is not a
    // rate limit. Reads the encoder's own signal rather than guessing a curve: the
    // per-IP limiter and the concurrency gate both answer 429/-32029 but want waits
    // ~60x apart. A missing or unparseable header falls back to the flat retry delay
    // (still a wait, never an unbounded one), and every result is clamped.
    rateLimitWaitMs(e){
        if(!e) return null;
        let status = e.response ? Number(e.response.status) : NaN;
        if(status !== 429 && Number(e.rpcCode) !== -32029) return null;
        let headers = (e.response && e.response.headers) || {};
        let raw = headers['retry-after'];
        if(raw === undefined) raw = headers['Retry-After'];
        let ms = parseRetryAfterMs(raw);
        if(ms === null) ms = this.chunkRetryDelayMs;
        let cap = Number(this.rateLimitMaxWaitMs);
        if(!Number.isFinite(cap) || cap < 0) cap = 60000;
        return Math.min(Math.max(ms, 0), cap);
    },

    // ----- Landing: confirmation watchdog over our own broadcasts -----

    startConfirmationWatchdog(){
        if(this._confirmTimer) return;
        if(!this.confirmCheckIntervalMs) return;
        this._confirmTimer = setInterval(() => {
            this.checkPublishedConfirmations().catch(e =>
                logger.warn('StateAnchorPublisher: confirmation watchdog tick failed: ' + (e && e.message)));
        }, this.confirmCheckIntervalMs);
        if(this._confirmTimer.unref) this._confirmTimer.unref();
    },

    // Record a broadcast as awaiting confirmation. A broadcaster that returns no
    // txid cannot be watched, so it is not tracked: an untrackable send must not
    // masquerade as a stalled one. Adopted (already-mined) anchors are not sent here.
    notePendingConfirmation(kind, txid, ref){
        if(!txid) return;
        let key = String(txid).toLowerCase();
        if(this._pendingConfirmations.has(key)) return;
        this._pendingConfirmations.set(key, { txid: key, kind: kind, ref: ref, sentAt: Date.now() });
        while(this._pendingConfirmations.size > this.pendingConfirmationsMax){
            let oldest = this._pendingConfirmations.keys().next().value;
            this._pendingConfirmations.delete(oldest);
        }
    },

    // One watchdog pass. Resolves what has landed and leaves the rest ageing.
    // Two shapes count as landed, because the publisher spends only its own address:
    //   - the transaction's own change output is in the set at depth 1 or deeper
    //   - the transaction is absent from the set while some output IS confirmed: its
    //     change was spent by a descendant, and a confirmed output at this address
    //     cannot descend from an unmined ancestor
    // Everything else stays pending, which is exactly the stuck case. Fail soft end
    // to end: nothing here throws, blocks publishing, re-broadcasts, or spends.
    async checkPublishedConfirmations(){
        if(this._pendingConfirmations.size === 0) return;
        let summary = null;
        try { summary = await this.readUtxoReserve(); } catch(e){ summary = null; }
        if(!summary || !summary.known){ this.confirmationCheckFailures++; return; }
        this.lastConfirmationCheckAt = Date.now();
        for(let entry of Array.from(this._pendingConfirmations.values())){
            let depth = summary.byTxid.get(entry.txid);
            if(depth !== undefined){
                if(depth >= 1){ this._pendingConfirmations.delete(entry.txid); this.confirmedPublishes++; }
                continue;
            }
            if(summary.confirmed > 0){ this._pendingConfirmations.delete(entry.txid); this.confirmedPublishes++; }
        }
        let oldest = this.oldestUnconfirmedPublish();
        if(oldest && oldest.ageMs >= this.confirmStaleMs){
            logger.warn('StateAnchorPublisher: UNCONFIRMED_ANCHOR - ' + this._pendingConfirmations.size +
                         ' broadcast(s) have never been seen confirmed; oldest is ' + oldest.kind + ' ' + oldest.ref +
                         ' txid ' + oldest.txid + ' sent ' + Math.round(oldest.ageMs / 1000) + 's ago. ' +
                         'The publisher address holds ' + summary.confirmed + ' confirmed and ' +
                         summary.unconfirmed + ' unconfirmed output(s). Nothing is re-broadcast or fee-bumped ' +
                         'automatically; an operator decides how to unstick the transaction.');
        }
    },

    // The oldest broadcast still awaiting confirmation, or null. Cheap, in-memory,
    // and safe to call from getAnchorStats.
    oldestUnconfirmedPublish(){
        let oldest = null;
        for(let entry of this._pendingConfirmations.values()){
            if(!oldest || entry.sentAt < oldest.sentAt) oldest = entry;
        }
        if(!oldest) return null;
        return { txid: oldest.txid, kind: oldest.kind, ref: oldest.ref, sentAt: oldest.sentAt,
                 ageMs: Math.max(0, Date.now() - oldest.sentAt) };
    },

    // Classify a broadcast_tx failure: could the transaction have reached the
    // DOGE node despite the error? Definitive rejections (the encoder answered
    // with an RPC error, or an HTTP 4xx auth/rate-limit refusal) and
    // never-connected transport errors are safe to retry. Everything else
    // (timeout, reset mid-flight, 5xx after the request went out) is ambiguous.
    // Delegates to the shared classifier so all four hub effectors agree.
    isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    },

    async checkBalance(signer){
        let balance = null;
        try {
            if(signer.getBalanceFn) balance = await signer.getBalanceFn();
            else if(signer.encoder && this.dogeAddress){
                // get_utxos reports satoshis; lowBalanceThreshold, the fail-closed
                // flush gate and spendGuard.minBalance are all whole DOGE, so the
                // sum converts. Units and fallback order: lib/utxo_balance.js.
                let utxos = await signer.encoder.getUtxos(this.dogeAddress);
                if(Array.isArray(utxos)) balance = sumUtxosCoins(utxos);
            }
        } catch(e){ return null; }
        if(balance !== null){
            this._lastBalance   = balance;
            this._lastBalanceAt = Date.now();
        }
        if(balance !== null && balance < this.lowBalanceThreshold)
            logger.warn('StateAnchorPublisher: DOGE balance LOW (' + Number(balance).toFixed(4) + ' DOGE)');
        return balance;
    }

};
