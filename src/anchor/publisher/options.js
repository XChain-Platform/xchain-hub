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
 * ANCHOR publisher - construction options
 *
 * Every knob, counter, queue and timer handle a publisher holds, grouped by what
 * it governs. The derivations that pin the sizing and timing magnitudes stay
 * beside the values they explain.
 *
 ********************************************************************/

'use strict';

const EncoderClient = require('../../peers/encoder_client.js');
const SpendGuard = require('../../lib/spend_guard.js');
const { resolveCheckpointIntervalBlocks } = require('../checkpoint_cadence.js');
const hubConfig = require('../../config');

module.exports = {

    initPublishCadence(cfg){
        // Derivation of the ANCHOR sizing/timing magnitudes.
        // Read this before retuning any of them. What is load-bearing is the
        // RELATIONSHIP each number encodes, not the round figure; none of these is
        // consensus data (they are per-hub operator knobs), but two of them have a
        // hard on-chain ceiling behind them. The arithmetic below is pinned by
        // test/unit/anchor/publisher/state_anchor_publisher_constant_derivations.test.js, so a retune
        // that breaks a bound fails there instead of on-chain.
        //
        // ANCHOR_CHUNK_MAX_BYTES = 6000 (base64url chars per archive chunk).
        //   Hard ceiling: MAX_ACTION_DATA_LENGTH = 8192 compiled bytes
        //   (xchain-documentation/protocol/constants.js). The DECODER is the
        //   arbiter and silently DROPS a larger action, so an oversize anchor is
        //   lost fleet-wide, not rejected loudly. Chunk 0 does not travel alone: it
        //   rides inside the v1 HEAD next to the checkpoint prefix (four 64-hex
        //   hashes plus the chain/network/seq/index fields, ~322 B at mainnet
        //   heights) and the signature lists, at 194 B per (PUBKEY,SIG) pair; the
        //   publisher tail adds ~67 B for PUBLISHER + ATTEST_SIG_COUNT plus another
        //   194 B per attesting signer. So 8192 - 6000 - 322 leaves ~1870 B of head
        //   budget: about nine signature pairs on a tail-less head, or four wrapper
        //   plus four attestation pairs once the tail is filled. THAT RESERVE is why
        //   the value is 6000 and not something nearer 8000. It binds chunk 0 only (a
        //   v2 continuation carries ~30 B of overhead), but one uniform slice keeps
        //   splitChunks trivial.
        //   Tuner rule: this is the knob to LOWER when the federation grows. A v1
        //   with a 5+5 quorum needs chunkMaxBytes <= ~5860, a 7+7 quorum <= ~5080.
        //   Raising it costs fewer v2 txs but overflows the head first.
        //
        // ANCHOR_MATCH_BATCH_SIZE = 200 is a LATENCY trigger, not a size cap: 200
        //   pending rows flush an archive early rather than waiting out
        //   ANCHOR_INTERVAL_MS (24h), bounding how much settled cross-chain state
        //   exists only in hub DBs. ANCHOR_MAX_BATCH = 1000 is the per-cycle SQL
        //   LIMIT and therefore the DOGE SPEND bound: archived rows are dominated
        //   by validator signatures and do not compress (~0.55 KB of gzip+base64
        //   per settled match), so 1000 rows is ~550 KB, ~93 chunks, ~93 DOGE
        //   transactions in one cycle; 200 rows is ~19. Both trade cost against
        //   archive latency and neither affects what the archive MEANS: too large
        //   spends more DOGE per cycle, too small drains the backlog more slowly.
        this.enabled       = String(hubConfig.ANCHOR_ENABLED || cfg.ANCHOR_ENABLED || 'true') !== 'false';
        this.intervalMs    = parseInt(hubConfig.ANCHOR_INTERVAL_MS      || cfg.ANCHOR_INTERVAL_MS      || '86400000'); // daily
        this.batchSize     = parseInt(hubConfig.ANCHOR_MATCH_BATCH_SIZE || cfg.ANCHOR_MATCH_BATCH_SIZE || '200');
        this.maxBatch      = parseInt(hubConfig.ANCHOR_MAX_BATCH        || cfg.ANCHOR_MAX_BATCH        || '1000');
        this.chunkMaxBytes = parseInt(hubConfig.ANCHOR_CHUNK_MAX_BYTES  || cfg.ANCHOR_CHUNK_MAX_BYTES  || '6000');
        this.roundTimeoutMs = parseInt(hubConfig.ANCHOR_ROUND_TIMEOUT_MS || cfg.ANCHOR_ROUND_TIMEOUT_MS || '120000');
        this.chunkRetryDelayMs = parseInt(hubConfig.ANCHOR_CHUNK_RETRY_MS || cfg.ANCHOR_CHUNK_RETRY_MS || '2500');
    },

    initRetryWindows(cfg){
        // Encoder rate-limit (429) waits, which are NOT the transient-failure retry
        // above. The encoder sheds two different ways and both answer 429 + a
        // Retry-After the caller should obey rather than guess: the per-IP limiter
        // (xchain-encoder api.js, 60s window) sends a window-length Retry-After, and
        // the concurrency gate sends Retry-After: 1. A flat chunkRetryDelayMs spends
        // the whole 5-attempt budget in ~10s inside a 60s window while adding load to
        // an already-shedding replica. rateLimitMaxWaitMs caps one honoured wait;
        // rateLimitMaxWaits caps how many a single broadcast may take before the
        // anchor defers to a later flush instead of stalling this one.
        this.rateLimitMaxWaitMs = parseInt(hubConfig.ANCHOR_RATELIMIT_MAX_WAIT_MS || cfg.ANCHOR_RATELIMIT_MAX_WAIT_MS || '60000');
        this.rateLimitMaxWaits  = parseInt(hubConfig.ANCHOR_RATELIMIT_MAX_WAITS   || cfg.ANCHOR_RATELIMIT_MAX_WAITS   || '3');
        // Ambiguous-send existence poll: how long to wait for a maybe-
        // accepted anchor to reach the indexer's mined view before deferring.
        this.ambiguousPollAttempts = parseInt(hubConfig.ANCHOR_AMBIGUOUS_POLL_ATTEMPTS || cfg.ANCHOR_AMBIGUOUS_POLL_ATTEMPTS || '3');
        this.ambiguousPollDelayMs  = parseInt(hubConfig.ANCHOR_AMBIGUOUS_POLL_MS       || cfg.ANCHOR_AMBIGUOUS_POLL_MS       || '5000');
    },

    initFailoverLadder(cfg){
        // Failover-ladder step (see the derivation above; the ladder itself is in
        // rankUnlocked). The unit is BTC BLOCKS, not wall clock, precisely so
        // every hub computes the same rank unlock without clock sync; 36 blocks is
        // ~6h at the 10-minute target. The ORDERING is the load-bearing part:
        //   round timeout (120s) + DOGE burial (60 confs, ~1h)
        //     <<  36 blocks (~6h)  <<  ANCHOR_INTERVAL_MS (24h)
        // Left inequality: a healthy but slow leader is never overtaken, so the
        // federation does not pay DOGE twice for the same checkpoint (it also keeps
        // the on-chain verification wait in handleBundleDone well inside one rank).
        // Right inequality: ranks 1-3 unlock at ~6/12/18h, so up to three backups
        // still get a slot inside one publishing cycle and a dead rank 0 cannot
        // cost the federation a whole day of anchoring. Anything in ~6..144 blocks
        // (1h..24h) preserves both bounds; below the DOGE burial window it burns
        // DOGE on duplicate anchors, above ~144 a dead leader stalls a cycle.
        // Never a divergence risk in either direction: concurrent unlocked
        // publishers build byte-identical archives (see rankUnlocked).
        //
        // SCOPE: the ladder above unlocks on the ARCHIVE leg only, whose election
        // anchors to a STALLED batch, so its `since` grows without bound. On the v0
        // CHECKPOINT BUNDLE leg the newest ELIGIBLE checkpoint tracks the live BTC
        // tip, so `since` is bounded by CHECKPOINT_INTERVAL_BLOCKS *
        // ANCHOR_CHECKPOINT_EVERY_N, i.e. 6 at the defaults. Rank 1 needs `since` >=
        // 36, so at the default cadence NO rank above 0 is ever eligible and a bundle
        // has no failover at all; its liveness rests on per-cycle re-election plus
        // each hub's independent 24h timer, and a missed cycle costs one snapshot its
        // own anchor, which the chained hashes recover.
        // The inertness is therefore a property of the CADENCE, not of the ladder:
        // ANCHOR_CHECKPOINT_EVERY_N >= 6 puts the bound at or above 36 and the backup
        // ranks start unlocking here too. Raising that knob is not a cadence-only
        // change; re-read this stanza before doing it.
        // Lowering the tolerance is still not the fix: below the DOGE burial window it
        // buys duplicate spends. A meaningful bundle ladder must measure time or
        // flush attempts, not BTC-block age against a tip-tracking snapshot.
        // The same value also bounds how far a peer's claimed election_block may
        // sit from our own BTC tip in handleSignReq (anti-spam only; the security
        // property there is the DB byte-match).
        this.electionToleranceBlocks = parseInt(hubConfig.ANCHOR_ELECTION_TOLERANCE_BLOCKS || cfg.ANCHOR_ELECTION_TOLERANCE_BLOCKS || '36');
        // Failover wake. The ladder above only unlocks a rank when
        // something RE-EVALUATES it, and rank is evaluated only inside flush(); with
        // flush on the 24h interval plus size triggers, the "ranks 1-3 get a slot
        // inside one publishing cycle" bound was unreachable except by phase luck, so
        // a dead rank 0 stranded v0/archive work for a whole cycle exactly as the
        // right inequality above says it must not. This is the cadence at which a
        // BACKUP re-checks whether its rank has come up. It sits inside the ordering
        // rather than beside it:
        //   round timeout (120s)  <<  15 min  <<  36 blocks (~6h)
        // Left: a wake never fires inside a leader's own publish attempt. Right: the
        // wake is a fraction of a ladder step, so it costs at most that much latency
        // on top of the unlock it is watching for. It does NOT change how often a
        // healthy leader anchors: a wake flush runs in failover-only mode, which
        // skips every election this hub leads (see flush / publishPendingCheckpoints
        // / startArchiveRound), so rank-0 publishing keeps its interval and size
        // triggers and the federation still pays for one anchor per checkpoint.
        this.rankWakeMs = parseInt(hubConfig.ANCHOR_RANK_WAKE_MS || cfg.ANCHOR_RANK_WAKE_MS || '900000');  // 15 min
    },

    initStartupFlush(cfg){
        // Startup catch-up flush. The interval timer fires first after a FULL
        // ANCHOR_INTERVAL_MS, and the rank wake runs failover-only, so a hub that was
        // recreated more often than once per interval never ran a leader flush at
        // all: the five testnet validators cut checkpoints every 6 BTC blocks for
        // weeks and anchored none of them, with no log line saying so.
        // One normal flush shortly after start closes that hole. It is idempotent
        // by construction (a row already anchored carries anchor_txid, and a peer's
        // anchor is stamped by the BUNDLE_DONE drain that runs first inside flush), so
        // a rolling restart of the whole federation still pays for one anchor per
        // checkpoint. The delay lets the signer hooks, the BTC tip and the DOGE
        // balance source settle first; flush is fail-closed on all three anyway.
        // 0 disables (tests, and operators who want the interval to be the only
        // leader cadence); garbage or a negative value falls back to the default.
        this.startupFlushMs = parseInt(hubConfig.ANCHOR_STARTUP_FLUSH_MS || cfg.ANCHOR_STARTUP_FLUSH_MS, 10);
        if(!Number.isFinite(this.startupFlushMs) || this.startupFlushMs < 0) this.startupFlushMs = 60000;
        this._startupTimer = null;
    },

    initConfirmedInputPolicy(cfg){
        // CONFIRMED INPUTS ONLY, the same rule the PRICE rail adopted.
        // Spending our own unconfirmed change chains every anchor onto the one
        // before it. Dogecoin Core 1.14 miners score each transaction on its OWN
        // fee rate, not the ancestor package, so a well-paid child never lifts a
        // cheap or stuck parent: one anchor that does not mine then strands every
        // anchor built on its change until an operator clears the mempool. Each
        // anchor must stand alone and be judged on its own rate; the encoder's
        // package uplift stays as the safety net on chains that do score by package.
        // The escape hatch is for venues that mine on demand (regtest), where
        // chaining costs nothing and waiting for a confirmation would stall a harness.
        // Archive CHUNKS are the one designed exception: they descend from the head
        // on purpose and are always allowed to spend it (see publishArchive).
        this.allowUnconfirmedInputs =
            String(hubConfig.ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS ||
                   cfg.ANCHOR_PUBLISH_ALLOW_UNCONFIRMED_INPUTS || 'false') === 'true';
        // Set by a flush that had to stand down for want of a confirmed input while
        // it (probably) led a pending row. The next rank wake then runs a NORMAL
        // flush instead of failover-only, so the deferral costs one wake period
        // (15 min) rather than one ANCHOR_INTERVAL_MS (24 h). Cleared at the start
        // of every normal flush; re-set only by another deferral, so a wallet that
        // has confirmed outputs again returns the wake to failover-only the first
        // time it runs. This is the one case where the wake may publish a led row.
        this._leaderRetryDue = false;
        this.noConfirmedUtxoDeferrals = 0;
        this.lastNoConfirmedUtxoAt    = null;
        // Bundles held back because the publisher-attestation round did not reach quorum.
        // Climbing while the federation is whole means peers are not co-signing; climbing
        // during a rolling deploy is expected and stops when the roll finishes.
        this.unattestedDeferrals      = 0;
        this.lastUnattestedDeferralAt = null;
        this.lastUtxoReserve          = null;   // { total, confirmed, unconfirmed, known, at }
    },

    initSpendGuards(cfg){
        // Confirmation watchdog over this hub's OWN anchor broadcasts (checkpoint
        // anchors, archive heads and chunks). Without it an anchor that never mines
        // leaves getanchorstatus reporting a healthy last publish while the wallet's
        // whole balance sits as change behind the stuck transaction. Same design as
        // the PRICE rail's watchdog: in-memory, fail-soft, never re-broadcasts or
        // fee-bumps.
        this._pendingConfirmations   = new Map();   // txid -> { txid, kind, ref, sentAt }
        this.pendingConfirmationsMax = 200;
        this.confirmCheckIntervalMs  = parseInt(hubConfig.ANCHOR_CONFIRM_CHECK_MS || cfg.ANCHOR_CONFIRM_CHECK_MS, 10);
        if(!Number.isFinite(this.confirmCheckIntervalMs) || this.confirmCheckIntervalMs < 0) this.confirmCheckIntervalMs = 300000;   // 5 min
        this.confirmStaleMs = parseInt(hubConfig.ANCHOR_CONFIRM_STALE_MS || cfg.ANCHOR_CONFIRM_STALE_MS, 10);
        if(!Number.isFinite(this.confirmStaleMs) || this.confirmStaleMs < 0) this.confirmStaleMs = 1800000;   // 30 min
        this._confirmTimer            = null;
        this.confirmedPublishes       = 0;
        this.confirmationCheckFailures = 0;
        this.lastConfirmationCheckAt  = null;
        this.lowBalanceThreshold = parseFloat(hubConfig.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
        // Shared SpendGuard for the on-chain anchor spend path. Adds the
        // per-window spend ceiling (count + $2000-clamped USD budget, default-ON) and
        // a per-capability runtime pause on top of the existing balance floor, so an
        // operator can halt anchor DOGE spend at runtime and a fee-runaway is bounded.
        // Its balance floor mirrors lowBalanceThreshold (the flush already gates on it).
        this.spendGuard = new SpendGuard('ANCHOR', cfg, 'StateAnchorPublisher');
        this.spendGuard.minBalance = this.lowBalanceThreshold;
    },

    initCheckpointCadence(cfg){
        // Decouple on-chain anchoring from checkpoint production: checkpoints are
        // free (off-chain hub-DB mirror, good for light-client verify) but each
        // on-chain anchor spends real DOGE. Only anchor every Nth
        // checkpoint (recovery needs just the LATEST anchored checkpoint per chain, so
        // the skipped rounds stay off-chain). N=1 keeps the original
        // anchor-every-checkpoint behaviour.
        //
        // Eligibility is a CHECKPOINT ORDINAL, not the raw seq. checkpoint_seq is the
        // round's BTC snapshot_block (deriveCheckpointSeq), and the cadence latch
        // advances it by exactly CHECKPOINT_INTERVAL_BLOCKS per round
        // (StateCheckpointEngine.tick), so `seq % N` is NOT a 1-in-N sample: it is a
        // residue class pinned by the first checkpoint after the latch is seeded.
        // Whenever N shares a factor with the interval (N=2 or 3 against the default 6)
        // every round lands in the same residue, so the federation either anchors every
        // cadence or anchors NOTHING, permanently and with no eligible row to log about.
        // Dividing by the interval first gives an ordinal that advances by 1 per round,
        // so the residues cycle: the worst case is N-1 rounds of delay, never a halt.
        // Both knobs are already required to be fleet-uniform, and checkpoint_seq is
        // consensus data, so the predicate stays deterministic fleet-wide. At the
        // default N=1 (MOD(anything,1)=0) it is a no-op, exactly as before.
        this.anchorEveryNCheckpoints = Math.max(1,
            parseInt(hubConfig.ANCHOR_CHECKPOINT_EVERY_N || cfg.ANCHOR_CHECKPOINT_EVERY_N || '1') || 1);
        // The engine's own cadence step (StateCheckpointEngine.js), resolved through the
        // one shared function it also calls so the two cannot drift. Always positive: a
        // zero divisor makes the SQL MOD NULL, which would silently select nothing.
        this.checkpointIntervalBlocks = resolveCheckpointIntervalBlocks(cfg);
    },

    initDogePipeline(cfg){
        this.dogeAddress   = hubConfig.DOGE_ADDRESS    || cfg.DOGE_ADDRESS    || '';
        this.dogePubkeyHex = hubConfig.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        let encoderUrl = hubConfig.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = hubConfig.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks; unset -> borrow the price publisher's DOGE signer.
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;
    }

};
