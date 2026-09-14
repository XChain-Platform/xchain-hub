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
 * XChain Hub - ConsensusInputMonitor
 *
 * Alarm surface for CONSENSUS-INPUT fetches: the reads of the BTC
 * indexer that lock a round's validator set (getcapabilityvalidators,
 * getstakeweightsbycapability, getactivevalidators,
 * getactivestakeweights).
 *
 * Those fetches fail CLOSED (they return null and the caller declines
 * to vote / aborts the round), which is correct but silent: a hub whose
 * indexer is unreachable, whose key is wrong, or whose responses are
 * malformed simply stops participating in consensus while its process,
 * its port and its /health probe all look fine. The 2026-06-24 deep
 * review flagged that as a recurring fail-open-observability pattern:
 * the safety behaviour is right, the operator signal is missing.
 *
 * This monitor is the signal. It counts outcomes per failure reason,
 * tracks the consecutive-failure streak, logs a throttled loud line per
 * reason (so a sustained outage costs one line per window, not one per
 * call), and raises `alerting` once the streak crosses a threshold.
 * api.js folds the alerting flag into /health, which is what turns a
 * silent fail-closed into a page.
 *
 ********************************************************************/

// Failure taxonomy. Kept as constants so callers cannot invent a reason by
// typo (which would fragment the throttle and the /health counters).
const REASONS = {
    UNREACHABLE:  'unreachable',          // network error / timeout, no HTTP response
    AUTH:         'auth',                 // 401/403: hub key does not match the indexer key
    HTTP_ERROR:   'http_error',           // any other non-2xx
    RPC_ERROR:    'rpc_error',            // 2xx but the JSON-RPC body carries no usable result
    MALFORMED:    'malformed',            // result present, `validators` is not an array
    ECHO_MISMATCH:'echo_mismatch',        // indexer answered for a different block than asked
    NO_INDEXER:   'no_indexer_url',       // no BTC indexer URL resolvable at all
    MIN_STAKE:    'min_stake_unconfigured'// capability has no MIN_STAKE while the registry is live
};

// One loud line per reason per window. Matches the CapabilitySnapshot cache TTL
// (60s) so an outage that spans a PBFT round logs at most once per round.
const DEFAULT_THROTTLE_MS = 60 * 1000;

// Consecutive failures before the monitor asserts `alerting`. Three is one
// transient blip (a restart, a single timeout) plus margin: a single failed
// fetch is normal on a rolling indexer restart and must not flip a hub out of
// its healthy state, while three in a row means the input is actually gone.
const DEFAULT_ALERT_AFTER_FAILURES = 3;

class ConsensusInputMonitor {

    // opts.now / opts.log are injected by tests only; production uses the real
    // clock and console.error (the hub has no pager integration, so the loud
    // log plus the /health flag ARE the alert channel).
    constructor(opts) {
        opts = opts || {};
        this.throttleMs           = Number.isFinite(opts.throttleMs) ? opts.throttleMs : DEFAULT_THROTTLE_MS;
        this.alertAfterFailures   = Number.isInteger(opts.alertAfterFailures) && opts.alertAfterFailures > 0
            ? opts.alertAfterFailures : DEFAULT_ALERT_AFTER_FAILURES;
        this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
        this._log = typeof opts.log === 'function' ? opts.log : (msg) => console.error(msg);

        this.ok            = 0;
        this.failures      = 0;
        this.byReason      = {};
        this.consecutiveFailures = 0;
        this.streakStartedAt     = null;
        this.lastFailure         = null;   // { at, reason, method, detail }
        this.lastSuccessAt       = null;
        // Per-reason throttle stamps. Keyed by reason (not by method) so a
        // dead indexer failing four different methods raises ONE line, while
        // an auth failure and a malformed response never mask each other.
        this._warnAt = {};
        // Whether the alert has already been announced for the current streak,
        // so the escalation line prints once per outage rather than per call.
        this._alertAnnounced = false;
    }

    // A consensus input was read successfully. Clears the streak and, if an
    // alert was live, prints the recovery line (an outage whose end is silent
    // leaves the operator unable to tell a fixed hub from a stalled one).
    recordSuccess(method) {
        this.ok++;
        this.lastSuccessAt = this._now();
        if (this._alertAnnounced) {
            this._log('ALERT CLEARED: consensus-input fetches are succeeding again (' + (method || 'fetch') +
                ') after ' + this.consecutiveFailures + ' consecutive failures. This hub can participate in ' +
                'consensus rounds again.');
        }
        this.consecutiveFailures = 0;
        this.streakStartedAt     = null;
        this._alertAnnounced     = false;
        // Throttle stamps are per-outage: clearing them means the NEXT outage
        // logs immediately instead of being swallowed by the previous window.
        this._warnAt = {};
    }

