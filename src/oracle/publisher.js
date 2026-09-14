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
 * XChain Hub - Oracle Publisher (`oracle_publish` capability)
 *
 * Validators with the `oracle_publish` capability active publish finalized
 * PRICE v0 rounds to the DOGE chain as the immutable backup/audit trail.
 * Leader rotation is deterministic:
 *   leader_index = round % active_oracle_publish_count
 *
 * Active validators are sorted by signing_pubkey for stable ordering
 * across all nodes. First valid PRICE tx on-chain for a given round wins
 * (and earns the reward).
 *
 * LEADER FAILOVER: opt-in, off by default. A window's leader publishes it; a
 * follower arms a timer staggered by its DISTANCE from that leader in the
 * rotation and, if the window is still not on chain when the timer fires,
 * re-assembles the identical batch itself (scheduleTakeover / attemptTakeover).
 * Set ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS to arm it. Before this existed a
 * silent leader meant the window was never published by anyone, however healthy
 * the rest of the set was.
 *
 * The safety property is that a hub only steps in when it can PROVE it would
 * have seen the leader succeed. That proof is the indexer pushing landed PRICE
 * actions back to this hub (the same feed pruneObservedWindow reads). A hub
 * that has never observed one declines every takeover, because on that hub
 * "not on chain" and "on chain but I was not told" are the same observation,
 * and guessing wrong pays DOGE twice for a duplicate on-chain batch.
 *
 * "On chain" is a MINED view, so it has a second blind spot: a leader whose tx was
 * accepted by the DOGE node but has not been mined looks exactly like a leader that
 * never sent. An armed follower therefore also honours an ambiguity cooldown before it
 * steps in, started by either its own ambiguous send for the window or the
 * co-signature it handed that window's leader, and defers until the cooldown has
 * elapsed with the window still absent - the point at which the in-flight tx is
 * provably gone. This is AttestationPublisher's _ambiguousSends deferral, on this rail.
 *
 * The off-hub control still applies and is not replaced: the dashboard's
 * publish-coverage rail detects a gap from the chain side, backed by the
 * _lastRankState / _leaderRounds / _followerRounds counters below.
 *
 * A round that exhausts its broadcast attempts is written to an append-only
 * dead-letter file (never silently dropped) so the finalized round can be
 * inspected and replayed by hand rather than vanishing from the durable queue.
 *
 * This module handles:
 *   - Leader rotation calculation
 *   - Persistent queue (JSONL with fsync)
 *   - PRICE v0 payload construction (matches indexer parser format)
 *   - PRICE batch assembly (buffer, window scheduler, splitting, signing round)
 *   - DOGE balance monitoring with WARN/ERROR log thresholds
 *
 * PRICE v0 BATCH RAIL (spec section 7).
 * A finalized round is never broadcast on its own. It is appended to a SEPARATE
 * durable buffer file and leaves this hub only as part of an hourly batch that a
 * quorum of the price-capable set has co-signed. The two files are deliberately
 * distinct: the publish queue broadcasts every entry it reads, so a "buffered"
 * round parked there would go out as the very v0 the batch replaces.
 *
 * Every hub buffers every round it finalizes, leader or not, because window
 * leadership is resolved at the window's anchor and that anchor is unknown when
 * the window's first round finalizes. Non-leaders shed their copies once an
 * on-chain batch covering the window shows up in their own price_snapshots, and
 * unconditionally at ORACLE_BATCH_BUFFER_MAX_ROUNDS.
 *
 * The actual DOGE broadcast is delegated to a `broadcastFn` hook that
 * the operator wires up to their preferred signer (xchain-sdk, xchain-encoder
 * REST API, or local DOGE node). This keeps the publisher decoupled from
 * the underlying transport.
 *
 ********************************************************************/

