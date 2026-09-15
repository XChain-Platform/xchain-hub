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
 * XChain Hub - Attestation Publisher: construction
 *
 * The publisher's constructor in named steps, called in the order the fields were
 * assigned before the split, so an instance carries the same properties with the
 * same values in the same order. Plain functions rather than prototype methods:
 * nothing outside construction may call them.
 *
 ********************************************************************/

'use strict';

const EncoderClient = require('../../peers/encoder_client.js');
const SpendGuard    = require('../../lib/spend_guard.js');
const { AtMostOnce } = require('../../lib/idempotent_broadcast.js');
const hubConfig = require('../../config');
const { APPROX_BTC_BLOCK_MS, DEFAULT_FAILOVER_WINDOW_BLOCKS, DEFAULT_FAILOVER_POLL_MS,
        DEFAULT_LEADER_RETRY_MS, DEFAULT_PUBLISHED_RETENTION_MS } = require('./constants.js');

// The kill switch, the spend ceiling and the two durable audit trails beside the WAL.
function initPublisherSpend(self, cfg){
    // Operator kill switch. Mirrors StateAnchorPublisher's
    // ANCHOR_ENABLED gate. Halts outbound BTC spend (both the live path and the
    // failover sweep) during an incident without tearing down config. Default on.
    self.enabled = String(hubConfig.ATTEST_ENABLED || cfg.ATTEST_ENABLED || 'true') !== 'false';

    // Shared SpendGuard (supersedes the old per-publisher SpendCeiling).
    // Per-window spend ceiling (count + a $2000-clamped USD-cents budget, default-ON),
    // wallet balance floor, and a per-capability runtime pause. The pause folds into
    // allow(), which the live path AND the sweep both consult, so an operator can halt
    // this publisher's PRIMARY (leader) BTC spend at runtime.
    self.spendGuard = new SpendGuard('ATTEST', cfg, 'AttestationPublisher');

    // Count of durable-WAL enqueue failures. A non-zero value means a
    // finalized response could not be recorded before broadcast; surfaced via
    // getPublisherStats() so it is visible without log-grepping.
    self._enqueueFailures = 0;

    // Append-only, fsync'd audit log of ACTUAL on-chain spends (rid,
    // txid, ts). The WAL queue is a pre-send intent record that is REMOVED on
    // success, so post-success reconstruction otherwise depends on stdout retention;
    // this file is the durable record of what BTC fee was actually spent.
    self.spendLogPath = self.queuePath.replace(/\.jsonl$/, '') + '.spend.jsonl';

    // rid -> timestamp of the last AMBIGUOUS broadcast failure (a
    // timeout / reset / 5xx after the request left the wire, where the BTC node may
    // have actually accepted the tx). The sweep must NOT re-broadcast such an rid
    // until it has had time to reach the indexer's mined view (leaving the pending
    // set), or a second BTC fee is spent on a landed tx. Cleared once the rid drops
    // from the pending set (landed/expired) or the cooldown proves it never landed.
    self._ambiguousSends = new Map();
}

// The failover and replay cadences, and the default encoder pipeline's wiring.
function initPublisherFailover(self, cfg){
    // Failover / replay tuning
    self.failoverWindowBlocks = parseInt(hubConfig.ATTESTATION_FAILOVER_WINDOW_BLOCKS || cfg.ATTESTATION_FAILOVER_WINDOW_BLOCKS || DEFAULT_FAILOVER_WINDOW_BLOCKS);
    self.failoverPollMs       = parseInt(hubConfig.ATTESTATION_FAILOVER_POLL_MS       || cfg.ATTESTATION_FAILOVER_POLL_MS       || DEFAULT_FAILOVER_POLL_MS);
    self.leaderRetryMs        = parseInt(hubConfig.ATTESTATION_LEADER_RETRY_MS        || cfg.ATTESTATION_LEADER_RETRY_MS        || DEFAULT_LEADER_RETRY_MS);
    self.approxBlockMs        = parseInt(hubConfig.ATTESTATION_BLOCK_MS               || cfg.ATTESTATION_BLOCK_MS               || APPROX_BTC_BLOCK_MS);

    // How long after an ambiguous send the sweep defers re-broadcast,
    // giving a possibly-accepted tx time to reach the indexer's mined view before
    // we conclude it never landed. Defaults to one failover window.
    self.ambiguousCooldownMs  = parseInt(hubConfig.ATTESTATION_AMBIGUOUS_COOLDOWN_MS  || cfg.ATTESTATION_AMBIGUOUS_COOLDOWN_MS  || String(self.failoverWindowBlocks * self.approxBlockMs), 10);

    // Optional BTC encoder wiring (default pipeline). Mirrors OraclePublisher.
    let encoderUrl = hubConfig.BTC_ENCODER_URL || cfg.BTC_ENCODER_URL || '';
    let encoderKey = hubConfig.BTC_ENCODER_API_KEY || cfg.BTC_ENCODER_API_KEY || '';
    self.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;
    self.btcAddress    = hubConfig.BTC_ADDRESS    || cfg.BTC_ADDRESS    || '';
    self.btcPubkeyHex  = hubConfig.BTC_PUBKEY_HEX || cfg.BTC_PUBKEY_HEX || '';

    // Operator-supplied hooks
    self.broadcastFn  = null;  // fn(wirePayload) → Promise<{txid}>
    self.walletSignFn = null;  // fn(psbtHex)     → Promise<txHex>
}

