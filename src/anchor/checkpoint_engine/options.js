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
 * State checkpoint engine - construction options
 *
 * Every knob, counter and meter an engine holds, grouped by what it governs, in the
 * order the constructor sets them.
 *
 ********************************************************************/

'use strict';

const { positiveIntConfig } = require('../../lib/config_int.js');
const { resolveCheckpointIntervalBlocks } = require('../checkpoint_cadence.js');
const { ALLOWED_CHAINS } = require('./constants.js');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Default follower co-sign freshness tolerance (BTC blocks) for the leader-
// supplied snapshot_block. ~144 = roughly one day of BTC blocks, matching
// CrossChainCallEngine's snapshot_block bound. See the comment on
// this.cosignToleranceBlocks in initCosignTolerance for why this is deliberately NOT electionToleranceBlocks.
const CHECKPOINT_COSIGN_TOLERANCE_BLOCKS = 144;

module.exports = {

    initCadenceKnobs(cfg){
        this.enabled        = String(hubConfig.CHECKPOINT_ENABLED || cfg.CHECKPOINT_ENABLED || 'true') !== 'false';
        // Resolve the cadence knobs through the house guards, not bare parseInt: a NaN
        // pollMs makes setInterval clamp to ~1ms and storm, and a NaN or zero
        // intervalBlocks makes the cadence latch never hold, anchoring 3 chains every poll.
        // intervalBlocks goes through the shared resolver the anchor publisher also calls,
        // so the two readers of CHECKPOINT_INTERVAL_BLOCKS cannot drift.
        this.intervalBlocks = resolveCheckpointIntervalBlocks(cfg);
        this.pollMs         = positiveIntConfig(hubConfig.CHECKPOINT_POLL_MS || cfg.CHECKPOINT_POLL_MS,
                                                60000, 'CHECKPOINT_POLL_MS');
        this.roundTimeoutMs = positiveIntConfig(hubConfig.CHECKPOINT_ROUND_TIMEOUT_MS || cfg.CHECKPOINT_ROUND_TIMEOUT_MS,
                                                60000, 'CHECKPOINT_ROUND_TIMEOUT_MS');
        // Confirmations is the one knob where 0 is meaningful (checkpoint the tip itself,
        // the regtest venue setting), so it takes a non-negative guard rather than positiveIntConfig.
        this.confirmations  = parseInt(hubConfig.CHECKPOINT_CONFIRMATIONS  || cfg.CHECKPOINT_CONFIRMATIONS  || '6');
        if(!(this.confirmations >= 0)) this.confirmations = 6;
    },

    initCosignTolerance(cfg){
        // Follower co-sign freshness bound on the leader-supplied snapshot_block.
        // DEDICATED and separate from StateAnchorPublisher.electionToleranceBlocks
        // (default 36) on purpose: that constant bounds an ELECTION block that
        // advances every BTC block, so a tight window is correct there. The
        // checkpoint snapshot_block instead selects the validator set AND every
        // flag-day gate (stake-weighted quorum, equivocation-header, checkpoint-
        // commitment); it moves on the slower checkpoint cadence, so it needs its
        // own, wider tolerance. Mirrors CrossChainCallEngine's snapshot_block bound
        // (a day of BTC blocks, ~144), the closest analog. Fail-closed: a SIGN_REQ
        // whose snapshot_block deviates from our own BTC tip beyond this is declined.
        // Validated, not bare parseInt: a nonnumeric operator value yields NaN, and
        // `Math.abs(myBtc - snapshot_block) > NaN` is ALWAYS false, so the guard below
        // silently stops firing and any leader-supplied snapshot_block is accepted (a
        // 9,900-block-stale one reaches validator-set resolution). A disabled safety bound
        // must never be the outcome of a typo. Non-negative clamp rather than
        // positiveIntConfig, because 0 is meaningful here: it demands an exact
        // snapshot_block match, and widening that back to the default would LOOSEN the
        // bound the operator asked to tighten. Same idiom as `confirmations` above.
        this.cosignToleranceBlocks = parseInt(hubConfig.CHECKPOINT_COSIGN_TOLERANCE_BLOCKS
            || cfg.CHECKPOINT_COSIGN_TOLERANCE_BLOCKS || String(CHECKPOINT_COSIGN_TOLERANCE_BLOCKS));
        if(!(this.cosignToleranceBlocks >= 0)){
            logger.warn('config: CHECKPOINT_COSIGN_TOLERANCE_BLOCKS="' +
                         String(hubConfig.CHECKPOINT_COSIGN_TOLERANCE_BLOCKS ||
                                cfg.CHECKPOINT_COSIGN_TOLERANCE_BLOCKS) +
                         '" is not a non-negative integer; using the default (' +
                         CHECKPOINT_COSIGN_TOLERANCE_BLOCKS + '). An unvalidated value would ' +
                         'disable the co-sign snapshot freshness guard outright.');
            this.cosignToleranceBlocks = CHECKPOINT_COSIGN_TOLERANCE_BLOCKS;
        }
    },

    initChainScope(cfg){
        this.chains = String(hubConfig.CHECKPOINT_CHAINS || cfg.CHECKPOINT_CHAINS || ALLOWED_CHAINS.join(','))
            .split(',').map(c => c.trim().toUpperCase()).filter(c => ALLOWED_CHAINS.includes(c));

        // Regtest seams: shared with the cross-chain DEX engine so a no-BTC
        // regtest configures its deterministic anchor + seeded validator once.
        // Network-gated (item decff441): the snapshot-block override feeds the SIGNED
        // checkpoint canonical and the seeded validator joins the federation set, so a
        // stray env var or configs-table row must never reach them on mainnet/testnet.
        // Honored ONLY on regtest; NaN/false everywhere else (fail closed to the real set).
        let _isRegtest = (this.network === 'regtest');
        this._snapshotBlockOverride = _isRegtest ? parseInt(hubConfig.XDEX_SNAPSHOT_BLOCK || cfg.XDEX_SNAPSHOT_BLOCK) : NaN;
        this._seedLocalValidator    = _isRegtest && (hubConfig.XDEX_SEED_LOCAL_VALIDATOR === '1' ||
                                       cfg.XDEX_SEED_LOCAL_VALIDATOR === '1' || cfg.XDEX_SEED_LOCAL_VALIDATOR === true);

        // Per-coin indexer JSON-RPC endpoints (same env surface as CrossChainDexEngine).
        this.indexers = {};
        for(let coin of ALLOWED_CHAINS){
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }
    },

    initRoundState(){
        // Leader-side rounds in flight: Map<id, pending>. id = chain|network|block_index|seq.
        this.pending = new Map();

        this._lastCheckpointBtcBlock = null;     // leader cadence latch
        this._pollTimer      = null;
        this._messageHandler = null;
        this._ticking        = false;
    },

    initFinalizeMeters(){
        // Process-lifetime counter for rounds that timed out below quorum.
        // Surfaced by getcheckpointstats so operators can detect stalled rounds
        // without running raw SQL.
        this._roundTimeouts = 0;
        // Follower-side FINALIZED drops. Quorum loss observed as leader is metered
        // via _roundTimeouts; these meter the same loss observed as a follower so a
        // validator-set/quorum drift or a Byzantine leader is visible at the moment
        // every incoming FINALIZED fails here, not only via the indirect tip-stall.
        this._malformedFinalized  = 0;
        this._subQuorumFinalized  = 0;
        // Quorum-signed FINALIZED broadcasts refused because a DIFFERENT payload is
        // already seated at that (chain, network, checkpoint_seq). Nothing honest
        // produces this shape, so any non-zero value is a federation-level equivocation
        // at one sequence and the fleet may already hold divergent rows: read the
        // CONFLICTING lines in this hub's log and compare the seq across hubs.
        this._seqConflicts        = 0;

        // The canonical this hub signed at each sequence: Map<'chain|network|seq',
        // canonical>. Every co-sign guard keys on snapshot_block, and seq is a pure
        // function of it, so a cadence leader proposing two DIFFERENT block_index values
        // at one snapshot_block clears all of them twice; signing one payload per
        // sequence is what keeps the second quorum from forming. Held for this process
        // only: a signer that restarts inside a cadence window can still answer a second
        // payload, which a durable commitment would close at the price of a DB write on
        // the signing path.
        this._signedAtSeq = new Map();
        // Signature requests refused because this hub already signed a different payload
        // at that sequence. Nothing honest puts two payloads on the wire at one sequence;
        // the SECOND PAYLOAD log lines name the blocks.
        this._seqDoubleSignRefusals = 0;
    },

    initCadenceMeters(cfg){
        // Cadence stalls. Every pre-leadership bail in tick used to return
        // silently, so a hub whose oracle_publish capability had gone unqualified
        // produced zero checkpoints and zero log lines. The mainnet hub sat that way
        // for 18 days (last checkpoint 2026-07-10 at BTC 957439, tip 960028) because
        // its capability config still carried a placeholder DOGE address, and nothing
        // in the logs or in getcheckpointstats said so. Meter every "cadence is due
        // but we cannot lead" bail and name the reason.
        this._cadenceStalls        = 0;
        this._cadenceStallReason   = null;
        this._cadenceStallBlock    = null;
        this._cadenceStallLoggedAt = 0;
        // Log throttle: the poll runs far faster than the cadence, so log the reason
        // at most once an hour and let the counter carry the true rate.
        this._cadenceStallLogMs = parseInt(hubConfig.CHECKPOINT_STALL_LOG_MS
            || cfg.CHECKPOINT_STALL_LOG_MS || String(60 * 60 * 1000));

        // Frozen-tip livelock meter. The cadence leader is pubkeys[btcBlock % N], so
        // "due, in the set, not my slot" is normal rotation ONLY while btcBlock keeps
        // advancing. If the BTC tip freezes (indexer wedged, node stalled, regtest
        // nobody mines) the slot pins to one constant and every hub whose rank is not
        // that constant returns forever, for every chain, with cadence_stalls at 0.
        // Proven live on a regtest venue 2026-08-19: BTC tip frozen four days at
        // 14671, slot 31 vs rank 30, zero checkpoints in three weeks. Count the
        // not-my-slot ticks that see the SAME btcBlock; past K consecutive ones the
        // tick is metered as a stall naming the frozen block. K defaults to an hour of
        // the default 60s poll, longer than any BTC inter-block gap that normal
        // rotation would survive; a wedged tip stays wedged and crosses it.
        this._frozenTipTicks = parseInt(hubConfig.CHECKPOINT_FROZEN_TIP_TICKS
            || cfg.CHECKPOINT_FROZEN_TIP_TICKS || '60');
        if(!(this._frozenTipTicks > 0)) this._frozenTipTicks = 60;
        this._notMySlotBlock = null;     // btcBlock seen by the last not-my-slot tick
        this._notMySlotTicks = 0;        // consecutive not-my-slot ticks at that block

        // True while the P2P layer is holding back everything this hub authors.
        // Surfaced by getStats so an operator reading getcheckpointstats sees why
        // no checkpoint is being cut without a per-tick stall record to read it from.
        this._observerIdle = false;
    }

};
