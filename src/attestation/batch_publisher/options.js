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
 * AttestationBatchPublisher: construction
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
const hubConfig     = require('../../config');

// The publisher's own files, its own spend budget, the one operator DOGE wallet and
// the broadcast hooks.
function initBatchFiles(self, cfg){
    // Its OWN files, never the PRICE publisher's. The buffer records what a window
    // was built from at the moment it published, so an operator replaying a
    // dead-lettered or quarantined window has the content and does not have to
    // reconstruct it from a table that has since moved on.
    self.bufferPath = hubConfig.ATTEST_BATCH_BUFFER_PATH || cfg.ATTEST_BATCH_BUFFER_PATH ||
                      './data/attest-batch-buffer.jsonl';
    self.deadLetterPath = self.bufferPath.replace(/\.jsonl$/, '') + '.deadletter.jsonl';

    // Its OWN spend guard: a separate per-window ceiling and pause switch, so an
    // operator can halt attestation batches without halting price publishing.
    self.spendGuard = new SpendGuard('ATTEST_BATCH', cfg, 'AttestationBatchPublisher');

    // The one operator DOGE wallet, read from the same keys OraclePublisher reads:
    // there is one funded address and one signer module, and this is its third
    // consumer. Only the SPEND BUDGET is separate, never the wallet.
    self.dogeAddress   = hubConfig.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
    self.dogePubkeyHex = hubConfig.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
    self.lowBalanceThreshold = parseFloat(hubConfig.DOGE_LOW_BALANCE_THRESHOLD ||
                                          cfg.DOGE_LOW_BALANCE_THRESHOLD || '10');
    self.spendGuard.minBalance = self.lowBalanceThreshold;
    self.allowUnconfirmedInputs =
        String(hubConfig.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS ||
               cfg.ORACLE_PUBLISH_ALLOW_UNCONFIRMED_INPUTS || 'false') === 'true';

    let encoderUrl = hubConfig.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
    let encoderKey = hubConfig.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
    self.encoder = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

    self.broadcastFn  = null;
    self.walletSignFn = null;
    self.getBalanceFn = null;
}

// The signing-round timeout and the refusal-retry bound.
function initBatchTimeouts(self, cfg){
    // The signing round reuses the PRICE batch signer's knobs (D76): the two rounds
    // have the same shape and the same failure mode, and a second family of timeout
    // names would be a second thing to drift.
    self.signTimeoutMs = parseInt(hubConfig.ORACLE_BATCH_SIGN_TIMEOUT_MS ||
                                  cfg.ORACLE_BATCH_SIGN_TIMEOUT_MS || '15000', 10);
    if(!Number.isFinite(self.signTimeoutMs) || self.signTimeoutMs <= 0) self.signTimeoutMs = 15000;

    // How many times one window may be rebuilt after a PROVABLY-UNSENT head refusal
    // before it latches like any other broadcast failure. Bounded rather than endless
    // because a refusal that never clears (a wire the encoder rejects on its content,
    // not on its funding) would otherwise re-propose and re-collect a signing quorum
    // every window forever, and the federation's signing capacity is the scarce thing.
    self.maxRefusalAttempts = parseInt(hubConfig.ATTEST_BATCH_MAX_REFUSAL_ATTEMPTS ||
                                       cfg.ATTEST_BATCH_MAX_REFUSAL_ATTEMPTS || '3', 10);
    if(!Number.isFinite(self.maxRefusalAttempts) || self.maxRefusalAttempts < 1)
        self.maxRefusalAttempts = 3;
}

// The per-process runtime state: timers, the sweep's own guards, the report-once sets
// and the stats block.
function initBatchRuntime(self){
    self._windowTimer = null;
    self._peerHandler = null;
    self._signRound   = null;
    self._sweeping    = false;
    // Set by start() and cleared by stop(): the window timer re-arms itself from
    // inside its own callback, so this is what tells a landing sweep that the engine
    // it is re-arming has since been stopped.
    self._running     = false;
    // The oldest window a sweep will consider, resolved at start(). Null until then,
    // which means "no floor" and is what a directly driven sweep sees.
    self._floorWindow = null;
    // Windows this hub has already declined this process lifetime because
    // their durable marker is intent-only. Logged once each rather than once per
    // sweep, which on a short regtest window is once every few seconds.
    self._quarantined = new Set();
    // windowStart -> how many times a provably-unsent head refusal has sent this
    // window back for a rebuild. In memory only, deliberately: the durable record of
    // such an attempt is the ABSENCE of a marker, and a restart that re-tried a
    // refused window from zero costs nothing because nothing was ever sent or spent.
    self._refusalAttempts = new Map();
    // Why the last anchor read came back null, and which reason has already been
    // logged. Both null while the anchor resolves.
    self._anchorFailure = null;
    self._anchorWarned  = null;
    // 'pushed' (a chain_tips row) or 'observed' (the attestation poll's tip) once
    // an anchor has resolved; null before. Logged on every change, read by stats.
    self._anchorSource  = null;
    // The newest window this hub holds a marker for, read once with the floor, and
    // the windows already reported as gaps below it (report-once, like _quarantined).
    self._newestMarkerWindow = null;
    self._coverageGaps       = new Set();

    self.stats = {
        windowsPublished: 0, windowsEmpty: 0, windowsDeferred: 0,
        coverageGapsDetected: 0,
        windowsDeadLettered: 0, windowsQuarantined: 0, windowsRefusalRetried: 0,
        wiresBroadcast: 0, rowsPublished: 0,
        signRounds: 0, signQuorums: 0, signTimeouts: 0,
        signaturesProvided: 0, signRefusals: 0, signRefusalsNoChainTip: 0,
        landedRecorded: 0, lastPublishedWindow: null, lastPublishedTxid: null
    };
}

module.exports = {
    initBatchFiles,
    initBatchTimeouts,
    initBatchRuntime
};
