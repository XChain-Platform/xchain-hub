/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

// Operator-facing stats. Exposed so callers can surface cumulative archive
// health without grepping logs.
function getAnchorStats(){
    return {
        enabled:            this.enabled,
        anchorsPublished:   this._anchorsPublished,
        sectionsAnchored:   this._sectionsAnchored,
        bundlesOversize:    this._bundlesOversize,
        anchorsAsLeader:    this._anchorsAsLeader,
        anchorsAsBackup:    this._anchorsAsBackup,
        anchorsAdopted:     this._anchorsAdopted,
        lastAnchorRank:     this._lastAnchorRank,
        skippedNotOurElection: this._skippedNotOurElection,
        skippedLeaderOnWake:   this._skippedLeaderOnWake,
        startupFlushMs:        this.startupFlushMs,
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
        flushesSkippedInFlight:   this.flushesSkippedInFlight || 0,
        flushInFlight:            !!this._flushing,
        flushStartedAt:           this._flushStartedAt || null,
        lastFlushSkippedAt:       this.lastFlushSkippedAt || null,
        archiveChunkLosses:       this._archiveChunkLosses,
        anchorMarkerRetentionMs:  this.anchorMarkerRetentionMs,
        anchorMarkersPruned:      this.anchorMarkersPruned,
        dogeAddress:              this.dogeAddress || null,
        dogeBalance:              this._lastBalance,
        dogeBalanceAt:            this._lastBalanceAt,
        lowBalanceThreshold:      this.lowBalanceThreshold,
        spendGuard:               this.spendGuard.stats()
    };
}

module.exports = { getAnchorStats };
