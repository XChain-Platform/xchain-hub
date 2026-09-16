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
 * XChain Hub - llm provider: the money path around every vendor call
 *
 * The durable spend audit (an intent line before dispatch, a settle line
 * after), the rolling per-window SpendGuard budget that bounds it, and
 * runLlm, the one entry point that wraps a billed dispatch in both.
 *
 * Built once per provider instance by src/providers/llm.js, which hands in
 * every hub module this code calls, so the audit counters and the guard are
 * that instance's own.
 *
 ********************************************************************/

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeUtil = require('node:util');

// Aggregate spend budget (the enforcement half of the audit below)
//
// The audit below records what was spent; nothing bounded it. The ceilings that do
// exist each bound ONE call - --max-budget-usd on the CLI transport, max_tokens on
// the two HTTP ones - so N cheap calls still cost N times a cheap call. Every other
// hub money path (ANCHOR, ATTEST, ATTEST_RELAY, ORACLE_PUBLISH, FULLNODE) already
// sits behind a rolling per-window SpendGuard; the one path billed to the operator's
// own vendor account did not.
//
// On mainnet that gap is bounded by economics: a request costs its author real BTC
// and real XCHAIN. On testnet both are free, so the attacker's cost to make a
// validator buy vendor tokens is zero and the bound has to live here instead.
//
// Same guard class, same `<PREFIX>_*` env/cfg idiom and the same $2000 hard clamp as
// the on-chain effectors, with two LLM-specific defaults: a conservative per-window
// budget rather than the class default of the clamp itself, and a per-call estimate
// sized for one attestation turn rather than one on-chain broadcast.
const LLM_DEFAULT_WINDOW_USD_CENTS = 1000;  // $10 per rolling window (class default 1h)
const LLM_DEFAULT_EST_USD_CENTS    = 5;     // $0.05: one bounded max_tokens turn, estimated high

function appendLine(file, line) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let fd = fs.openSync(file, 'a');
    try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
}

// A refusal to spend, not a vendor failure. Marked distinctly (and NOT as `paused`,
// which means the operator/governance kill switch) so health and callers can tell a
// budget stop from an outage: the fix for this one is time or a raised ceiling.
function budgetExhaustedError(reason){
    let err = new Error('llm: ' + (reason || 'per-window spend budget reached') + '; no paid API call issued');
    err.budgetExhausted = true;
    // Typed like the other non-transport outcomes (kind) but deliberately NOT
    // transient:false: the stop heals when the rolling window rolls, so agree()
    // records it as a transient could-not-judge, not a hard error.
    err.kind = 'budget_exhausted';
    return err;
}

// The CLI transport reports real money (total_cost_usd); the HTTP transports report
// tokens, which would need a per-model price table to become money, so those keep the
// reserved estimate. Round UP: a partial cent was spent, not free.
function actualCostUsdCents(usage){
    let c = Number(usage && usage.costUsd);
    if (!Number.isFinite(c) || c <= 0) return null;
    return Math.ceil(c * 100);
}

class SpendAudit {
    // `vendorOfModel` and `runLlmDispatch` are llm.js's own; the rest are the hub
    // modules llm.js required, handed in so a reload of llm.js rewires them.
    constructor({ hubConfig, logger, SpendGuard, resolveLlmVendorAuth, vendorOfModel, runLlmDispatch }) {
        this.hubConfig = hubConfig;
        this.logger = logger;
        this.SpendGuard = SpendGuard;
        this.resolveLlmVendorAuth = resolveLlmVendorAuth;
        this.vendorOfModel = vendorOfModel;
        this.runLlmDispatch = runLlmDispatch;
        // Counters for the operator surface. A per-call console.warn is invisible once
        // stdout rotates, so a degraded sink needs a standing signal of its own: these
        // ride spendStats(), which /health already reads.
        this._auditFaults = { consecutive: 0, total: 0, toFallback: 0, toStderr: 0, lastError: null };
        this._guardCfg = {};
        this._guard    = null;
    }

