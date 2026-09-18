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
 * AttestationBatchPublisher: the periodic on-chain carrier for finalized ATTEST
 * responses (the ATTEST response-mirror design, §6).
 *
 * WHAT IT IS FOR. Above the mirror activation height a response never becomes its
 * own transaction: it is written to `attestation_responses`, gossiped to the
 * federation and streamed to every indexer. That leaves exactly one obligation the
 * mirror cannot discharge: full history must stay reconstructible from chain parse.
 * So every terminal response body also lands on chain, once per window, as an
 * ATTEST v5 head plus v6 continuations on the DOGE rail. A node that replays the
 * chain rebuilds the mirror table from those batches and re-derives every callback
 * without trusting any hub.
 *
 * EVERY WINDOW PUBLISHES, INCLUDING AN EMPTY ONE. A `row_count 0` head costs one
 * small transaction an hour and is what makes coverage PROVABLE rather than
 * assumed: a chain-only node finds a head for every window, instead of having to
 * believe that a silent hour carried nothing.
 *
 * IT SHARES NO STATE WITH PRICE OR ANCHOR. This is the third consumer of the one
 * operator signer, wallet and spend guard, and the OraclePublisher pattern it
 * copies is copied deliberately rather than reused: its own buffer file, its own
 * dead-letter file, its own durable marker table, its own spend-guard prefix. A
 * shared queue would let a stuck PRICE batch hold up attestation coverage, which is
 * the coupling §6.2 exists to forbid.
 *
 * THE WINDOW IS WALL-CLOCK HOURLY, ALIGNED TO THE UNIX HOUR, and deliberately NOT
 * the PRICE window, which counts ROUNDS and is resized against the fee-staleness
 * bound. Coupling attestation coverage to a number that moves for unrelated reasons
 * would move a chain-only node's coverage proof with it. The regtest-only override
 * seam lives beside the response forward margin's, in lib/attest_response_timing.js.
 *
 * MEMBERSHIP IS KEYED ON THE SIGNED effective_time, never on finalized_at. The
 * effective time is inside the bytes the responsible set signed, so every hub holding
 * a row reads the same value and partitions the boundary identically; finalized_at is
 * per-hub wall clock the schema explicitly allows two hubs to disagree on, and two
 * hubs disagreeing about which side of a boundary one row falls on costs the window
 * its quorum. The signed key also carries its own completeness deadline: a row's
 * effective time is its leader's clock plus the forward margin, so the row is written
 * a whole forward margin before the window containing it can close.
 *
 * THE SIGNATURES ARE THE BATCH'S OWN. A batch carries ONE quorum signature set over
 * the batch canonical, collected here through a leader/follower round modelled on
 * the XPRICEB round in OracleBatchSigner: the leader assembles bytes, and every
 * co-signer independently rebuilds them from its OWN mirror rows before signing, so
 * a leader cannot obtain signatures for fabricated content and the worst it can do
 * is fail to reach quorum. The set is the `attestation` capability set at the
 * batch's BTC anchor, which is the set the DOGE indexer resolves the wire against.
 * These bytes are NOT the per-response signatures: those ride inside each row, so a
 * batch-fed node's `attests` rows are byte-identical to a mirror-fed node's.
 *
 * WHY THE FOLLOWER BOUNDS THE ANCHOR INSTEAD OF RE-DERIVING IT. The PRICE batch
 * derives its anchor from the last round's own signed anchor. A response window has
 * no such field, and two honest hubs never hold the same chain tip, so a follower
 * that re-derived would refuse every proposal. It bounds instead, exactly as an
 * ATTEST response follower bounds the leader's effective_time: the anchor must be a
 * height the follower can already see, and no further behind its tip than one day
 * of blocks.
 *
 * ONE PUBLISHER PER WINDOW, WITH A STAGGERED FALLBACK. Five hubs holding the same
 * rows would otherwise pay five DOGE fees for five identical batches, so the
 * publisher is elected by hash order over the same capability set, keyed on the
 * batch key. A window nobody has landed after N further windows is picked up by
 * rank N, which is what keeps a dark leader from costing the window its coverage
 * forever.
 *
 ********************************************************************/

'use strict';

// This file keeps the class: construction, the lifecycle, the window clock and the
// sweep. Everything else lives in named parts under ./batch_publisher/ and is
// installed on the prototype below, so every require path and method name is
// exactly what it was.
const fs   = require('fs');
const path = require('path');

// The mirror flag-day map is a registry row read by literal key (W5).
const gateRegistry = require('../consensus/gate_registry');
const ATTEST_RESPONSE_MIRROR_KEY = 'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION';
const { resolveAttestBatchWindowS, ATTEST_BATCH_WINDOW_S } = require('./attest_response_timing.js');
const { initBatchFiles, initBatchTimeouts, initBatchRuntime } = require('./batch_publisher/options.js');
const windows   = require('./batch_publisher/window.js');
const anchor    = require('./batch_publisher/anchor.js');
const signing   = require('./batch_publisher/signing.js');
const broadcast = require('./batch_publisher/broadcast.js');
const markers   = require('./batch_publisher/markers.js');
const { XATTESTB_SIGN_REQ, XATTESTB_SIGN, MAX_CATCHUP_WINDOWS,
        ANCHOR_MAX_LAG_BLOCKS } = require('./batch_publisher/constants.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');
