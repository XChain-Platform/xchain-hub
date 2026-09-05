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

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const EncoderClient     = require('./EncoderClient.js');
const SpendGuard        = require('./lib/spend_guard.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const swq               = require('./stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { forwardableUtxos }  = require('./lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('./lib/two_phase_guard.js');
const { isAmbiguousSendError }   = require('./lib/idempotent_broadcast.js');
const { ATTEST_RESPONSE_MIRROR_ACTIVATION } = require('./attest_response_mirror_activation.js');
const snapWrite = require('./lib/capability_snapshot_write.js');
const { resolveAttestBatchWindowS, ATTEST_BATCH_WINDOW_S } = require('./lib/attest_response_timing.js');
const abw = require('./lib/attest_batch_wire.js');

// The two P2P envelope types this engine owns. There is no message-type registry on
// the hub: every engine subscribes to PeerManager's 'message' event and switches on
// envelope.type, so a new pair is one const each and one case each.
const XATTESTB_SIGN_REQ = 'XATTESTB_SIGN_REQ';
const XATTESTB_SIGN     = 'XATTESTB_SIGN';

// How many closed-but-unpublished windows one sweep will attempt. A hub returning
// to a long backlog drains it over several sweeps rather than in one pass, because
// each attempt holds the signing round for up to a full sign timeout and an
// unbounded catch-up would put the LIVE window behind every stale one.
const MAX_CATCHUP_WINDOWS = 4;

// How far behind its own tip a follower will accept a proposed batch anchor, in BTC
// blocks. Roughly one day: long enough that a hub whose chain view lags by hours
// still co-signs, short enough that a proposer cannot reach back to a height whose
// capability set it once controlled.
const ANCHOR_MAX_LAG_BLOCKS = 144;

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
        this.enabled = String(process.env.ATTEST_BATCH_PUBLISH_ENABLED ||
                              cfg.ATTEST_BATCH_PUBLISH_ENABLED || 'true') !== 'false';

        // Its OWN files, never the PRICE publisher's. The buffer records what a window
        // was built from at the moment it published, so an operator replaying a
        // dead-lettered or quarantined window has the content and does not have to
        // reconstruct it from a table that has since moved on.
        this.bufferPath = process.env.ATTEST_BATCH_BUFFER_PATH || cfg.ATTEST_BATCH_BUFFER_PATH ||
                          './data/attest-batch-buffer.jsonl';
        this.deadLetterPath = this.bufferPath.replace(/\.jsonl$/, '') + '.deadletter.jsonl';

        // Its OWN spend guard: a separate per-window ceiling and pause switch, so an
        // operator can halt attestation batches without halting price publishing.
        this.spendGuard = new SpendGuard('ATTEST_BATCH', cfg, 'AttestationBatchPublisher');

        // The one operator DOGE wallet, read from the same keys OraclePublisher reads:
        // there is one funded address and one signer module, and this is its third
        // consumer. Only the SPEND BUDGET is separate, never the wallet.
        this.dogeAddress   = process.env.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
        this.dogePubkeyHex = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD ||
                                              cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
        this.spendGuard.minBalance = this.lowBalanceThreshold;
        this.allowUnconfirmedInputs =
            String(process.env.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS ||
                   cfg.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS || 'false') === 'true';

        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        // The signing round reuses the PRICE batch signer's knobs (D76): the two rounds
        // have the same shape and the same failure mode, and a second family of timeout
        // names would be a second thing to drift.
        this.signTimeoutMs = parseInt(process.env.ORACLE_BATCH_SIGN_TIMEOUT_MS ||
                                      cfg.ORACLE_BATCH_SIGN_TIMEOUT_MS || '15000', 10);
        if(!Number.isFinite(this.signTimeoutMs) || this.signTimeoutMs <= 0) this.signTimeoutMs = 15000;

        this._windowTimer = null;
        this._peerHandler = null;
        this._signRound   = null;
        this._sweeping    = false;
        // Set by start() and cleared by stop(): the window timer re-arms itself from
        // inside its own callback, so this is what tells a landing sweep that the engine
        // it is re-arming has since been stopped.
        this._running     = false;
        // The oldest window a sweep will consider, resolved at start(). Null until then,
        // which means "no floor" and is what a directly driven sweep sees.
        this._floorWindow = null;
        // Windows this hub has already declined this process lifetime because
        // their durable marker is intent-only. Logged once each rather than once per
        // sweep, which on a short regtest window is once every few seconds.
        this._quarantined = new Set();
        // Why the last anchor read came back null, and which reason has already been
        // logged. Both null while the anchor resolves.
        this._anchorFailure = null;
        this._anchorWarned  = null;

        this.stats = {
            windowsPublished: 0, windowsEmpty: 0, windowsDeferred: 0,
            windowsDeadLettered: 0, windowsQuarantined: 0,
            wiresBroadcast: 0, rowsPublished: 0,
            signRounds: 0, signQuorums: 0, signTimeouts: 0,
            signaturesProvided: 0, signRefusals: 0, signRefusalsNoChainTip: 0,
            landedRecorded: 0, lastPublishedWindow: null, lastPublishedTxid: null
        };
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
        let entry = ATTEST_RESPONSE_MIRROR_ACTIVATION[this.network];
        return entry !== null && entry !== undefined;
    }

    async start(){
        if(!this.isArmedNetwork()){
            console.log('AttestationBatchPublisher: response mirror unarmed on ' +
                        (this.network || '<unset>') + '; not scheduling batch windows');
            return;
        }

        // Reload the persisted spend window before anything can publish; a restart that
        // restored a full allowance would let one incident spend the ceiling twice.
        this.spendGuard.persistTo();

        try {
            fs.mkdirSync(path.dirname(this.bufferPath), { recursive: true });
        } catch(e){
            console.warn('AttestationBatchPublisher: cannot create the buffer directory ' +
                         path.dirname(this.bufferPath) + ': ' + (e && e.message));
        }

        // Quarantine before scheduling, never after: the sweep below must not consider a
        // window whose on-chain state a crash left unknown. The floor comes from the same
        // read, because both answers are about what this hub has already resolved.
        try {
            await this._hydrateMarkers();
            this._floorWindow = await this._resolveFloorWindow();
        } catch(e){
            console.error('AttestationBatchPublisher: could not hydrate durable batch markers ' +
                          '(publishing is deferred until they read): ' + (e && e.message));
        }

        let pm = this._peerManager();
        if(pm && typeof pm.on === 'function'){
            this._peerHandler = (envelope) => this._handleMessage(envelope);
            pm.on('message', this._peerHandler);
        }

        this._running = true;
        this._armWindowTimer();
        console.log('AttestationBatchPublisher started (network: ' + this.network +
                    ', window: ' + this.windowS + 's' +
                    (this.windowS === ATTEST_BATCH_WINDOW_S ? '' : ' [regtest override]') +
                    ', address: ' + (this.dogeAddress || '<unset>') + ')');
    }

    stop(){
        this._running = false;
        if(this._windowTimer){ clearTimeout(this._windowTimer); this._windowTimer = null; }
        let pm = this._peerManager();
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

    _db(){ return (this.hub && this.hub.db) || this.db; }
    _peerManager(){ return this.hub && this.hub.peerManager; }
    _nowSeconds(){ return Math.floor(Date.now() / 1000); }

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
    _armWindowTimer(){
        if(this._windowTimer) clearTimeout(this._windowTimer);
        this._windowTimer = setTimeout(() => {
            this._windowTimer = null;
            this.sweep()
                .catch(e => console.error('AttestationBatchPublisher: window sweep failed: ' + (e && e.message)))
                .then(() => { if(this._running) this._armWindowTimer(); });
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
            console.log('AttestationBatchPublisher: disabled (ATTEST_BATCH_PUBLISH_ENABLED=false); ' +
                        'skipping this window');
            return { attempted: 0 };
        }
        this._sweeping = true;
        let attempted = 0, published = 0;
        try {
            let now     = Number.isFinite(nowSec) ? Number(nowSec) : this._nowSeconds();
            let pending = await this._pendingWindows(now);
            for(let w of pending){
                attempted++;
                let done = await this._publishWindow(w.windowStart, w.age);
                if(done) published++;
            }
        } finally {
            this._sweeping = false;
        }
        return { attempted, published };
    }

    // The oldest window this hub will consider. A RESTART resumes from the window after
    // its newest marker, so the windows it was down for are still caught up (bounded by
    // MAX_CATCHUP_WINDOWS). A hub with no markers at all is NEW, and backfilling windows
    // that closed before it existed would publish empty coverage heads for hours it has
    // no rows for, so it starts at the window in progress when it booted. Null means no
    // floor, which is what a direct sweep with no start() gets.
    async _resolveFloorWindow(){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return this.windowStartFor(this._nowSeconds());
        let rows = await db.doQuery(
            'SELECT MAX(window_start) AS newest FROM attest_published_batches WHERE network = ?',
            [this.network]);
        let newest = (rows && rows.length) ? Number(rows[0].newest) : NaN;
        if(Number.isFinite(newest) && newest > 0) return newest + this.windowS;
        return this.windowStartFor(this._nowSeconds());
    }

    // The closed windows with no durable marker, oldest first, bounded. `age` is how
    // many windows have closed since: it is the rank a hub must be at or below to
    // publish, which is what staggers the fallback when the elected leader is dark.
    async _pendingWindows(nowSec){
        let current = this.windowStartFor(nowSec);
        let out = [];
        for(let i = MAX_CATCHUP_WINDOWS; i >= 1; i--){
            let start = current - i * this.windowS;
            if(start < 0) continue;
            if(this._floorWindow !== null && start < this._floorWindow) continue;
            let marker = await this._getMarker(start);
            if(marker && String(marker.status) !== 'intent') continue;   // sent, landed or dead-lettered
            if(marker){
                // Intent with no outcome: a crash between the send and the sent marker.
                // Never re-published automatically, because the transaction may be in a
                // mempool this hub cannot see and a second head is a second fee.
                if(!this._quarantined.has(start)){
                    this._quarantined.add(start);
                    this.stats.windowsQuarantined++;
                    console.error('AttestationBatchPublisher: window ' + start + ' carries a publish-intent ' +
                        'marker with no outcome; its on-chain state is unknown after a crash. It will NOT ' +
                        're-publish automatically. Operator: check the DOGE address for an ATTEST v5 batch ' +
                        'covering this window and replay by hand if none landed.');
                }
                continue;
            }
            out.push({ windowStart: start, age: i - 1 });
        }
        return out;
    }

    // Publish one window, or leave it for a later attempt. Returns true only when a
    // batch for this window actually went out.
    async _publishWindow(windowStart, age){
        let windowEnd = this.windowEndFor(windowStart);

        let rows;
        try {
            rows = await this._selectWindowRows(windowStart, windowEnd);
        } catch(e){
            console.warn('AttestationBatchPublisher: cannot read window ' + windowStart +
                         ' from attestation_responses (' + (e && e.message) + '); deferring');
            this.stats.windowsDeferred++;
            return false;
        }

        // OVER-ROWS IS A DEAD LETTER, NOT A TRUNCATION. The row cap is consensus: a
        // batch carrying more rows is invalid on every node, and silently dropping the
        // overflow would publish a head whose coverage claim is false. So the window is
        // recorded loudly and left for an operator, and the rows stay in the mirror.
        if(rows.length > abw.ATTEST_BATCH_MAX_ROWS){
            this._deadLetter({ window_start: windowStart, window_end: windowEnd, row_count: rows.length },
                'row count ' + rows.length + ' exceeds ATTEST_BATCH_MAX_ROWS (' + abw.ATTEST_BATCH_MAX_ROWS + ')');
            console.error('AttestationBatchPublisher: CRITICAL - window ' + windowStart + '-' + windowEnd +
                ' holds ' + rows.length + ' terminal responses, over the ' + abw.ATTEST_BATCH_MAX_ROWS +
                '-row consensus cap; the window is dead-lettered to ' + this.deadLetterPath +
                ' and NOT published. Chain coverage for this window is missing until an operator splits it.');
            await this._recordDeadLetter(windowStart, windowEnd, rows.length);
            return false;
        }

        let anchor = await this._resolveAnchor();
        if(anchor === null){
            this._warnNoAnchor(windowStart);
            this.stats.windowsDeferred++;
            return false;
        }

        let window = {
            network:          this.network,
            window_start:     windowStart,
            window_end:       windowEnd,
            row_count:        rows.length,
            btc_block_height: anchor,
            rows:             rows
        };
        let batchKey = abw.computeBatchKey(window);

        // Publisher election, before any signing round: five hubs holding the same rows
        // would otherwise pay five fees for five identical batches. Rank is hash order
        // over the same capability set the batch is judged against, keyed on the batch
        // key so the election is per window rather than per hub.
        let election = await this._electionRank(anchor, batchKey);
        if(election === null){
            console.warn('AttestationBatchPublisher: cannot resolve the attestation set at anchor ' + anchor +
                         '; deferring window ' + windowStart);
            this.stats.windowsDeferred++;
            return false;
        }
        // The set this batch is judged against goes into the mirror NOW, before any
        // rank decision: a follower that never becomes leader still mirrors it, and an
        // off-BTC verifier reads whichever hub it follows.
        await this._persistAttestationSnapshot(anchor);
        if(election.rank > age){
            // Not this hub's turn yet. A window nobody lands is picked up by the next
            // rank one window later, so a dark leader costs a window's coverage a delay
            // rather than the window itself.
            return false;
        }

        let signed = await this._collectBatchSignatures(window, batchKey);
        if(!signed.met){
            // NOTHING IS PUBLISHED WITHOUT A QUORUM, and the window is deliberately left
            // with no marker: the rows are unchanged in the table, so a later attempt
            // rebuilds byte-identical content and asks again.
            this.stats.windowsDeferred++;
            console.warn('AttestationBatchPublisher: window ' + windowStart + '-' + windowEnd +
                         ' reached no batch quorum; it stays unpublished and is retried');
            return false;
        }
        window.sigs = signed.sigs;

        let encoded = abw.encodeAttestBatch(window);
        if(!encoded.ok){
            this._deadLetter({ window_start: windowStart, window_end: windowEnd,
                               row_count: rows.length, reason: encoded.reason },
                'wire encoding refused the window: ' + encoded.status);
            console.error('AttestationBatchPublisher: CRITICAL - window ' + windowStart + '-' + windowEnd +
                ' cannot be encoded (' + encoded.status + '); dead-lettered to ' + this.deadLetterPath +
                ' and NOT published. Chain coverage for this window is missing.');
            await this._recordDeadLetter(windowStart, windowEnd, rows.length);
            return false;
        }

        return await this._broadcastWindow(window, batchKey, encoded);
    }

    // ------------------------------------------------------------ the mirror read

    // The window's terminal rows, in the applier's own order. Every codec row field is
    // selected by name from the codec's own list, so a field added to the wire cannot
    // be silently absent here.
    //
    // MEMBERSHIP IS THE SIGNED effective_time. It is the only column of this table two
    // hubs are guaranteed to read identically: it rides inside the canonical the
    // responsible set signed, so a boundary row falls on the same side of the same
    // instant on every hub that holds it. The idx_effective_time index is what makes
    // this range read a seek rather than a scan.
    //
    // NORMALIZED ON READ. The driver may hand a BIGINT back as a number, a string or a
    // BigInt depending on how the pool is configured, and the row goes straight into
    // JSON.stringify inside the signed canonical, where '120' and 120 are different
    // bytes. So every numeric column is coerced here, once, and every text column is
    // stringified; a verifier rebuilding from the wire sees the same spellings.
    async _selectWindowRows(windowStart, windowEnd){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') throw new Error('no hub DB');
        let rows = await db.doQuery(
            'SELECT ' + abw.ATTEST_BATCH_ROW_FIELDS.join(', ') + ' ' +
            'FROM attestation_responses ' +
            'WHERE network = ? AND effective_time >= ? AND effective_time < ? ' +
            'ORDER BY request_block_index ASC, request_action_index ASC, request_id ASC ' +
            'LIMIT ?',
            [this.network, windowStart, windowEnd, abw.ATTEST_BATCH_MAX_ROWS + 1]);
        return (rows || []).map(r => this._normalizeRow(r));
    }

    _normalizeRow(r){
        let intOrNull = (v) => {
            if(v === null || v === undefined) return null;
            let n = Number(v);
            return Number.isFinite(n) ? Math.trunc(n) : null;
        };
        return {
            network:              String(r.network),
            request_id:           String(r.request_id).toLowerCase(),
            request_action_index: intOrNull(r.request_action_index),
            request_block_index:  intOrNull(r.request_block_index),
            provider_id:          String(r.provider_id == null ? '' : r.provider_id),
            status:               String(r.status),
            response_payload:     String(r.response_payload == null ? '' : r.response_payload),
            response_hash:        String(r.response_hash).toLowerCase(),
            meta:                 r.meta == null ? '' : String(r.meta),
            effective_time:       intOrNull(r.effective_time),
            signer_pubkeys:       String(r.signer_pubkeys == null ? '[]' : r.signer_pubkeys),
            signatures:           String(r.signatures == null ? '[]' : r.signatures),
            widen:                intOrNull(r.widen) || 0
        };
    }

    // Project onto the codec's field list, in the codec's order. Called on the way into
    // every canonical so the publisher and the verifier serialize the same object even
    // if a read ever hands back a column the wire does not carry.
    _wireRows(rows){
        return rows.map(r => {
            let out = {};
            for(let f of abw.ATTEST_BATCH_ROW_FIELDS) out[f] = r[f];
            return out;
        });
    }

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
    async _resolveAnchor(){
        let db = this._db();
        if(!db){
            this._anchorFailure = 'this hub has no database handle';
            return null;
        }
        let tip = null;
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
        if(!Number.isFinite(n) || n <= 0){
            this._anchorFailure = tip
                ? 'the BTC chain_tips row holds no usable block_height (' + JSON.stringify(tip.blockHeight) + ')'
                : 'no BTC chain_tips row exists for network ' + (this.network || '<unset>') +
                  '; the Bitcoin indexer has not called pushchaintip on this hub';
            return null;
        }
        // Both latches clear together: an outage that returns after the tip came back is
        // a NEW episode and has to say so, even when its cause reads the same.
        this._anchorFailure = null;
        this._anchorWarned  = null;
        return Math.trunc(n);
    }

    // One line per distinct cause, not one per window. The sweep runs every window, so
    // on a regtest cadence an unconditional warning is a line every few seconds for a
    // condition that cannot change without an operator; latching keeps the reason
    // visible without burying the log, and clearing it on a new cause lets a changed
    // failure speak.
    _warnNoAnchor(windowStart){
        let why = this._anchorFailure || 'the BTC chain tip is unavailable';
        if(this._anchorWarned === why) return;
        this._anchorWarned = why;
        console.warn('AttestationBatchPublisher: deferring window ' + windowStart +
            ' because the batch has no BTC anchor: ' + why + '. The anchor is the height ' +
            'the batch quorum is sized at, so no window can publish until it resolves and ' +
            'chain coverage is missing for every window deferred this way. Each deferred ' +
            'window keeps its rows and republishes byte-identical content once it does.');
    }

    // ------------------------------------------------------------ the signer set

    // The attestation-capable set at a BTC anchor, resolved exactly as the response
    // verifier resolves it: weight-keyed at and above the stake-weighted flag day,
    // count-keyed below, so leader, follower and the DOGE indexer size one quorum from
    // one source. Returns null when the snapshot cannot be resolved at all, which every
    // caller treats as "defer", never as "nobody is eligible".
    async _resolveAttestationSet(anchor){
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
        if(weighted && snap.truncated === true) return null;
        let set = snap.validators.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            weight: String((weighted ? v.weight : v.amount) != null ? (weighted ? v.weight : v.amount) : '0'),
            source: String(v.source != null ? v.source : '')
        }));
        set.weighted = weighted;
        set.count = Number.isFinite(parseInt(snap.count)) ? parseInt(snap.count) : set.length;
        return set;
    }

    // Mirror the attestation capability set at `anchor` into capability_snapshots, the
    // table an off-BTC verifier reads. The DOGE indexer judges a v5 head by
    // `getStakeWeightsByCapability('attestation', anchor)`, which on a chain with no
    // local stakes is `capability_snapshots WHERE capability='attestation' AND
    // snapshot_block = anchor`, mirrored from the hub it follows; with nobody writing
    // those rows every v5 head on DOGE read `invalid: insufficient signer stake`
    // (regtest ladder, AT5, 2026-09-05). Same contract as the PRICE batch
    // (OracleConsensus._persistCapabilitySnapshot): every signing hub writes, not just
    // the leader; the natural-key INSERT IGNORE makes the rows identical and a re-write
    // free; a TRUNCATED set is never mirrored (SWQ-TRUNC-MIRROR). Once per anchor per
    // process, because the same anchor recurs every window while the tip sits still.
    async _persistAttestationSnapshot(anchor, set){
        let a = Number(anchor);
        if(!Number.isInteger(a) || a <= 0) return 0;
        if(!this._persistedAnchors) this._persistedAnchors = new Set();
        if(this._persistedAnchors.has(a)) return 0;
        if(!set) set = await this._resolveAttestationSet(a);
        if(!set || set.length === 0) return 0;          // unresolved / truncated: nothing to mirror
        let db = this._db();
        if(!db) return 0;
        let rows;
        try {
            rows = await snapWrite.writeCapabilitySnapshotRows(db, 'attestation', a, set);
        } catch(e){
            console.warn('AttestationBatchPublisher: could not mirror the attestation capability snapshot at anchor ' +
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
                let r = await db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [a, 'attestation', row.signing_pubkey, row.source]);
                if(r.length) this.hub.hubDbBroadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return rows.length;
    }

    // This hub's rank in the publisher election for one batch, or null when the set
    // cannot be resolved. Hash order over sha256(batchKey || pubkey), the ANCHOR
    // publisher election's rule: deterministic, unpredictable per window, and it needs
    // no coordination at all.
    async _electionRank(anchor, batchKey){
        let set = await this._resolveAttestationSet(anchor);
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

    // ------------------------------------------------------------ the signing round

    // Leader half. Resolves { met, sigs } once a quorum of the attestation set at the
    // anchor has co-signed the batch canonical, or { met:false } on timeout or a short
    // quorum. On met:false NOTHING is published for the window.
    async _collectBatchSignatures(window, batchKey){
        let empty = { met: false, sigs: [] };
        if(!this.identity) return empty;

        let canonical = abw.buildAttestBatchCanonical({
            network:          window.network,
            window_start:     window.window_start,
            window_end:       window.window_end,
            row_count:        window.row_count,
            btc_block_height: window.btc_block_height,
            rows:             this._wireRows(window.rows)
        });

        let set = await this._resolveAttestationSet(window.btc_block_height);
        if(!set) return empty;
        let me = this.identity.getPubkeyHex().toLowerCase();
        // This hub must hold `attestation` at the anchor, or its own signature is not
        // counted by the verifier and the quorum arithmetic below is fiction.
        if(!set.some(v => v.pubkey === me)) return empty;

        this.stats.signRounds++;
        let mySig = this.identity.sign(canonical);
        let signatures = new Map([[me, mySig]]);

        let pm = this._peerManager();
        if(set.length <= 1 || !pm || typeof pm.broadcast !== 'function'){
            // Genuine single-member set (membership proven above): this hub's signature
            // IS the quorum, matching the single-node bypass every other rail carries.
            this.stats.signQuorums++;
            return { met: true, sigs: [{ pubkey: me, sig: mySig }] };
        }

        return await new Promise((resolve) => {
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
                    console.warn('AttestationBatchPublisher: batch-signing round for window ' +
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
                rows:             this._wireRows(window.rows)
            });
            this._checkSignQuorum();
        });
    }

    _checkSignQuorum(){
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
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XATTESTB_SIGN_REQ:
                this._handleSignReq(envelope).catch(e =>
                    console.error('AttestationBatchPublisher: XATTESTB_SIGN_REQ error: ' + (e && e.message)));
                break;
            case XATTESTB_SIGN:
                this._handleSign(envelope).catch(e =>
                    console.error('AttestationBatchPublisher: XATTESTB_SIGN error: ' + (e && e.message)));
                break;
        }
    }

    // Follower half. Co-sign ONLY a window this hub can rebuild from its own mirror
    // rows. Every refusal is silent on the wire (logged locally, nothing sent): the only
    // honest answer to "I cannot reproduce that" is to withhold a signature, and a NACK
    // would be an unauthenticated claim about someone else's state.
    async _handleSignReq(envelope){
        let d = envelope.data;
        if(!this.identity || !this._db()) return;
        let pm = this._peerManager();
        if(!pm || typeof pm.broadcast !== 'function') return;

        let sender = String(envelope.sig_pubkey || '').toLowerCase();
        if(sender && sender === this.identity.getPubkeyHex().toLowerCase()) return;   // own broadcast echo

        if(String(d.network) !== this.network) return;
        let windowStart = Number(d.window_start), windowEnd = Number(d.window_end);
        if(!Number.isInteger(windowStart) || !Number.isInteger(windowEnd) ||
           windowStart < 0 || windowEnd !== windowStart + this.windowS) {
            this._refuse(windowStart, 'window bounds are not this hub\'s cadence');
            return;
        }
        // Bound the proposed row list BEFORE any DB work: the count is proposer-chosen
        // and an unbounded one is a query-cost amplifier on every attestation validator.
        if(!Array.isArray(d.rows) || d.rows.length > abw.ATTEST_BATCH_MAX_ROWS){
            this._refuse(windowStart, 'row list is missing or over the consensus cap');
            return;
        }
        if(Number(d.row_count) !== d.rows.length){
            this._refuse(windowStart, 'row_count does not match the rows sent');
            return;
        }

        // The anchor is BOUNDED, not re-derived: two honest hubs never hold the same
        // tip. It must be a height this hub can already see (so the proposer cannot
        // reach forward past a set it can predict) and no further back than a day of
        // blocks (so it cannot reach back to a set it once controlled).
        let anchor = Number(d.btc_block_height);
        let myTip  = await this._resolveAnchor();
        if(!Number.isInteger(anchor) || anchor <= 0 || myTip === null ||
           anchor > myTip || anchor < myTip - ANCHOR_MAX_LAG_BLOCKS){
            this._refuse(windowStart, 'proposed anchor ' + anchor + ' is outside this hub\'s bounds (tip ' +
                         (myTip === null ? 'unresolved: ' + this._anchorFailure : myTip) +
                         ', max lag ' + ANCHOR_MAX_LAG_BLOCKS + ')',
                         myTip === null ? 'no_chain_tip' : null);
            return;
        }

        // This hub must hold `attestation` at the anchor, or its signature is dead
        // weight on the wire and the leader counts a quorum the chain will not.
        let set = await this._resolveAttestationSet(anchor);
        let me  = this.identity.getPubkeyHex().toLowerCase();
        if(!set || !set.some(v => v.pubkey === me)){
            this._refuse(windowStart, 'this hub holds no attestation capability at anchor ' + anchor);
            return;
        }
        // Same rows the leader wrote, from this hub's own resolution (deterministic,
        // INSERT IGNORE), so an indexer following THIS hub verifies the batch too.
        await this._persistAttestationSnapshot(anchor, set);

        let mine;
        try {
            mine = await this._selectWindowRows(windowStart, windowEnd);
        } catch(e){
            this._refuse(windowStart, 'local attestation_responses unreadable (' + (e && e.message) + ')');
            return;
        }
        let verdict = this._matchesLocalWindow(d.rows, mine);
        if(!verdict.ok){
            this._refuse(windowStart, verdict.why);
            return;
        }

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
    }

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
    _matchesLocalWindow(proposed, mine){
        let byId = new Map(mine.map(r => [r.request_id, r]));
        let seen = new Set();
        for(let p of proposed){
            let rid = String((p && p.request_id) || '').toLowerCase();
            if(!rid) return { ok: false, why: 'a proposed row carries no request_id' };
            if(seen.has(rid)) return { ok: false, why: 'request ' + rid.substring(0, 16) + '... appears twice' };
            seen.add(rid);
            let local = byId.get(rid);
            if(!local)
                return { ok: false, why: 'request ' + rid.substring(0, 16) + '... is proposed but not held here' };
            for(let f of abw.ATTEST_BATCH_ROW_FIELDS){
                if(String(p[f] == null ? '' : p[f]) !== String(local[f] == null ? '' : local[f]))
                    return { ok: false, why: 'request ' + rid.substring(0, 16) + '... differs on ' + f };
            }
        }
        for(let local of mine){
            if(seen.has(local.request_id)) continue;
            return { ok: false, why: 'request ' + local.request_id.substring(0, 16) +
                     '... is held here for this window but was not proposed' };
        }
        return { ok: true, why: null };
    }

    async _handleSign(envelope){
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
        this._checkSignQuorum();
    }

    // reasonClass separates a distinct, actionable shape (no chain tip resolved at
    // all, so this hub refuses every proposal it is ever handed) from the generic
    // total, which mixes it with ordinary content and cadence disagreements.
    _refuse(windowStart, why, reasonClass){
        this.stats.signRefusals++;
        if(reasonClass === 'no_chain_tip') this.stats.signRefusalsNoChainTip++;
        console.warn('AttestationBatchPublisher: refusing to co-sign the batch for window ' +
                     windowStart + ': ' + why);
    }

    // ------------------------------------------------------------ the broadcast

    // Send one window's wires, in order, under one durable intent. The head goes first
    // because a continuation without its head is unattributable; a node that sees the
    // head before the chunks holds a structurally sound action that has delivered
    // nothing, which is the ANCHOR archive head's behaviour and is recoverable.
    async _broadcastWindow(window, batchKey, encoded){
        let canBroadcast = this.broadcastFn || (this.encoder && this.walletSignFn);
        if(!canBroadcast){
            console.warn('AttestationBatchPublisher: no broadcast pipeline configured ' +
                '(set DOGE_ENCODER_URL + setWalletSignHook, or setBroadcastHook); window ' +
                window.window_start + ' stays unpublished');
            this.stats.windowsDeferred++;
            return false;
        }
        if(!(await this._balanceAllows())){
            this.stats.windowsDeferred++;
            return false;
        }

        let tokens = [];
        for(let i = 0; i < encoded.wires.length; i++){
            // RESERVE, never allow()/record(): the sends below are awaited, and a pure
            // pre-send check would let two passes each read the same budget and both
            // spend past the ceiling. One reservation per wire, because one wire is one
            // transaction and one fee.
            let token = this.spendGuard.reserve();
            if(!token){
                for(let t of tokens) this.spendGuard.release(t);
                console.warn(this.spendGuard.noteBlocked() + ' (attestation batch window ' +
                             window.window_start + ', ' + encoded.wires.length + ' wire(s))');
                this.stats.windowsDeferred++;
                return false;
            }
            tokens.push(token);
        }

        // Durable intent BEFORE the first send and AFTER the reservation, so a window the
        // ceiling declined leaves no crash marker behind and a crash mid-send leaves one.
        try {
            await this._recordIntent(window, batchKey);
        } catch(e){
            for(let t of tokens) this.spendGuard.release(t);
            console.error('AttestationBatchPublisher: cannot record publish intent for window ' +
                window.window_start + '; deferring (fail closed to avoid an unrecorded spend): ' + (e && e.message));
            this.stats.windowsDeferred++;
            return false;
        }

        this._bufferWindow(window, batchKey, encoded);

        let broadcaster = this.broadcastFn || ((p) => this._defaultBroadcast(p));
        let headTxid = null;
        for(let i = 0; i < encoded.wires.length; i++){
            let result;
            try {
                result = await broadcaster(encoded.wires[i]);
            } catch(e){
                this.spendGuard.commit(tokens[i]);   // a send that may have left the process is a spend
                for(let j = i + 1; j < tokens.length; j++) this.spendGuard.release(tokens[j]);
                let ambiguous = isAmbiguousSendError(e);
                console.error('AttestationBatchPublisher: CRITICAL - wire ' + (i + 1) + '/' +
                    encoded.wires.length + ' of window ' + window.window_start + '-' + window.window_end +
                    ' failed to broadcast' + (ambiguous ? ' AMBIGUOUSLY (it may still have landed)' : '') +
                    ': ' + (e && e.message) + '. The window keeps its intent marker and will NOT be ' +
                    're-published automatically; operator reconciliation required.');
                return false;
            }
            this.spendGuard.commit(tokens[i]);
            this.stats.wiresBroadcast++;
            if(i === 0) headTxid = (result && result.txid) ? String(result.txid) : null;
        }

        await this._markSent(window.window_start, headTxid, window.row_count);
        this.stats.windowsPublished++;
        this.stats.rowsPublished += window.row_count;
        if(window.row_count === 0) this.stats.windowsEmpty++;
        this.stats.lastPublishedWindow = window.window_start;
        this.stats.lastPublishedTxid   = headTxid;
        console.log('AttestationBatchPublisher: published window ' + window.window_start + '-' +
            window.window_end + ' (' + window.row_count + ' row(s), ' + encoded.wires.length +
            ' wire(s), anchor ' + window.btc_block_height + ', txid ' + (headTxid || '<none>') + ')');
        return true;
    }

    // Balance gates, fail-closed in the same order OraclePublisher applies them: an
    // unreadable balance is not a licence to spend.
    async _balanceAllows(){
        let hasSource = !!(this.getBalanceFn || (this.encoder && this.dogeAddress));
        if(!hasSource) return true;
        let balance = null;
        try {
            balance = this.getBalanceFn ? Number(await this.getBalanceFn()) : null;
        } catch(e){
            balance = null;
        }
        if(balance === null || !Number.isFinite(balance)){
            if(this.getBalanceFn){
                console.warn('AttestationBatchPublisher: DOGE balance unreadable; skipping this window ' +
                             '(fail closed)');
                return false;
            }
            return true;   // no balance hook wired: nothing to enforce, as on the PRICE rail
        }
        if(balance < this.lowBalanceThreshold){
            console.warn('AttestationBatchPublisher: DOGE balance ' + balance.toFixed(4) + ' below floor ' +
                         this.lowBalanceThreshold + '; skipping this window (fail closed)');
            return false;
        }
        return true;
    }

    // The default pipeline: the same encoder, address and wallet hook the PRICE rail
    // uses, because there is one operator wallet. Only the payload differs.
    async _defaultBroadcast(payload){
        if(!this.encoder)       throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!this.walletSignFn)  throw new Error('no wallet sign hook configured (call setWalletSignHook)');
        if(!this.dogeAddress)   throw new Error('no DOGE_ADDRESS configured');

        let utxos = await this.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0))
            throw new Error('no UTXOs available for ' + this.dogeAddress);

        let psbtResult = await this.encoder.createTx({
            utxos:       forwardableUtxos(utxos, 'AttestationBatchPublisher'),
            pubkey:      this.dogeAddress,
            data:        payload,
            change:      this.dogeAddress,
            encoding:    'P2SH',
            // Confirmed inputs only by default: spending our own unconfirmed change
            // chains every batch onto the one before it, and miners score a package by
            // its ancestors, so one underpaid batch would hold down every later window.
            unconfirmed: this.allowUnconfirmedInputs
        });
        if(!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        // Refuse phase one of a two-transaction encoding: this pipeline has no reveal,
        // so broadcasting it would publish an undecodable batch and strand the value.
        assertSingleTxEncoding(psbtResult, 'AttestationBatchPublisher');

        let txHex = await this.walletSignFn(psbtResult.psbt);
        if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        return (await this.encoder.broadcastTx(txHex)) || { txid: null };
    }

    // ------------------------------------------------------------ durable markers

    async _getMarker(windowStart){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return null;
        let rows = await db.doQuery(
            'SELECT network, window_start, window_end, batch_key, row_count, txid, status ' +
            'FROM attest_published_batches WHERE network = ? AND window_start = ?',
            [this.network, windowStart]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Load every window this hub has already resolved. Only the intent-only rows need
    // remembering in memory: they are the ones the sweep must refuse, once each rather
    // than once per pass.
    async _hydrateMarkers(){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return;
        let rows = await db.doQuery(
            'SELECT window_start FROM attest_published_batches WHERE network = ? AND status = ?',
            [this.network, 'intent']);
        for(let r of (rows || [])) this._quarantined.add(Number(r.window_start));
        if(this._quarantined.size > 0)
            console.error('AttestationBatchPublisher: ' + this._quarantined.size + ' window(s) carry a ' +
                'publish-intent marker with no outcome; they are NOT re-published automatically. ' +
                'Operator: verify each on chain and replay by hand if absent.');
    }

    // Idempotent: an existing row for the window is left exactly as it is, so a replay
    // can never downgrade a `sent` or `landed` marker back to an intent.
    async _recordIntent(window, batchKey){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return;
        await db.doQuery(
            'INSERT INTO attest_published_batches (network, window_start, window_end, batch_key, row_count, status) ' +
            'VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE window_start = window_start',
            [this.network, window.window_start, window.window_end, batchKey, window.row_count, 'intent']);
    }

    // The DOGE is already spent by the time this runs, so a failure here is logged
    // rather than thrown: the intent row means a restart quarantines the window instead
    // of paying for it twice.
    async _markSent(windowStart, txid, rowCount){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return;
        try {
            await db.doQuery(
                'UPDATE attest_published_batches SET status = ?, txid = ?, row_count = ?, sent_at = NOW() ' +
                'WHERE network = ? AND window_start = ? AND status = ?',
                ['sent', txid, rowCount, this.network, windowStart, 'intent']);
        } catch(e){
            console.error('AttestationBatchPublisher: window ' + windowStart + ' was broadcast but its ' +
                'durable sent marker could not be persisted; a restart will QUARANTINE (not re-publish) it. ' +
                'Operator: confirm the txid on chain. Error: ' + (e && e.message));
        }
    }

    async _recordDeadLetter(windowStart, windowEnd, rowCount){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return;
        this.stats.windowsDeadLettered++;
        try {
            await db.doQuery(
                'INSERT INTO attest_published_batches (network, window_start, window_end, row_count, status) ' +
                'VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), row_count = VALUES(row_count)',
                [this.network, windowStart, windowEnd, rowCount, 'deadletter']);
        } catch(e){
            console.error('AttestationBatchPublisher: could not record the dead-letter marker for window ' +
                          windowStart + ': ' + (e && e.message));
        }
    }

    // Called by the receive half when a batch for this window is parsed off DOGE and
    // pushed back (D72). Authoritative for the WHOLE federation: any hub's batch landing
    // covers the window, so a hub that never published one stops considering it.
    async recordLandedWindow(windowStart, windowEnd, txidOrNull, rowCount){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return;
        this.stats.landedRecorded++;
        this._quarantined.delete(Number(windowStart));
        await db.doQuery(
            'INSERT INTO attest_published_batches ' +
            '(network, window_start, window_end, row_count, txid, status, landed_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, NOW()) ' +
            'ON DUPLICATE KEY UPDATE status = VALUES(status), landed_at = NOW(), ' +
            'row_count = VALUES(row_count), txid = COALESCE(attest_published_batches.txid, VALUES(txid))',
            [this.network, windowStart, windowEnd, rowCount, txidOrNull, 'landed']);
    }

    // ------------------------------------------------------------ the files

    // What a window was built from, appended when it publishes. Not a queue: the
    // durable marker is the at-most-once guard, and this is the operator's copy of the
    // content, which the mirror table would otherwise have to be re-derived from.
    _bufferWindow(window, batchKey, encoded){
        this._append(this.bufferPath, {
            window_start: window.window_start, window_end: window.window_end,
            batch_key: batchKey, row_count: window.row_count,
            btc_block_height: window.btc_block_height,
            total_chunks: encoded.totalChunks, inflated_bytes: encoded.inflatedBytes,
            request_ids: window.rows.map(r => r.request_id), at: Date.now()
        });
    }

    // Append-only give-up sink, never truncated. Best-effort: a write failure here must
    // not stop the CRITICAL log or the durable marker that keeps the window from looping.
    _deadLetter(record, reason){
        this._append(this.deadLetterPath, Object.assign({}, record,
            { deadLetteredAt: Date.now(), reason: reason }));
    }

    _append(file, record){
        try {
            let fd = fs.openSync(file, 'a');
            fs.writeSync(fd, JSON.stringify(record) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch(e){
            console.error('AttestationBatchPublisher: failed to append to ' + file + ': ' + (e && e.message));
        }
    }

    getStats(){
        return Object.assign({}, this.stats, {
            windowSeconds: this.windowS,
            enabled:       this.enabled,
            armed:         this.isArmedNetwork(),
            quarantinedWindows: this._quarantined.size,
            // Null unless the last anchor read failed. A rising windowsDeferred with a
            // reason here is a configuration gap, not a busy federation.
            anchorFailure: this._anchorFailure || null
        });
    }
}

module.exports = AttestationBatchPublisher;
module.exports.XATTESTB_SIGN_REQ = XATTESTB_SIGN_REQ;
module.exports.XATTESTB_SIGN     = XATTESTB_SIGN;
module.exports.MAX_CATCHUP_WINDOWS = MAX_CATCHUP_WINDOWS;
module.exports.ANCHOR_MAX_LAG_BLOCKS = ANCHOR_MAX_LAG_BLOCKS;