    // A consensus input could not be read. `detail` is the operator-facing
    // explanation (what to check), appended to the standard line.
    // `throttleKey` sub-keys the per-reason window: two capabilities missing a
    // MIN_STAKE threshold are two distinct misconfigurations, and one must not
    // swallow the other's only line for a whole window.
    recordFailure(method, reason, detail, throttleKey) {
        reason = reason || REASONS.UNREACHABLE;
        let warnKey = throttleKey ? reason + ':' + throttleKey : reason;
        let now = this._now();
        this.failures++;
        this.byReason[reason] = (this.byReason[reason] || 0) + 1;
        this.consecutiveFailures++;
        if (this.streakStartedAt === null) this.streakStartedAt = now;
        this.lastFailure = { at: now, reason: reason, method: method || null, detail: detail || null };

        if (now - (this._warnAt[warnKey] || 0) > this.throttleMs) {
            this._warnAt[warnKey] = now;
            this._log('CONSENSUS-INPUT FETCH FAILED (' + reason + '): ' + (method || 'fetch') +
                ' could not be read from the BTC indexer, so the round FAILS CLOSED (this hub declines to vote ' +
                'and finalizes nothing) until it recovers.' + (detail ? ' ' + detail : ''));
        }

        // Escalate once per streak. Deliberately separate from the throttled
        // per-reason line: an outage that rotates through reasons (timeout,
        // then 401 after a key rotation) must still escalate exactly once.
        if (!this._alertAnnounced && this.consecutiveFailures >= this.alertAfterFailures) {
            this._alertAnnounced = true;
            this._log('ALERT: ' + this.consecutiveFailures + ' consecutive consensus-input fetch failures (last: ' +
                reason + ' on ' + (method || 'fetch') + '). This hub is NOT participating in any capability, ' +
                'attestation or config-change round. /health now reports degraded; fix the BTC indexer link ' +
                '(reachability, BTC_INDEXER_API_KEY vs the indexer INDEXER_API_KEY, or the indexer itself).');
        }
    }

    // True while the current failure streak has crossed the threshold. Reading
    // it is side-effect free so /health can poll it on every probe.
    isAlerting() {
        return this.consecutiveFailures >= this.alertAfterFailures;
    }

    // Body-only telemetry for /health. Cumulative-since-restart (no persistence:
    // operators watch it as a live signal, same contract as config_fetch), so a
    // scraper that wants a rate compares two scrapes.
    snapshot() {
        let now = this._now();
        return {
            ok:                   this.ok,
            failures:             this.failures,
            by_reason:            Object.assign({}, this.byReason),
            consecutive_failures: this.consecutiveFailures,
            streak_age_s:         this.streakStartedAt === null ? null : Math.round((now - this.streakStartedAt) / 1000),
            last_failure:         this.lastFailure ? {
                reason:  this.lastFailure.reason,
                method:  this.lastFailure.method,
                age_s:   Math.round((now - this.lastFailure.at) / 1000),
                detail:  this.lastFailure.detail
            } : null,
            last_success_age_s:   this.lastSuccessAt === null ? null : Math.round((now - this.lastSuccessAt) / 1000),
            alert_after_failures: this.alertAfterFailures,
            alerting:             this.isAlerting()
        };
    }
}

// Classify an axios rejection into a REASON. A 401/403 is NOT "indexer down":
// it means the hub's x-api-key does not match the indexer's INDEXER_API_KEY,
// and swallowing the two into one bucket is exactly what made a key mismatch
// indistinguishable from an outage.
function classifyFetchError(err) {
    let status = err && err.response && err.response.status;
    if (status === 401 || status === 403) return REASONS.AUTH;
    if (status) return REASONS.HTTP_ERROR;
    return REASONS.UNREACHABLE;
}

module.exports = { ConsensusInputMonitor, REASONS, classifyFetchError,
                   DEFAULT_THROTTLE_MS, DEFAULT_ALERT_AFTER_FAILURES };
