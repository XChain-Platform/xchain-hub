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
 * XChain Hub - Oracle Publisher: landing, not just sending: the confirmed-UTXO reserve and the watchdog
 *
 * Which inputs a wire may spend, what the address actually holds at depth, and
 * whether a broadcast ever reached a block. Nothing here spends: the reserve
 * withholds a wire and the watchdog reports, leaving a stuck package to the
 * operator.
 *
 ********************************************************************/

'use strict';

const { ENCODER_MAX_UTXO_COUNT } = require('../../lib/encoder_utxo_forward.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Confirmation depth at which the watchdog calls a broadcast landed. One block is
// the whole question here: the failure being watched for is a transaction that never
// mines at all, not a shallow one that could reorg out.
const CONFIRMED_DEPTH = 1;

module.exports = {

    // Which inputs create_tx may spend for the wire being built, as
    // { utxos, unconfirmed }. The caller still passes the array through
    // forwardableUtxos, so the encoder cap is applied in exactly one place.
    //
    // Default is the fetched set with unconfirmed spending refused, which is the
    // confirmed-inputs-only rule at the createTx call. The exception is narrow and
    // explicit: when this pass has already broadcast a wire, that wire's change is
    // added and unconfirmed spending allowed for it. Below ENCODER_MAX_UTXO_COUNT the
    // forwarded array IS the encoder's candidate set, so nothing else unconfirmed can
    // be selected and a third party's unconfirmed payment to this address stays
    // unspendable.
    //
    // Four conditions return the untouched default: the regtest escape hatch is on
    // (it already allows everything), the set is past the cap (the encoder then
    // fetches its own, which this filter cannot bound), the chain is at its depth
    // limit, or any output arrives without a readable confirmations field, since a
    // source that stops serving depth must never be read as "all unconfirmed".
    selectInputs(utxos) {
        let fallback = { utxos: utxos, unconfirmed: this.allowUnconfirmedInputs };
        if (this.allowUnconfirmedInputs)                        return fallback;
        if (!Array.isArray(utxos))                              return fallback;
        if (utxos.length > ENCODER_MAX_UTXO_COUNT)              return fallback;
        if (this._passSelfChange.size === 0)                    return fallback;
        if (this._passChainDepth >= this.selfChainMaxDepth)     return fallback;

        let confirmed = [];
        let ownChange = [];
        for (let u of utxos) {
            let conf = Number(u && u.confirmations);
            if (!Number.isFinite(conf) || conf < 0)             return fallback;
            if (conf >= CONFIRMED_DEPTH) { confirmed.push(u); continue; }
            if (u.txid && this._passSelfChange.has(String(u.txid))) ownChange.push(u);
        }
        if (ownChange.length === 0)                             return fallback;
        return { utxos: confirmed.concat(ownChange), unconfirmed: true };
    },

    // ----- Landing: confirmed-UTXO reserve -----

    // Split a get_utxos list by confirmation depth. `known` reports whether the
    // source served a usable confirmations field at all: an entry without one is
    // counted in `total` and in neither bucket, so a source that stops serving the
    // field reads as unknown rather than as "everything is unconfirmed".
    // byTxid holds the deepest confirmation seen per transaction, which is what the
    // watchdog matches a broadcast against.
    summarizeUtxos(utxos) {
        let summary = { total: 0, confirmed: 0, unconfirmed: 0, known: false,
                        byTxid: new Map(), at: Date.now() };
        for (let u of utxos) {
            if (!u || typeof u !== 'object') continue;
            summary.total++;
            let conf = Number(u.confirmations);
            if (!Number.isFinite(conf) || conf < 0) continue;
            summary.known = true;
            if (conf >= CONFIRMED_DEPTH) summary.confirmed++;
            else                         summary.unconfirmed++;
            let txid = u.txid ? String(u.txid) : null;
            if (!txid) continue;
            let seen = summary.byTxid.get(txid);
            if (seen === undefined || conf > seen) summary.byTxid.set(txid, conf);
        }
        return summary;
    },

    // Read the publisher address's UTXO set and summarize it, or null when the set
    // cannot be read. FAIL SOFT, unlike the balance gate: this reading only ever
    // withholds a broadcast, so an unreachable encoder must leave the decision to the
    // guards that already fail closed rather than add a second way to stall publishing.
    async readUtxoReserve() {
        if (!this.encoder || !this.dogeAddress) return null;
        let utxos;
        try {
            utxos = await this.encoder.getUtxos(this.dogeAddress);
        } catch (err) {
            logger.warn(nodeUtil.format('OraclePublisher: UTXO reserve check failed (confirmation state unknown ' +
                'this pass; publishing is not blocked on it): ', err));
            return null;
        }
        if (!Array.isArray(utxos)) return null;
        let summary = this.summarizeUtxos(utxos);
        this.lastUtxoReserve = { total: summary.total, confirmed: summary.confirmed,
                                 unconfirmed: summary.unconfirmed, known: summary.known,
                                 at: summary.at };
        return summary;
    },

    // May a publish pass build a wire right now? False only for the one provable
    // condition: the address holds outputs, their confirmation state is known, and
    // NOT ONE of them is confirmed. That means every spendable input is change
    // trapped behind an unconfirmed chain, so any wire built here inherits the stuck
    // package's fate: it either chains onto it and stalls the same way, or is refused
    // once the chain hits Dogecoin's inherited 25-transaction / 101 kB ancestor limits.
    // Deferring costs one window; broadcasting costs a fee for a wire that cannot mine.
    async confirmedUtxoAvailable() {
        let summary = await this.readUtxoReserve();
        if (!summary)                       return true;   // unreadable: not our call to block
        if (!summary.known)                 return true;   // no confirmations field served
        if (summary.total === 0)            return true;   // empty wallet is the balance gate's call
        return summary.confirmed > 0;
    },

    // ----- Landing: confirmation watchdog -----

    // Start watching broadcasts to confirmation. Unref'd so it never holds the process
    // open, and a no-op when the cadence is disabled or nothing could ever be read.
    startConfirmationWatchdog() {
        if (this._confirmTimer) return;
        if (!this.confirmCheckIntervalMs) return;
        if (!this.encoder || !this.dogeAddress) return;
        this._confirmTimer = setInterval(() => {
            this.checkPublishedConfirmations().catch((e) => {
                // Unreachable in practice (the check swallows its own faults); kept so a
                // future edit inside it can never reject into an unhandled rejection.
                logger.warn(nodeUtil.format('OraclePublisher: confirmation watchdog tick failed: ', e));
            });
        }, this.confirmCheckIntervalMs);
        if (this._confirmTimer.unref) this._confirmTimer.unref();
    },

    // Record a broadcast as awaiting confirmation. A broadcaster that returns no txid
    // cannot be watched, so it is not tracked: an untrackable send must not masquerade
    // as a stalled one.
    notePendingConfirmation(round, txid) {
        if (!txid) return;
        let key = String(txid);
        if (this._pendingConfirmations.has(key)) return;
        this._pendingConfirmations.set(key, { txid: key, round: round, sentAt: Date.now() });
        while (this._pendingConfirmations.size > this.pendingConfirmationsMax) {
            let oldest = this._pendingConfirmations.keys().next().value;
            this._pendingConfirmations.delete(oldest);
        }
    },

    // One watchdog pass. Resolves what has landed and leaves the rest ageing.
    //
    // Two shapes count as landed, because the publisher spends only its own address:
    //   - the transaction's own output is in the set at CONFIRMED_DEPTH or deeper
    //   - the transaction is absent from the set while some output IS confirmed: its
    //     change was spent by a descendant, and a confirmed output at this address
    //     cannot descend from an unmined ancestor
    // Everything else stays pending, which is exactly the stuck case: a package whose
    // change is still sitting unconfirmed in the mempool.
    //
    // Fail soft end to end. An unreadable encoder returns early with the tail intact,
    // and nothing here throws, blocks publishing, or spends.
    async checkPublishedConfirmations() {
        if (this._pendingConfirmations.size === 0) return;
        let summary;
        try {
            summary = await this.readUtxoReserve();
        } catch (e) {
            summary = null;
        }
        if (!summary || !summary.known) {
            this.confirmationCheckFailures++;
            return;
        }
        this.lastConfirmationCheckAt = Date.now();

        for (let entry of Array.from(this._pendingConfirmations.values())) {
            let depth = summary.byTxid.get(entry.txid);
            if (depth !== undefined) {
                if (depth >= CONFIRMED_DEPTH) {
                    this._pendingConfirmations.delete(entry.txid);
                    this.confirmedPublishes++;
                }
                continue;
            }
            if (summary.confirmed > 0) {
                this._pendingConfirmations.delete(entry.txid);
                this.confirmedPublishes++;
            }
        }

        let oldest = this.oldestUnconfirmedPublish();
        if (oldest && oldest.ageMs >= this.confirmStaleMs) {
            logger.warn('OraclePublisher: UNCONFIRMED_PUBLISH - ' + this._pendingConfirmations.size +
                ' broadcast(s) have never been seen confirmed; oldest is round ' + oldest.round +
                ' txid ' + oldest.txid + ' sent ' + Math.round(oldest.ageMs / 1000) + 's ago. ' +
                'The publisher address holds ' + summary.confirmed + ' confirmed and ' +
                summary.unconfirmed + ' unconfirmed output(s). Nothing is re-broadcast or fee-bumped ' +
                'automatically; an operator decides how to unstick the package.');
        }
    },

    // The oldest broadcast still awaiting confirmation, or null. Cheap, in-memory,
    // and safe to call from getStats.
    oldestUnconfirmedPublish() {
        let oldest = null;
        for (let entry of this._pendingConfirmations.values()) {
            if (!oldest || entry.sentAt < oldest.sentAt) oldest = entry;
        }
        if (!oldest) return null;
        return { txid: oldest.txid, round: oldest.round, sentAt: oldest.sentAt,
                 ageMs: Math.max(0, Date.now() - oldest.sentAt) };
    },

};
