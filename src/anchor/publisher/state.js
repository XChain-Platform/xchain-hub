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
 * XChain Hub - ANCHOR publisher runtime state
 *
 * The in-memory state a publisher carries between flushes: the round handles, the
 * operator counters, what it observed of other hubs' archive rounds, its indexer
 * clients, the deferred-announcement queues and the marker retention window.
 *
 ********************************************************************/

'use strict';

const coins = require('../../coins');
const hubConfig = require('../../config');
const { DEFAULT_ANCHOR_MARKER_RETENTION_MS } = require('./constants.js');

module.exports = {

    initRoundState(){
        this._archiveRound     = null;  // leader-side archive signing round (one at a time)
        // The round whose publishArchive is IN FLIGHT. _archiveRound covers only the
        // signature-collection phase and is cleared the moment quorum is met, which leaves
        // the whole publish unguarded: quorum can arrive on a peer message (handleSign),
        // outside flush()'s _flushing mutex, and publishArchive does not arm its durable
        // dedupe marker (recordArchiveIntent) until AFTER the publisher-attestation round,
        // so a timer flush in that window rebuilds the same still-pending rows and spends
        // DOGE a second time. This field covers quorum-to-return.
        this._archivePublishing = null;
        this._attestRound        = null;  // leader-side publisher-attestation round (one at a time)
        this._archiveAttestRound = null;  // leader-side ARCHIVE publisher-attestation round (one at a time)
        this._pendingMatches   = 0;     // size trigger; DB is the source of truth
        this._callHandler      = null;
        this._flushing         = false;
        this._timer            = null;
        this._messageHandler   = null;
        this._matchHandler     = null;
        this._loggedNoPipeline = false;
        // Cumulative count of archive chunks that failed all broadcast retries.
        // A lost chunk is a durability failure (recovery needs every chunk), so
        // a pattern of losses is surfaced here for operator visibility rather
        // than requiring a log-grep.
        this._archiveChunkLosses = 0;
    },

    initCounters(){
        // Cumulative count of checkpoint BUNDLES successfully published on-chain. The
        // name is a documented RPC field with no consumer outside the hub, so it keeps
        // it and changes what it counts (D13): one v0 per network per cycle, where the
        // retired per-chain wires counted one anchor per chain.
        this._anchorsPublished = 0;
        // Chains carried by those bundles (one per section, so this is the per-chain
        // figure), and bundles REFUSED for exceeding the byte budget with a single
        // section that cannot fit even with a zero-signature tail. Both exist for the
        // operator's post-deploy check, not for a dashboard tile.
        this._sectionsAnchored = 0;
        this._bundlesOversize  = 0;
        // Split of that count by the rank this hub held for the row it anchored.
        // A backup-rank publish means the elected rank-0 publisher did NOT anchor
        // within its ladder step, so the federation is running on failover with
        // reduced anchor redundancy. Undifferentiated, that is invisible: the
        // checkpoints still land on cadence and every staleness/balance term stays
        // green until the backups fail too. Same idea as OraclePublisher's
        // _leaderRounds/_followerRounds on the PRICE rail.
        this._anchorsAsLeader  = 0;
        this._anchorsAsBackup  = 0;
        // Counts bundles STAMPED without paying (the existence check adopted an
        // already-mined one). Kept apart from _anchorsPublished so the leader/backup
        // split keeps summing to the bundles this hub actually spent DOGE on.
        this._anchorsAdopted   = 0;
        // Rank state of the most recent successful anchor, surfaced via
        // getAnchorStats so an operator sees the CURRENT posture, not only a
        // lifetime tally that a long healthy history would dilute.
        this._lastAnchorRank   = null;   // { network, snapshotBlock, chains, myRank, publisherCount, isLeader, at }
        // Cumulative count of candidate checkpoints a flush looked at and stood
        // down from, split by why. Both skips are correct behavior and were silent,
        // which made a federation with ZERO anchors ever published indistinguishable
        // from one with nothing to anchor: every wake walked the same rows and
        // logged nothing. Exposed via getAnchorStats so getanchorstatus answers
        // "is anyone even being asked to publish this?" without a code read.
        //   notOurElection: another hub is the unlocked publisher for the bundle (or
        //                   this hub's backup rank has not unlocked yet)
        //   leaderOnWake:   this hub leads the bundle but the flush was the failover-
        //                   only wake, which never publishes a led election
        // Both count SECTIONS, not bundles, so the operator-facing figure stays "how
        // many pending checkpoints did this flush stand down from".
        this._skippedNotOurElection = 0;
        this._skippedLeaderOnWake   = 0;
        // Last DOGE balance observed by checkBalance (refreshed each flush) and
        // when, surfaced via getAnchorStats so an operator/monitor can watch the
        // publisher wallet's runway (it spends real DOGE on every anchor cycle)
        // without log-grepping the low-balance warning. null until the first
        // balance read (no pipeline / before first flush).
        this._lastBalance   = null;
        this._lastBalanceAt = null;
    },

    initObservedArchiveState(){
        // Locally-observed archive-round leaders: batch_seq -> Set(elected leader
        // pubkeys). Populated in handleSignReq once a SIGN_REQ sender has validated
        // as the (rank-unlocked) elected archive leader for that batch_seq AND its
        // signature over the archive canonical verifies (the rank ladder alone is
        // wire-keyed, so the signature is what proves the sender holds the key it
        // names), and consulted in handleFinalized to authenticate the
        // FINALIZED sender. The archive election is keyed on election_block (the
        // BTC tip at archive time), which the FINALIZED canonical does NOT carry,
        // so it cannot be re-derived at finalize time; this binds it from the
        // round we actually observed. Bounded (batch_seq is monotonic, evict the
        // smallest keys) so a long-lived hub never grows this without limit.
        this._observedArchiveLeaders = new Map();
        this._observedArchiveLeadersCap = 256;
        // Checkpoint IDENTITY observed per batch_seq (from the SIGN_REQ, recorded
        // alongside the leader). FINALIZED carries only batch_seq, not the
        // checkpoint identity getanchoraction needs, so handleFinalized reads this
        // to verify the batch's archive checkpoint landed on DOGE before mirroring
        // the anchor_archive reward (mirrored below the archive-reward
        // flag-day; derived on-chain from the ANCHOR v1 tail at/above it). Identity only,
        // re-SELECTed against our own rows, and evicted in lockstep with the leader map.
        this._observedArchiveCheckpoints = new Map();
        // Archive MEMBERSHIP observed per (batch_seq, proposer), from a SIGN_REQ body
        // this hub decompressed, CRC-checked and byte-verified against its own rows for
        // the co-sign decision. The XANCFIN canonical commits to (batch_seq, txid, match
        // COUNT) and never to WHICH rows, so handleFinalized holds the announced id
        // lists to this set before anything is stamped. Recorded ONLY where the body was
        // already parsed, so no hub decompresses an extra archive on the p2p path.
        this._observedArchiveContents = new Map();
        // Highest batch_seq this hub has learned the FEDERATION already consumed, from
        // evidence other than its own rows: an authenticated XANC_FINALIZED, a co-sign
        // refusal naming the refuser's own consumed seq, or an archive head resolved
        // on-chain. -1 means "nothing beyond what our tables show".
        //
        // getNextBatchSeq is MAX(batch_seq)+1 over THIS hub's rows, which equals the
        // federation's next seq only while every back-fill has landed. A hub that missed
        // one (a withheld/dropped XANC_FINALIZED) draws a seq the federation already
        // spent and rebuilds rows it already archived. This floor carries that knowledge
        // until the missed back-fill actually arrives, so the stale hub converges on the
        // leader's seq without a schema change (there is no table to persist it in, so it
        // is deliberately process-local and re-learned after a restart from the next
        // FINALIZED, refusal or on-chain adopt).
        this._observedConsumedBatchSeq = -1;
        // Sanity bound on that floor. A Byzantine (but signature-verified) member could
        // otherwise announce an absurd seq and permanently skip the numbering; a jump
        // wider than this is logged and ignored, and the honest floor arrives with the
        // next announcement.
        this._archiveSeqFloorMaxJump = 1024;

    },

    initIndexers(cfg){
        // Per-coin indexer JSON-RPC clients (same env -> p2pConfig surface as
        // ReorgHandler / CrossChainCallEngine). Used ONLY for on-chain ANCHOR
        // verification, which always queries the DOGE indexer: every ANCHOR (for a
        // BTC/LTC/DOGE checkpoint) is a DOGE transaction, and only the DOGE
        // decoder+indexer decode the P2SH anchor payload (a raw getrawtransaction
        // cannot bind the tx to the checkpoint). Unset -> verifyAnchorOnChain
        // returns 'no-indexer' and the receiver paths abstain (fail closed); wire
        // DOGE_INDEXER_URL fleet-wide before deploy.
        this.indexers = {};
        for(let coin of coins.ALLOWED_COINS){
            this.indexers[coin] = {
                url: hubConfig.env()[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: hubConfig.env()[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }
        // Confirmation depth an ANCHOR must reach on DOGE before a peer's
        // announcement is trusted for stamp/reward (operator decision: reject
        // 0-conf, depth = XCHAIN_CONFIRMATIONS_DOGE). Same env -> p2pConfig ->
        // per-coin default idiom the cross-chain engines use (floor-clamped on
        // mainnet and testnet, see coins.resolveConfirmations).
        //
        // This is HUB-LOCAL trust policy and it is the only end of the anchor path the
        // knob moves. The BTC indexer's anchor-reward MINT gate does NOT read it: minting
        // happens inside the block transaction, so its depth is a ledger input frozen at
        // ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS (anchor_reward_gate.js), equal to the
        // per-coin default. Because the resolver's floor is that same default, a hub on
        // mainnet or testnet can never attest shallower than the fleet will mint. On
        // regtest a lowered override deliberately can: the hub attests early and the BTC
        // indexer defers the block until the anchor reaches the frozen depth, which is a
        // drill-venue property to plan around, not a divergence.
        this.dogeConfirmations = coins.resolveConfirmations(cfg, this.network).DOGE;
    },

    initDeferralQueues(cfg){
        // XANC_BUNDLE_DONE is broadcast the instant broadcastWithRetry
        // returns a txid, i.e. while the DOGE anchor is still in the mempool, but the
        // receiver only stamps once that anchor is buried dogeConfirmations deep (60 on
        // DOGE, ~1 hour). The announcement is one-shot, so at announce time every peer
        // saw 'absent' and returned early, leaving anchor_txid NULL forever: the
        // duplicate-anchor suppression the whole `anchor_txid IS NULL` selector depends
        // on could never engage, and each hub re-anchored (real DOGE) as its failover
        // rank unlocked. Receivers therefore QUEUE an announcement that is authentic but
        // not yet buried and re-run the on-chain verification on a timer. Bounded by
        // size and TTL so a never-mined (evicted or replaced) tx cannot suppress a
        // needed re-anchor indefinitely.
        this._deferredBundleDone  = new Map();
        // Fabricated-txid half: the SAME queue shape for XANC_FINALIZED. The
        // announcement rides at 0 confirmations too, so the archive head is normally
        // 'absent' at receipt; the entry is re-verified here until the head is buried
        // (then it stamps) or the TTL clears it. Bounded by the same size + TTL knobs.
        this._deferredFinalized   = new Map();
        // The PUBLISHER's own half of the same 0-confirmation problem. The hub never
        // writes its anchor_reward_attestations row the instant _broadcastWithRetry
        // returns a txid, i.e. on mempool acceptance: that row is append-only and
        // never retracted (hub_db_sync HUB_STATE_TABLES) while the BTC indexer derives
        // a COLLECT-spendable validator_rewards row from it, so an evicted or reorged
        // anchor would mint a permanent reward for a transaction the chain never
        // carried. Confirm THEN write: the attestation is queued here and only written
        // by drainDeferredRewardAttest, on the same size + TTL knobs as the two
        // announcement queues.
        this._deferredRewardAttest = new Map();
        this.announceRetryMs      = parseInt(hubConfig.ANCHOR_ANNOUNCE_RETRY_MS      || cfg.ANCHOR_ANNOUNCE_RETRY_MS      || '300000');    // 5 min
        this.announceRetryTtlMs   = parseInt(hubConfig.ANCHOR_ANNOUNCE_RETRY_TTL_MS  || cfg.ANCHOR_ANNOUNCE_RETRY_TTL_MS  || '21600000');  // 6 h, ~6x the 60-conf DOGE window
        this.announceQueueMax     = parseInt(hubConfig.ANCHOR_ANNOUNCE_QUEUE_MAX     || cfg.ANCHOR_ANNOUNCE_QUEUE_MAX     || '500');
        this._deferTimer          = null;
        this._rankWakeTimer       = null;   // failover wake, see rankWakeMs
    },

    initMarkerRetention(cfg){
        // How long a durable broadcast intent with no mined anchor HOLDS its
        // checkpoint (see the anchor_published_checkpoints block below). Same bound and
        // same reasoning as announceRetryTtlMs above: ~6x the 60-conf DOGE window, past
        // which a send that never relayed is not coming back and holding the row costs
        // more than re-broadcasting it.
        this.anchorIntentTtlMs    = parseInt(hubConfig.ANCHOR_INTENT_TTL_MS || cfg.ANCHOR_INTENT_TTL_MS || '21600000');   // 6 h
        // Retention window for the two durable anchor marker tables. Both appended one
        // row per DOGE-spending broadcast and never removed one, so they grew for the
        // life of the deployment while their oracle_published_rounds sibling was swept.
        // Only CONFIRMED rows are pruned, and only past a floor derived from
        // anchorIntentTtlMs; see pruneAnchorMarkers for both invariants. 0 disables
        // pruning; garbage or a negative value falls back to the default.
        this.anchorMarkerRetentionMs = parseInt(hubConfig.ANCHOR_MARKER_RETENTION_MS ||
                                                cfg.ANCHOR_MARKER_RETENTION_MS, 10);
        if(!Number.isFinite(this.anchorMarkerRetentionMs) || this.anchorMarkerRetentionMs < 0)
            this.anchorMarkerRetentionMs = DEFAULT_ANCHOR_MARKER_RETENTION_MS;
        // Lifetime count of confirmed anchor marker rows the retention sweep deleted,
        // and the in-flight sweep handle. The sweep is fire-and-forget on the flush
        // path (retention must never stall an anchor), so the handle is what makes it
        // awaitable in tests.
        this.anchorMarkersPruned = 0;
        this._retentionSweep     = null;
    }

};