const logger = getLogger();

class AttestationBatchPublisher {

    constructor(hub){
        this.hub      = hub;
        this.db       = hub ? hub.db : null;
        this.network  = (hub && hub.network) ? String(hub.network) : '';
        this.identity = (hub && hub.getIdentity) ? hub.getIdentity() : null;

        let cfg = (hub && hub.p2pConfig) ? hub.p2pConfig : {};
        this.cfg = cfg;

        // Throws on a malformed regtest override, deliberately: a window resolved to
        // NaN would align every boundary to NaN and publish nothing, silently.
        this.windowS = resolveAttestBatchWindowS(this.network, cfg);

        // Operator kill switch, the ORACLE_PUBLISH_ENABLED shape: a first-class lever
        // to halt outbound DOGE spend during an incident without tearing down the
        // pipeline's configuration. A halted publisher skips windows rather than
        // buffering them, so re-enabling it does not flood the rail.
        this.enabled = String(hubConfig.ATTEST_BATCH_PUBLISH_ENABLED ||
                              cfg.ATTEST_BATCH_PUBLISH_ENABLED || 'true') !== 'false';

        // Construction in named steps, in the order the fields were assigned before the
        // split (src/attestation/batch_publisher/options.js).
        initBatchFiles(this, cfg);
        initBatchTimeouts(this, cfg);
        initBatchRuntime(this);
    }

    // ------------------------------------------------------------ wiring

