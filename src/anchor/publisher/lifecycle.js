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
 * ANCHOR publisher - lifecycle and flush
 *
 * Start and stop, the operator stats block, and the flush that runs one
 * publishing pass: drain the deferred queues, prove a pipeline, a balance and a
 * confirmed input, then hand the work to the bundle and archive legs.
 *
 ********************************************************************/

'use strict';

const { summarizeUtxoConfirmations } = require('../../lib/utxo_balance.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Operator-facing stats. Exposed here so callers (hub RPC, status routes)
    // can surface cumulative archive health without grepping logs.
    getAnchorStats(){
        return {
            enabled:            this.enabled,
            anchorsPublished:   this._anchorsPublished,
            // Chains carried by those bundles, and bundles refused for exceeding the
            // 8189-byte budget. sectionsAnchored climbing at the same rate as
            // anchorsPublished means the federation is anchoring ONE chain per cycle,
            // not a bundle; bundlesOversize non-zero means a checkpoint is not on chain
            // at all and the signer count or the section width has to come down.
            sectionsAnchored:   this._sectionsAnchored,
            bundlesOversize:    this._bundlesOversize,
            // Leader-vs-failover split of anchorsPublished plus the last anchor's
            // rank posture. anchorsAsBackup climbing (or lastAnchorRank.isLeader
            // false) is the only signal that the elected rank-0 publisher is dead
            // and the ladder is absorbing its work.
            anchorsAsLeader:    this._anchorsAsLeader,
            anchorsAsBackup:    this._anchorsAsBackup,
            // Stamped without paying. Holds anchorsAsLeader + anchorsAsBackup ==
            // anchorsPublished; lastAnchorRank.adopted names the most recent one.
            anchorsAdopted:     this._anchorsAdopted,
            lastAnchorRank:     this._lastAnchorRank,
            skippedNotOurElection: this._skippedNotOurElection,
            skippedLeaderOnWake:   this._skippedLeaderOnWake,
            startupFlushMs:        this.startupFlushMs,
            // Landing health. unconfirmedPublishes with an oldestUnconfirmedAgeMs in
            // the hours is a stuck anchor; noConfirmedUtxoDeferrals climbing while
            // unconfirmedUtxos is non-zero is the wallet trapped behind it.
            allowUnconfirmedInputs:   this.allowUnconfirmedInputs,
            leaderRetryDue:           this._leaderRetryDue,
            noConfirmedUtxoDeferrals: this.noConfirmedUtxoDeferrals,
            lastNoConfirmedUtxoAt:    this.lastNoConfirmedUtxoAt,
            unattestedDeferrals:      this.unattestedDeferrals,
            lastUnattestedDeferralAt: this.lastUnattestedDeferralAt,
            confirmedUtxos:           this.lastUtxoReserve ? this.lastUtxoReserve.confirmed   : null,
            unconfirmedUtxos:         this.lastUtxoReserve ? this.lastUtxoReserve.unconfirmed : null,
            unconfirmedPublishes:     this._pendingConfirmations.size,
            oldestUnconfirmedPublish: this.oldestUnconfirmedPublish(),
            confirmedPublishes:       this.confirmedPublishes,
            confirmationCheckFailures: this.confirmationCheckFailures,
            lastConfirmationCheckAt:  this.lastConfirmationCheckAt,
            archiveChunkLosses: this._archiveChunkLosses,
            anchorMarkerRetentionMs: this.anchorMarkerRetentionMs,
            anchorMarkersPruned:     this.anchorMarkersPruned,
            // Publisher-wallet runway: last-observed DOGE balance, its age, and the
            // low-balance threshold the publisher already warns at. dogeBalance is
            // null until the first flush reads it (or when no DOGE pipeline is set).
            dogeAddress:        this.dogeAddress || null,
            dogeBalance:        this._lastBalance,
            dogeBalanceAt:      this._lastBalanceAt,
            lowBalanceThreshold: this.lowBalanceThreshold,
            spendGuard:         this.spendGuard.stats()
        };
    },

    // Fill any indexer URL left empty at construction (configs-table-
    // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
    // configs-aware resolver, so anchor on-chain verification reaches the
    // indexer instead of returning 'no-indexer' on a standard hub.
    async resolveMissingIndexerUrls(){
        if(this.hub && typeof this.hub.resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub.resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
    },

    // Listen to the peer wire and to the two engines whose finalized rows fill an
    // archive, so a full batch flushes on size rather than waiting out the interval.
    subscribeToAnchorSources(){
        this.listenToPeers();
        if(this.hub.crossChainDex){
            this._matchHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: size-trigger flush error:', err && err.message)));
            };
            // Engine-level event; fires after the match row is written (the archive
            // round reads cross_chain_matches), unlike the consensus-level event.
            this.hub.crossChainDex.on('match:finalized', this._matchHandler);
        }
        if(this.hub.crossChainCalls){
            // XCALL relay rows share the size trigger: they ride the same archive.
            this._callHandler = () => {
                if(++this._pendingMatches >= this.batchSize)
                    this.flush().catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: size-trigger flush error:', err && err.message)));
            };
            this.hub.crossChainCalls.on('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.on('call:result',   this._callHandler);
        }
    },

    // The four cadences a running publisher keeps: the publishing interval, the much
    // shorter deferred-announcement drain, the failover wake and the one-shot startup
    // catch-up. Every handle is unref'd, so none of them holds the process open.
    startFlushTimers(){
        this._timer = setInterval(() => {
            this.flush().catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: interval flush error:', err && err.message)));
        }, this.intervalMs);
        if(this._timer.unref) this._timer.unref();
        // Separate, much shorter cadence than the (daily by default) flush: a queued
        // BUNDLE_DONE has to be re-checked on the order of the DOGE confirmation window,
        // not the anchor publishing window.
        this._deferTimer = setInterval(() => {
            this.drainDeferredBundleDone().catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: deferred BUNDLE_DONE drain error:', err && err.message)));
            this.drainDeferredFinalized().catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: deferred FINALIZED drain error:', err && err.message)));
            this.drainDeferredRewardAttest().catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: deferred reward-attestation drain error:', err && err.message)));
        }, this.announceRetryMs);
        if(this._deferTimer.unref) this._deferTimer.unref();
        // The failover wake. Re-runs flush in failover-only mode so a
        // backup notices its rank unlocking between the (daily by default) ticks
        // instead of leaving a dead leader's work stranded for a whole cycle.
        this._rankWakeTimer = setInterval(() => {
            this.flush(this.wakeFlushOpts())
                .catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: failover-wake flush error:', err && err.message)));
        }, this.rankWakeMs);
        if(this._rankWakeTimer.unref) this._rankWakeTimer.unref();
        this.startConfirmationWatchdog();
        // The startup catch-up flush (see startupFlushMs). A NORMAL flush, not a
        // wake: the point is to run the one leader pass a restart otherwise defers
        // by a whole interval.
        if(this.startupFlushMs > 0){
            this._startupTimer = setTimeout(() => {
                this._startupTimer = null;
                this.flush().catch(err => logger.error(nodeUtil.format('StateAnchorPublisher: startup flush error:', err && err.message)));
            }, this.startupFlushMs);
            if(this._startupTimer.unref) this._startupTimer.unref();
        }
    },

    async start(){
        if(!this.enabled){ logger.info('StateAnchorPublisher: disabled (ANCHOR_ENABLED=false)'); return; }
        // The per-window spend ceilings were memory-only, so every restart
        // restored a full allowance. Reload the saved window before anything anchors.
        this.spendGuard.persistTo();
        await this.resolveMissingIndexerUrls();
        this.subscribeToAnchorSources();
        this.startFlushTimers();
        logger.info('StateAnchorPublisher started (interval ' + this.intervalMs + 'ms, startup flush ' +
                    (this.startupFlushMs > 0 ? 'in ' + this.startupFlushMs + 'ms' : 'off') +
                    ', batch ' + this.batchSize + ', address ' + (this.dogeAddress || '<unset>') + ')');
    },

    async stop(){
        if(this._timer){ clearInterval(this._timer); this._timer = null; }
        if(this._deferTimer){ clearInterval(this._deferTimer); this._deferTimer = null; }
        if(this._rankWakeTimer){ clearInterval(this._rankWakeTimer); this._rankWakeTimer = null; }
        if(this._startupTimer){ clearTimeout(this._startupTimer); this._startupTimer = null; }
        if(this._confirmTimer){ clearInterval(this._confirmTimer); this._confirmTimer = null; }
        this.stopListeningToPeers();
        if(this._matchHandler && this.hub.crossChainDex){
            this.hub.crossChainDex.removeListener('match:finalized', this._matchHandler);
            this._matchHandler = null;
        }
        if(this._callHandler && this.hub.crossChainCalls){
            this.hub.crossChainCalls.removeListener('call:dispatch', this._callHandler);
            this.hub.crossChainCalls.removeListener('call:result',   this._callHandler);
            this._callHandler = null;
        }
        if(this._archiveRound && this._archiveRound.timer) clearTimeout(this._archiveRound.timer);
        this._archiveRound = null;
        // A publish in flight at teardown cannot be waited on here, but leaving the guard
        // set would refuse every round after a restart of the publisher on this instance.
        this._archivePublishing = null;
        if(this._attestRound && this._attestRound.timer) clearTimeout(this._attestRound.timer);
        if(this._attestRound && !this._attestRound.done && this._attestRound.resolve)
            this._attestRound.resolve({ met: false, sigs: [] });   // unblock any awaiting publish
        this._attestRound = null;
        // Mirror the _attestRound teardown for its archive twin: runArchiveAttestationRound
        // is an awaited promise settled only by an unref'd timer, so without this a stop()
        // mid-round leaves publishArchive hung during shutdown.
        if(this._archiveAttestRound && this._archiveAttestRound.timer) clearTimeout(this._archiveAttestRound.timer);
        if(this._archiveAttestRound && !this._archiveAttestRound.done && this._archiveAttestRound.resolve)
            this._archiveAttestRound.resolve({ met: false, sigs: [] });   // unblock any awaiting publishArchive
        this._archiveAttestRound = null;
    },

    // Flush: publish pending v0 checkpoints + the pending archive batch.
    // Returns a summary (also served by the hub's `anchorflush` RPC):
    // { anchored: [{chain, network, block_index, txid}], archive: 'published'|
    //   'round_started'|'none', skipped: 'already_flushing'|'no_pipeline'? }
    // opts.failoverOnly: publish only what this hub is a BACKUP for,
    // i.e. elections it does not lead but whose failover rank has unlocked. The
    // failover wake passes it so re-checking the ladder between interval ticks
    // cannot turn into a higher anchoring cadence for a healthy leader; every
    // other caller (interval, size triggers, tests) leaves it off and behaves
    // exactly as before.
    // What the rank wake should run this tick. Failover-only in the steady state;
    // a normal flush exactly while a confirmed-input deferral is outstanding, so
    // the led row it stood down from is retried in minutes rather than a day.
    wakeFlushOpts(){
        return { failoverOnly: !this._leaderRetryDue };
    },

    // Record a stand-down for want of a confirmed input. Counted, timestamped,
    // and armed for the next wake; never thrown past the flush.
    noteNoConfirmedUtxo(what){
        this.noConfirmedUtxoDeferrals++;
        this.lastNoConfirmedUtxoAt = Date.now();
        this._leaderRetryDue = true;
        let seen = this.lastUtxoReserve || { unconfirmed: 0 };
        logger.warn('StateAnchorPublisher: NO_CONFIRMED_UTXO - every one of the ' + seen.unconfirmed +
                     ' spendable output(s) at ' + this.dogeAddress + ' is unconfirmed (change trapped behind ' +
                     'an unconfirmed chain); deferring ' + what + ', retried on the next rank wake once an output confirms');
    },

    // Read the publisher address's UTXO set and summarize it, or null when the set
    // cannot be read. FAIL SOFT, unlike the balance gate: this reading only ever
    // withholds a broadcast, so an unreachable encoder must leave the decision to the
    // guards that already fail closed rather than add a second way to stall publishing.
    async readUtxoReserve(signer){
        signer = signer || this.resolveSigner();
        if(!signer.encoder || !this.dogeAddress) return null;
        let utxos;
        try { utxos = await signer.encoder.getUtxos(this.dogeAddress); }
        catch(err){
            logger.warn('StateAnchorPublisher: UTXO reserve check failed (confirmation state unknown this pass; ' +
                         'publishing is not blocked on it): ' + (err && err.message));
            return null;
        }
        if(!Array.isArray(utxos)) return null;
        let summary = summarizeUtxoConfirmations(utxos, 1);
        this.lastUtxoReserve = { total: summary.total, confirmed: summary.confirmed,
                                 unconfirmed: summary.unconfirmed, known: summary.known, at: summary.at };
        return summary;
    },

    // May a flush build a wire right now? False only for the one provable
    // condition: the address holds outputs, their confirmation state is known, and
    // NOT ONE of them is confirmed. Under confirmed-inputs-only that wallet cannot
    // fund anything; under the escape hatch it is not our call.
    async confirmedUtxoAvailable(signer){
        if(this.allowUnconfirmedInputs) return true;
        let summary = await this.readUtxoReserve(signer);
        if(!summary)             return true;   // unreadable: not our call to block
        if(!summary.known)       return true;   // no confirmations field served
        if(summary.total === 0)  return true;   // empty wallet is the balance gate's call
        return summary.confirmed > 0;
    },

    // Drain queued peer announcements, the first thing a flush does, so a checkpoint
    // another hub already anchored is stamped before this flush's failover-rank check
    // would re-anchor it (the whole point of the suppression signal). Never let a drain
    // error abort the flush: the queue is bookkeeping, publishing is the job.
    async drainDeferredAnnouncements(){
        await this.drainDeferredBundleDone()
            .catch(err => logger.warn('StateAnchorPublisher: deferred BUNDLE_DONE drain error: ' + (err && err.message)));
        await this.drainDeferredFinalized()
            .catch(err => logger.warn('StateAnchorPublisher: deferred FINALIZED drain error: ' + (err && err.message)));
        await this.drainDeferredRewardAttest()
            .catch(err => logger.warn('StateAnchorPublisher: deferred reward-attestation drain error: ' + (err && err.message)));
    },

    // The reason this flush must not publish, as the summary flush returns, or null
    // when it may. Every gate here is fail-closed and leaves the rows pending.
    async flushRefusal(signer){
        if(!signer.broadcastFn && !(signer.encoder && signer.walletSignFn)){
            if(!this._loggedNoPipeline){
                logger.warn('StateAnchorPublisher: no DOGE broadcast pipeline configured; anchors deferred (set DOGE_ENCODER_URL + a wallet-sign hook)');
                this._loggedNoPipeline = true;
            }
            return { anchored: [], archive: 'none', skipped: 'no_pipeline' };
        }
        // Hard pre-send balance gate. The balance is enforced, not just logged: a low
        // balance that only WARNed would let a fee-estimation bug or a stuck-tx retry
        // loop drain the wallet with nothing but a log line. A balance below the floor,
        // or an unreadable balance (null; fail-closed), skips this flush's publishing.
        // The scheduler keeps running and retries on the next flush once the wallet
        // is topped up / the balance source recovers.
        let balance = await this.checkBalance(signer);
        // The gate is only meaningful when a balance source is actually wired
        // (a getBalanceFn hook, or an encoder + address to sum UTXOs). With no
        // source, balance is always null and there is nothing to enforce, so we
        // preserve prior behavior rather than disable publishing outright.
        let hasBalanceSource = !!(signer.getBalanceFn || (signer.encoder && this.dogeAddress));
        if(hasBalanceSource){
            if(balance === null){
                logger.warn('StateAnchorPublisher: DOGE balance unreadable; skipping this flush (fail-closed)');
                return { anchored: [], archive: 'none', skipped: 'balance_unreadable' };
            }
            if(balance < this.lowBalanceThreshold){
                logger.warn('StateAnchorPublisher: DOGE balance ' + Number(balance).toFixed(4) + ' below floor ' +
                             this.lowBalanceThreshold + '; skipping publish this flush (fail-closed)');
                return { anchored: [], archive: 'none', skipped: 'below_balance_floor' };
            }
        }
        // Confirmed-UTXO reserve. A balance above the floor says nothing about
        // whether it can be SPENT INTO A MINEABLE WIRE: after an anchor that never
        // confirms, the whole balance is change sitting unconfirmed behind it.
        // Defer the flush instead of building on it; rows stay pending, no marker
        // is armed, no intent is recorded, and the next wake retries as a normal
        // flush. Fail soft, see confirmedUtxoAvailable.
        if(!(await this.confirmedUtxoAvailable(signer))){
            this.noteNoConfirmedUtxo('this flush');
            return { anchored: [], archive: 'none', skipped: 'no_confirmed_utxo' };
        }

        // Shared SpendGuard gate on the PRIMARY anchor path. A runtime
        // pause (per-capability) or an exhausted per-window spend ceiling skips
        // this flush's on-chain publishing entirely; the scheduler retries next
        // flush. Placed after the balance gate so a paused publisher never spends
        // on the leader path (the fe3aedbf kill-switch was inert on the primary
        // path; this closes it).
        if(this.spendGuard.isPaused()){
            logger.warn(this.spendGuard.noteBlocked() + '; skipping this flush');
            return { anchored: [], archive: 'none', skipped: 'paused' };
        }
        if(!this.spendGuard.allow()){
            logger.warn(this.spendGuard.noteBlocked() + '; skipping this flush');
            return { anchored: [], archive: 'none', skipped: 'spend_ceiling' };
        }
        return null;
    },

    async flush(opts){
        let failoverOnly = !!(opts && opts.failoverOnly);
        if(this._flushing) return { anchored: [], archive: 'none', skipped: 'already_flushing' };
        this._flushing = true;
        // A normal flush is the retry a deferral was waiting for; it re-arms below
        // only if it defers again.
        if(!failoverOnly) this._leaderRetryDue = false;
        try {
            await this.drainDeferredAnnouncements();
            let btcBlock = this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
            let signer   = this.resolveSigner();
            let refused  = await this.flushRefusal(signer);
            if(refused) return refused;

            let anchored = await this.publishPendingCheckpoints(signer, btcBlock, failoverOnly);
            let archive  = await this.startArchiveRound(signer, btcBlock, failoverOnly);
            // Bound the durable marker tables. Runs at the end of a flush that actually
            // reached the publishing stage, so it never fires on a hub that is paused,
            // out of balance or without a pipeline, and never before the intents this
            // flush armed are settled.
            this.sweepAnchorMarkerRetention();
            return { anchored: anchored, archive: archive };
        } catch(e){
            logger.error(nodeUtil.format('StateAnchorPublisher: flush failed:', e && e.message));
            return { anchored: [], archive: 'none', error: e && e.message };
        } finally {
            this._flushing = false;
        }
    }

};