    // Durable spend audit
    //
    // Every billed dispatch leaves a record on disk, the same append-only, fsync'd
    // audit AttestationPublisher.recordSpend keeps for BTC fees, applied to the
    // other money path: an `intent` line lands BEFORE the vendor is dialed and a
    // `settle` line after, so an intent with no settle is exactly the operator's
    // post-crash reconciliation list. The in-memory _tokenUsage cannot serve as
    // that record: it accrues only AFTER a successful response, and the
    // claude_spawn branch feeds it nothing, so a crash mid-call erases every local
    // trace that a vendor charge was initiated.
    //
    // Best-effort by design, and deliberately NOT fail-closed like the publisher's
    // WAL: an unwritable log there defers a broadcast that stays queued, whereas
    // refusing to dispatch here would turn an audit-sink fault into a federation-
    // wide provider_error, i.e. a wrong on-chain outcome. The write is still
    // ordered before the call, which is what the audit needs.
    //
    // What "best-effort" must NOT mean is "silently nothing": an unwritable primary
    // sink that swallows the dispatch identity outright leaves the aggregate
    // spend-state file, which records a rolling cost window and no per-call id, as
    // the only survivor. So the record falls through two more sinks (tmpdir, then
    // stderr under a stable prefix) and the fault is counted into spendStats().
    spendLogPath() {
        return this.hubConfig.LLM_SPEND_LOG_PATH || './data/llm-spend.jsonl';
    }

    // Fallback sink for a primary path that cannot be written. Dispatch stays
    // unconditional (see the block above: refusing to call would turn an audit fault
    // into a wrong on-chain outcome), so the answer to an unwritable log is to keep
    // the record somewhere else rather than to keep it nowhere. The aggregate spend
    // state file cannot stand in: it carries a rolling window of costs and no
    // per-dispatch identity, so an operator reconciling a vendor invoice against it
    // cannot tell which call was which.
    fallbackSpendLogPath() {
        return this.hubConfig.LLM_SPEND_LOG_FALLBACK_PATH || path.join(os.tmpdir(), 'llm-spend.jsonl');
    }

    appendSpendRecord(record) {
        let line = JSON.stringify(record) + '\n';
        try {
            appendLine(this.spendLogPath(), line);
            this._auditFaults.consecutive = 0;
            return;
        } catch (e) {
            this._auditFaults.consecutive++;
            this._auditFaults.total++;
            this._auditFaults.lastError = e && e.message ? String(e.message) : String(e);
            this.logger.warn(nodeUtil.format('llm: spend-audit write failed (' + this.spendLogPath() + '); ' +
                         'falling back to ' + this.fallbackSpendLogPath() + ':', this._auditFaults.lastError));
        }
        // Second sink: a different filesystem in most deployments, so the common
        // faults (missing dir, read-only mount, wrong owner on ./data) do not take
        // both. The record carries the primary path it could not reach, so a later
        // reconciliation can tell a fallback line from a native one.
        try {
            appendLine(this.fallbackSpendLogPath(), JSON.stringify(
                Object.assign({}, record, { auditFallbackFrom: this.spendLogPath() })) + '\n');
            this._auditFaults.toFallback++;
            return;
        } catch (e2) {
            this.logger.warn(nodeUtil.format('llm: fallback spend-audit write failed (' + this.fallbackSpendLogPath() + '):',
                         e2 && e2.message ? e2.message : e2));
        }
        // Last resort: stderr under a stable, greppable prefix, so a log collector
        // still holds the dispatch identity even with no writable filesystem at all.
        this._auditFaults.toStderr++;
        this.logger.error('LLM-SPEND-AUDIT ' + line.trim());
    }

    // Record the intent to spend, BEFORE dispatch. Returns the record (whose id
    // ties the settle to it), or null when the call cannot reach a vendor at all
    // (no credentials / unmapped model): those never bill, so they never enter the
    // reconciliation list.
    recordSpendIntent({ model, maxTokens, pinnedVendors }) {
        let vendor, auth;
        try {
            vendor = this.vendorOfModel(model, pinnedVendors);
            auth   = this.resolveLlmVendorAuth(vendor);
        } catch (_) { return null; }
        if (!auth || !auth.ok) return null;
        let rec = {
            id:        crypto.randomUUID(),
            ts:        new Date().toISOString(),
            phase:     'intent',
            vendor:    vendor,
            transport: auth.transport,
            model:     String(model || ''),
            maxTokens: Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : null
        };
        this.appendSpendRecord(rec);
        return rec;
    }

    // Close an intent out. `usage` is the per-call collector the transport branch
    // filled (token counts, and the CLI's own total_cost_usd).
    recordSpendSettle(intent, status, usage, err) {
        if (!intent) return;
        this.appendSpendRecord({
            id:        intent.id,
            ts:        new Date().toISOString(),
            phase:     'settle',
            vendor:    intent.vendor,
            transport: intent.transport,
            model:     intent.model,
            status:    status,
            usage:     (usage && Object.keys(usage).length) ? usage : null,
            error:     err ? String(err.message || err).substring(0, 200) : undefined
        });
    }