const fs            = require('fs');
const path          = require('path');
const EncoderClient = require('../peers/encoder_client.js');
const OracleBatchSigner = require('./batch_signer.js');
const ah            = require('../lib/admission_height.js');
const { forwardableUtxos } = require('../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../lib/two_phase_guard.js');
const { abandonBuild }           = require('../lib/encoder_reservation.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

// One part per behaviour, each an object of methods installed on the prototype
// below. A part never requires `fs` or the encoder client: the suites stub both
// through THIS file, so a part that required either would reach the real module
// and write real files under a test that believes it stubbed them. Everything
// touching them therefore stays here, as the primitives the parts call.
const optionsPart      = require('./publisher/options.js');
const batchOptionsPart = require('./publisher/batch_options.js');
const broadcastPart    = require('./publisher/broadcast.js');
const landingPart      = require('./publisher/landing.js');
const lifecyclePart    = require('./publisher/lifecycle.js');
const rotationPart     = require('./publisher/rotation.js');
const queuePart        = require('./publisher/queue.js');
const bufferPart       = require('./publisher/buffer.js');
const takeoverPart     = require('./publisher/takeover.js');
const schedulerPart    = require('./publisher/scheduler.js');
const landedPart       = require('./publisher/landed.js');
const assemblyPart     = require('./publisher/assembly.js');
const wirePart         = require('./publisher/wire.js');
const publishPassPart  = require('./publisher/publish_pass.js');
const publishEntryPart = require('./publisher/publish_entry.js');
const statsPart        = require('./publisher/stats.js');
const PARTS = [optionsPart, batchOptionsPart, broadcastPart, landingPart, lifecyclePart,
               rotationPart, queuePart, bufferPart, takeoverPart, schedulerPart, landedPart,
               assemblyPart, wirePart, publishPassPart, publishEntryPart, statsPart];

// PRICE v0 wire ceiling. Must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js
// (mirrors ATTEST_WIRE_MAX_BYTES in AttestationPublisher.js): an oversized wire is
// rejected by createTx with a RangeError, so we drop it before it lands on the durable
// queue rather than letting the queue retry sweep replay it forever. (Named for
// what _processQueue does: this class has no failover sweep, see the header.)
const PRICE_WIRE_MAX_BYTES = 8189;

class OraclePublisher {

    constructor(hub) {
        this.hub      = hub;
        this.db       = hub.db;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        // Config (read from env or hub p2pConfig)
        let cfg = hub.p2pConfig || {};
        // Each initializer below sets one behaviour's fields (src/oracle/publisher/),
        // called in the order those fields were always assigned, so every config
        // read, clamp and warn line still happens exactly where it did.
        this.initQueueState(cfg);
        this.initDurableGuard(cfg);
        this.initSpendGate(cfg);
        this.initTakeoverState(cfg);
        this.initChainingState(cfg);

        // Auto-create EncoderClient if DOGE_ENCODER_URL env var is set
        // This is the JSON-RPC endpoint of an xchain-encoder instance configured for DOGE.
        let encoderUrl = hubConfig.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = hubConfig.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks (wired by the operator at startup)
        // broadcastFn(payload) → Promise<{txid}>: full custom broadcast pipeline (overrides default)
        // walletSignFn(psbtHex) → Promise<txHex>: sign a PSBT with the DOGE_ADDRESS private key
        // getBalanceFn() → Promise<number>: return DOGE balance for the configured address
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;

        // Publish-pass self-overlap guard, see _processQueue(). Named for the sibling
        // publishers' house convention (AttestationPublisher._sweeping,
        // AttestationSpotChecker.schedulerTick).
        this._sweeping = false;

        this.initBatchRailConfig(hub, cfg);
        this.initBatchWindow(cfg);
        this.initBatchState();
        this.initLandingState(cfg);
    }

    // ----- The durable-file primitives -----
    //
    // The queue, the dead-letter file and the round buffer are the three durable
    // files this class owns, and every write to them is open/write/fsync/close so a
    // crash cannot leave a half-line behind. They live here rather than with the
    // callers because `fs` is what the suites stub through this module.

    // Create the queue directory and touch the queue file. Best-effort: an
    // unwritable queue is logged here and fails loud at the first enqueue.
    ensureQueueFile() {
        // Ensure queue directory exists
        let dir = path.dirname(this.queuePath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: failed to create queue directory ' + dir + ':', e));
        }

        // Touch queue file
        try {
            if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '');
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: queue file unwritable at ' + this.queuePath + ':', e));
        }
    }

    // Append one line durably. Throws to the caller, which decides whether an
    // unwritable file is fatal (the queue and the buffer) or best-effort (the
    // dead-letter sink).
    appendDurableLine(filePath, line) {
        let fd = fs.openSync(filePath, 'a');
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
    }

    // Truncating rewrite of a durable file, same fsync discipline.
    rewriteDurableFile(filePath, text) {
        let fd = fs.openSync(filePath, 'w');
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
    }

    // Read a durable file whole, or null when it cannot be read. The callers all
    // treat an unreadable file as empty, which is why the failure is returned
    // rather than thrown.
    readDurableFile(filePath) {
        try { return fs.readFileSync(filePath, 'utf8'); }
        catch (e) { return null; }
    }

    // Steps 1-3 of the default pipeline: fetch, build, sign. Returns the signed tx hex.
    async buildSignedTx(payload) {
        if (!this.encoder)         throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if (!this.walletSignFn)    throw new Error('no wallet sign hook configured (call setWalletSignHook)');
        if (!this.dogeAddress)     throw new Error('no DOGE_ADDRESS configured');
        if (!this.dogePubkeyHex)   throw new Error('no DOGE_PUBKEY_HEX configured');

        // 1. Fetch UTXOs for the publisher's DOGE address
        let utxos = await this.encoder.getUtxos(this.dogeAddress);
        if (!utxos || (Array.isArray(utxos) && utxos.length === 0)) {
            throw new Error('no UTXOs available for ' + this.dogeAddress);
        }

        // 2. Create an unsigned PSBT with the PRICE v0 payload
        // PRICE v0 payloads are typically ~900-1100 bytes (well above the 80-byte OP_RETURN limit),
        // so we use P2SH encoding which is what xchain-encoder supports for large payloads.
        let selection = this.selectInputs(utxos);
        let psbtResult = await this.encoder.createTx({
            // Forwarded only while the set is inside the encoder's caller-facing
            // MAX_UTXO_COUNT; past it the param is omitted so the encoder selects
            // from its own uncapped fetch of this same address. See
            // lib/encoder_utxo_forward.js.
            utxos:    forwardableUtxos(selection.utxos, 'OraclePublisher'),
            // The encoder's P2SH path runs bitcoin.address.fromBase58Check() on this
            // field, so it must be the base58check address (not the raw hex pubkey).
            pubkey:   this.dogeAddress,
            data:     payload,
            change:   this.dogeAddress,
            encoding: 'P2SH',
            // CONFIRMED INPUTS ONLY. Spending our own unconfirmed change chains every
            // batch onto the one before it, and miners score a transaction by its whole
            // ancestor package: one cheap early transaction then holds down every batch
            // published after it, however much the newest one pays. That is what turned
            // a single underpaid batch into a nine-hour backlog of nine transactions,
            // where the newest paid 1.36 per kB and still could not move a package
            // anchored to ancestors paying 0.003. Each batch must stand alone and be
            // judged on its own fee rate. When no confirmed output is available the
            // pass defers (see the NO_CONFIRMED_UTXO gate), which is the correct
            // outcome: a deferred window is recoverable, a chained package is not.
            // The one exception is our own change from this same pass, which
            // selectInputs hands over explicitly.
            unconfirmed: selection.unconfirmed
        });
        if (!psbtResult || !psbtResult.psbt) {
            throw new Error('encoder returned no PSBT');
        }
        return await this.signBuiltTx(psbtResult);
    }

    // Step 3 of the default pipeline: refuse a two-phase encoding, then sign.
    //
    // A SUCCESSFUL create_tx reserved every input it selected and handed back the
    // receipt on psbtResult.reservation; the encoder's selection skips those outpoints
    // until its own 5-minute TTL. Every exit below abandons the build BEFORE
    // broadcast_tx (the send lives in defaultBroadcast, two frames up), so each one
    // must hand the claims back or this publishing address is unavailable to the other
    // publishers and to wallet operations for the rest of that window - and a pass that
    // keeps retrying reserves a fresh set of outputs each time without ever sending.
    // The release is deliberately confined to this pre-broadcast section: past the
    // send, holding the inputs is what stops a second build double-spending a
    // transaction that may already have landed.
    async signBuiltTx(psbtResult) {
        try {
            // 2b. Refuse phase 1 of a two-transaction encoding. P2SH answers a FUNDING tx
            // whose payload only becomes readable when a reveal spends it, and this pipeline
            // has no reveal: broadcasting it publishes an undecodable PRICE and strands the
            // carrier value. Thrown BEFORE the wallet hook, so nothing is signed and no fee
            // is spent. See lib/two_phase_guard.js.
            assertSingleTxEncoding(psbtResult, 'OraclePublisher');

            // 3. Sign the PSBT via the operator-provided wallet hook
            let txHex = await this.walletSignFn(psbtResult.psbt);
            if (!txHex || typeof txHex !== 'string') {
                throw new Error('wallet sign hook returned invalid tx hex');
            }
            return txHex;
        } catch (e) {
            await abandonBuild(this.encoder, psbtResult, 'OraclePublisher');
            throw e;                                  // the refusal is what the caller must see
        }
    }

    // The signing round. Preferred from the hub so one instance owns the P2P handler;
    // when the hub wires none this class creates and owns one, which is what keeps the
    // batch rail functional on a hub whose wiring has not caught up.
    //
    // Kept in this file rather than with the wire part: the admission suite re-arms the
    // activation by purging this module and batch_signer.js from the require cache, and a
    // cached part holding its own OracleBatchSigner would construct the unarmed class.
    getBatchSigner() {
        if (this.hub && this.hub.oracleBatchSigner) return this.hub.oracleBatchSigner;
        if (this._ownedBatchSigner) return this._ownedBatchSigner;
        if (!this.hub) return null;
        try {
            this._ownedBatchSigner = new OracleBatchSigner(this.hub);
            this._ownedBatchSigner.start();
            return this._ownedBatchSigner;
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: cannot construct an OracleBatchSigner:', e));
            return null;
        }
    }
}