// The at-most-once guards, the quarantine set and the marker-retention window.
function initPublisherGuards(self, cfg){
    self._sweepTimer = null;

    // Cumulative on-chain broadcast outcomes. Surfaced via getPublisherStats()
    // so operators can detect persistent broadcast failures without log-grepping.
    self._broadcastSucceeded = 0;
    self._broadcastFailed    = 0;

    // Publications whose durable marker records an INTENT to broadcast
    // with no confirmation: the process died between recording intent and marking
    // the send done, so whether the BTC tx landed is unknown. Never auto-rebroadcast
    // (that is the second-fee spend the marker exists to prevent); surfaced at
    // startup by hydratePublishedMarkers for an operator to verify and replay.
    // Holds `publicationKey` entries, plus a bare request id for a pre-upgrade
    // marker row that names no status and so holds the whole request.
    self._quarantinedRequests = new Set();

    // In-process at-most-once guard. Publications broadcast this process lifetime
    // are recorded here the instant broadcaster(...) succeeds. If the post-broadcast
    // queue rewrite fails (disk full, permissions, transient I/O), the just-published
    // entry stays on the durable queue file; without this set the next processQueue
    // sweep would re-read and RE-BROADCAST it, spending a real BTC fee twice for the
    // same request. Consulted before every (re-)broadcast so a failed rewrite can
    // never become a duplicate on-chain ATTEST. Cleared once the durable queue is
    // confirmed rewritten (mirrors OraclePublisher._publishedRounds). In-process
    // only: the restart case is covered by the durable `attest_published_requests`
    // marker below, and only where a hub DB is wired; with no DB this
    // set is still the whole guard and a restart can replay.
    self._publishedRequests = new AtMostOnce();

    // Retention window for the durable attest_published_requests marker table.
    // One row lands per ATTEST v1 request forever, so the money-bearing broadcast
    // path grew a table (and, through hydratePublishedMarkers, a per-restart
    // SELECT) without bound. Only CONFIRMED rows are ever pruned and only past the
    // re-presentability floor; see prunePublishedRequests for both invariants.
    // 0 disables pruning; garbage or a negative value falls back to the default.
    self.publishedRequestsRetentionMs = parseInt(
        hubConfig.ATTEST_PUBLISHED_REQUESTS_RETENTION_MS ||
        cfg.ATTEST_PUBLISHED_REQUESTS_RETENTION_MS, 10);
    if (!Number.isFinite(self.publishedRequestsRetentionMs) || self.publishedRequestsRetentionMs < 0){
        self.publishedRequestsRetentionMs = DEFAULT_PUBLISHED_RETENTION_MS;
    }
    // Lifetime count of confirmed marker rows the retention sweep deleted, the
    // in-flight sweep handle (fire-and-forget on the sweep path, so this is what
    // makes it awaitable in tests), and whether a marker has been written since the
    // last sweep. The table only grows when this publisher spends, so a hub that
    // has published nothing since the last sweep has nothing to age out.
    self.publishedRequestsPruned = 0;
    self._retentionSweep         = null;
    self._markersAddedSinceSweep = false;
}

module.exports = {
    initPublisherSpend,
    initPublisherFailover,
    initPublisherGuards
};