    setBroadcastHook(fn){ this.broadcastFn = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setBalanceHook(fn){ this.getBalanceFn = fn; }

    // The mirror has to be ARMED on this network for the batch to mean anything: below
    // an unratified (null) activation entry no response ever becomes a mirror row, so a
    // batch would publish an empty head every hour for a table that is empty by design.
    // Read off the activation map itself rather than off a height, because the window
    // is a clock and has no block to evaluate the height gate against.
    isArmedNetwork(){
        let entry = gateRegistry.get(ATTEST_RESPONSE_MIRROR_KEY)[this.network];
        return entry !== null && entry !== undefined;
    }

    async start(){
        if(!this.isArmedNetwork()){
            logger.info('AttestationBatchPublisher: response mirror unarmed on ' +
                        (this.network || '<unset>') + '; not scheduling batch windows');
            return;
        }

        // Reload the persisted spend window before anything can publish; a restart that
        // restored a full allowance would let one incident spend the ceiling twice.
        this.spendGuard.persistTo();

        try {
            fs.mkdirSync(path.dirname(this.bufferPath), { recursive: true });
        } catch(e){
            logger.warn('AttestationBatchPublisher: cannot create the buffer directory ' +
                         path.dirname(this.bufferPath) + ': ' + (e && e.message));
        }

        // Quarantine before scheduling, never after: the sweep below must not consider a
        // window whose on-chain state a crash left unknown. The floor comes from the same
        // read, because both answers are about what this hub has already resolved.
        try {
            await this.hydrateMarkers();
            this._floorWindow = await this.resolveFloorWindow();
        } catch(e){
            logger.error('AttestationBatchPublisher: could not hydrate durable batch markers ' +
                          '(publishing is deferred until they read): ' + (e && e.message));
        }

        let pm = this.hubPeerManager();
        if(pm && typeof pm.on === 'function'){
            this._peerHandler = (envelope) => this.handleMessage(envelope);
            pm.on('message', this._peerHandler);
        }

        this._running = true;
        this.armWindowTimer();
        logger.info('AttestationBatchPublisher started (network: ' + this.network +
                    ', window: ' + this.windowS + 's' +
                    (this.windowS === ATTEST_BATCH_WINDOW_S ? '' : ' [regtest override]') +
                    ', address: ' + (this.dogeAddress || '<unset>') + ')');
    }

    stop(){
        this._running = false;
        if(this._windowTimer){ clearTimeout(this._windowTimer); this._windowTimer = null; }
        let pm = this.hubPeerManager();
        if(pm && this._peerHandler && typeof pm.removeListener === 'function')
            pm.removeListener('message', this._peerHandler);
        this._peerHandler = null;
        if(this._signRound){
            if(this._signRound.timer) clearTimeout(this._signRound.timer);
            if(!this._signRound.done){
                this._signRound.done = true;
                this._signRound.resolve({ met: false, sigs: [] });
            }
            this._signRound = null;
        }
    }

    hubDb(){ return (this.hub && this.hub.db) || this.db; }
    hubPeerManager(){ return this.hub && this.hub.peerManager; }
    nowSeconds(){ return Math.floor(Date.now() / 1000); }

    // ------------------------------------------------------------ window math

    // The window a unix second falls in, as its INCLUSIVE start. Alignment is on the
    // unix epoch rather than on process start, so every hub in the federation closes
    // the same windows at the same instants without exchanging anything.
    windowStartFor(ts){
        let n = Math.floor(Number(ts) / this.windowS);
        return n * this.windowS;
    }

    // The window's EXCLUSIVE upper bound, which is the next window's start. Stated
    // once here because it is also half of the batch key preimage.
    windowEndFor(windowStart){
        return Number(windowStart) + this.windowS;
    }

    // Milliseconds from now to the next boundary. Never 0: a timer armed for the
    // instant of the boundary can fire a millisecond early on some runtimes and close
    // a window that has not ended, so the boundary is always in the future here.
    msToNextBoundary(nowMs){
        let now  = Number.isFinite(nowMs) ? nowMs : Date.now();
        let secs = now / 1000;
        let next = (Math.floor(secs / this.windowS) + 1) * this.windowS;
        return Math.max(1, Math.round(next * 1000 - now));
    }

    // Re-armed from inside its own callback rather than on an interval, because the
    // boundary is a wall-clock instant: an interval started mid-window drifts off it
    // and would close windows at arbitrary offsets on every hub.
    armWindowTimer(){
        if(this._windowTimer) clearTimeout(this._windowTimer);
        this._windowTimer = setTimeout(() => {
            this._windowTimer = null;
            this.sweep()
                .catch(e => logger.error('AttestationBatchPublisher: window sweep failed: ' + (e && e.message)))
                .then(() => { if(this._running) this.armWindowTimer(); });
        }, this.msToNextBoundary());
        // Never hold a process open for a publishing cadence: the windows a stopped hub
        // misses are picked up by the catch-up on its next start.
        if(typeof this._windowTimer.unref === 'function') this._windowTimer.unref();
    }

    // ------------------------------------------------------------ the sweep

    // Publish every closed window this hub still owes, oldest first. Serialized by
    // _sweeping: two concurrent passes would run two signing rounds through the one
    // round slot and each would see the other's quorum.
    async sweep(nowSec){
        if(this._sweeping) return { attempted: 0 };
        if(!this.enabled){
            logger.info('AttestationBatchPublisher: disabled (ATTEST_BATCH_PUBLISH_ENABLED=false); ' +
                        'skipping this window');
            return { attempted: 0 };
        }
        this._sweeping = true;
        let attempted = 0, published = 0;
        try {
            let now     = Number.isFinite(nowSec) ? Number(nowSec) : this.nowSeconds();
            let pending = await this.pendingWindows(now);
            for(let w of pending){
                attempted++;
                let done = await this.publishWindow(w.windowStart, w.age);
                if(done) published++;
            }
        } finally {
            this._sweeping = false;
        }
        return { attempted, published };
    }

    getStats(){
        return Object.assign({}, this.stats, {
            windowSeconds: this.windowS,
            enabled:       this.enabled,
            armed:         this.isArmedNetwork(),
            quarantinedWindows: this._quarantined.size,
            // Windows an earlier sweep walked past that are being caught up now. A count
            // that keeps rising is a publish path failing, not a busy federation.
            coverageGapWindows: this._coverageGaps.size,
            // Windows currently mid-retry after a provably-unsent head refusal, and the
            // bound they latch at. A count that sits at the bound is a refusal that is not
            // transient, and the CRITICAL line names it.
            refusalRetryWindows: this._refusalAttempts.size,
            maxRefusalAttempts:  this.maxRefusalAttempts,
            // Null unless the last anchor read failed. A rising windowsDeferred with a
            // reason here is a configuration gap, not a busy federation.
            anchorFailure: this._anchorFailure || null,
            // Which height source the last resolved anchor came from, or null.
            anchorSource:  this._anchorSource || null
        });
    }
}

// The parts are installed NON-ENUMERABLE, like the class methods beside them. An
// assigned mixin would be the only prototype member for...in and Object.keys could
// see, and what a prototype enumerates is behaviour rather than layout (the reasoning
// src/db/index.js records for the same install). Writable and configurable stay true,
// so a test can still stub a moved method and put it back, and a name two parts both
// claim is loud at load instead of last-one-wins.
function installParts(target, parts){
    for(const part of parts){
        for(const name of Object.keys(part)){
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('AttestationBatchPublisher: two parts define ' + name);
            Object.defineProperty(target, name,
                { value: part[name], writable: true, configurable: true, enumerable: false });
        }
    }
}

installParts(AttestationBatchPublisher.prototype, [windows, anchor, signing, broadcast, markers]);

module.exports = Object.assign(AttestationBatchPublisher, {
    XATTESTB_SIGN_REQ,
    XATTESTB_SIGN,
    MAX_CATCHUP_WINDOWS,
    ANCHOR_MAX_LAG_BLOCKS
});