// Install one part's methods on the prototype, non-enumerably, exactly as
// src/db/index.js installs its table mixins: enumerable false keeps a moved method
// indistinguishable from one still declared in the class above, and writable plus
// configurable keep a test able to stub one. A name already on the prototype throws
// rather than overwriting, so two parts claiming one method name is named at boot
// instead of becoming a silent last-part-wins.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate OraclePublisher method: ' + name + ' is already ' +
                    'defined on the prototype. Two parts, or a part and the class, claim it.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(OraclePublisher.prototype, PARTS);

// The admission seam. The admission tests re-arm the mirror-admission activation by
// purging this file and lib/admission_height.js from the require cache and loading both
// again, which reloads this shell but not its already-cached parts. A part that required
// admission_height itself would keep the unarmed copy, so the parts read the copy THIS
// shell loaded, through the prototype (the seam OracleConsensus and PriceAggregator use).
Object.defineProperty(OraclePublisher.prototype, 'admission',
    { value: ah, enumerable: false, writable: true, configurable: true });

// The wire ceiling rides on the class so the parts that report it can read it
// without a second declaration to drift from this one (the same named-export shape
// OracleBatchSigner uses for its wire types).
module.exports = Object.assign(OraclePublisher, { PRICE_WIRE_MAX_BYTES });