    spendGuard(){
        if (this._guard) return this._guard;
        // These are DEFAULTS, not overrides. SpendGuard reads env first, then cfg, so an
        // operator's LLM_MAX_SPEND_USD_CENTS_PER_WINDOW still wins, and a hub that sets
        // the same keys in p2pConfig (armSpendGuard) wins over the built-ins here.
        this._guard = new this.SpendGuard('LLM', {
            LLM_MAX_SPEND_USD_CENTS_PER_WINDOW: LLM_DEFAULT_WINDOW_USD_CENTS,
            LLM_EST_SPEND_USD_CENTS:            LLM_DEFAULT_EST_USD_CENTS,
            ...(this._guardCfg || {})
        }, 'llm');
        return this._guard;
    }

    // Install the hub's config, and on a real validator hub also turn on restart
    // persistence - the module-level equivalent of the start()/persistTo() call every
    // on-chain effector makes. Called from ProviderRegistry.getModule().
    //
    // The two halves are separate on purpose. The config half is always safe and always
    // wanted: it makes the in-process budget bind with the operator's real numbers. The
    // persistence half writes a durable window to disk, so it is gated on the caller
    // vouching that this is a live validator (`persist`), because a registry built by a
    // unit test would otherwise leave a spend window in the checkout and the NEXT run
    // would inherit a consumed budget. That is precisely why SpendGuard makes persistence
    // opt-in by CALL rather than by config.
    armSpendGuard(cfg, persist) {
        this._guardCfg = cfg || {};
        this._guard    = null;                  // rebuild against the hub's config
        let g = this.spendGuard();
        return persist ? g.persistTo() : g;
    }
    // Operator/health surface: the live window without reaching into the registry.
    // `audit` rides along so a degraded spend-audit sink is a standing, pollable
    // state rather than a console.warn that scrolls away.
    spendStats(now) {
        return Object.assign(this.spendGuard().stats(now),
                             { audit: Object.assign({}, this._auditFaults) });
    }
    resetSpendGuardForTest() {
        this._guard = null; this._guardCfg = {}; this.SpendGuard.unregister('llm');
        this._auditFaults.consecutive = 0; this._auditFaults.total = 0;
        this._auditFaults.toFallback = 0; this._auditFaults.toStderr = 0; this._auditFaults.lastError = null;
    }

    // Pick the model's vendor + configured transport and execute the LLM call.
    // Returns the response text (string). Throws on transport-level failure.
    //
    // The durable spend audit wraps the dispatch rather than living
    // inside it: one intent record before ANY of the three billed transports is
    // dialed, one settle record on every exit, including the throwing ones (a
    // refusal or a truncation is a REACHED vendor, so it was still billed).
    async runLlm(opts) {
        const intent = this.recordSpendIntent(opts || {});
        // Per-call collector; a module-level one would cross-talk between the
        // concurrent rounds AttestationRound can have in flight at once.
        const usage  = {};

        // Reserve the budget BEFORE dispatch, and only when a vendor actually resolved: a
        // null intent means no credential could be reached, so the call cannot bill and
        // must not consume budget. reserve() consumes in the same synchronous turn, which
        // is what stops concurrent rounds from all clearing one pre-send check and all
        // spending past the ceiling.
        const token = intent ? this.spendGuard().reserve(null) : null;
        if (intent && !token) {
            const err = budgetExhaustedError(this.spendGuard().noteBlocked());
            // Close the intent out. An intent with no settle is the operator's post-crash
            // reconciliation list, and a refusal is not a call in flight.
            this.recordSpendSettle(intent, 'blocked', usage, err);
            throw err;
        }

        try {
            const text = await this.runLlmDispatch({ ...opts, _usage: usage });
            // Re-price the reservation at the invoice when the transport reports one.
            this.spendGuard().commit(token, actualCostUsdCents(usage));
            this.recordSpendSettle(intent, 'ok', usage, null);
            return text;
        } catch (e) {
            // Everything that throws from here reached a vendor - resolution and
            // credentials already succeeded above - and a refusal or a truncation still
            // bills, so the reservation STAYS spent. Over-counting fails closed and ages
            // out within one window; handing budget back to a call that may have billed
            // does not.
            this.spendGuard().commit(token, actualCostUsdCents(usage));
            this.recordSpendSettle(intent, 'error', usage, e);
            throw e;
        }
    }
}

module.exports = SpendAudit;
