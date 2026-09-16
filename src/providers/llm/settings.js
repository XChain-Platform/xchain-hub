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
 * XChain Hub - llm provider: installed configuration
 *
 * The governance-controlled `additional_config` values the provider runs on,
 * the install hook ProviderRegistry calls, the operator kill switch and the
 * per-call CLI budget.
 *
 * One instance per provider load: src/providers/llm.js constructs it each time
 * it loads, so a suite that reloads llm.js gets the built-in defaults back and
 * an instance it already holds keeps its own. The installed values keep their
 * UPPER_SNAKE names so the prose across the hub that cites them still matches.
 *
 ********************************************************************/

// Per-call spend ceiling for the claude_spawn transport. The callee
// (lib/claude-spawn.js) fully plumbs --max-budget-usd but no caller ever supplied
// it, so the guard was dead. Resolve a positive number from env or governance;
//   - LLM_MAX_BUDGET_USD (env)          : operator-local per-call cap
//   - additional_config.max_budget_usd  : governance per-call cap
//   - DEFAULT_MAX_BUDGET_USD            : built-in fail-safe floor
// Env wins when both are set and positive.
//
// The resolver returned undefined at the end before this default, and the
// claude_spawn branch omits the flag for an undefined budget, so an operator who
// configured nothing ran every paid CLI invocation with NO ceiling at all. This
// is the one transport with no other bound: the two HTTP branches pass an
// explicit max_tokens / max_completion_tokens, while the CLI exposes no token
// cap, so --max-budget-usd is the only thing standing between a pathological
// payload and unbounded spend. Defaulting it on is fail-safe in the direction
// every other effector gate here already leans (spend_guard's USD budget is
// likewise default-ON rather than default-disabled).
const DEFAULT_MAX_BUDGET_USD = 5;

// Keys setConfig below actually reads. Kept adjacent to it so a new key added there
// without a line here warns on its own first install, which is the cheap direction to
// fail in.
const CONSUMED_CONFIG_KEYS = new Set([
    'approved_models', 'judge_model', 'judge_fallback_models', 'model_vendors',
    'require_all_vendors', 'max_completion_tokens', 'default_temperature',
    'prompt_envelope_version', 'enabled', 'max_budget_usd'
]);

class LlmSettings {
    // `hubConfig` is the hub's env home and `logger` the provider's logger, both
    // handed in by llm.js so a suite that swaps either reaches this code through
    // the same reload it always used.
    constructor({ hubConfig, logger }) {
        this.hubConfig = hubConfig;
        this.logger    = logger;
        // Provider-def-injected configuration. ProviderRegistry calls _setConfig
        // after loading the def from the configs table; these defaults are the
        // spec §3 fallbacks for first-startup before any governance proposal.
        this.APPROVED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7'];
        this.JUDGE_MODEL     = 'claude-haiku-4-5';
        // Ordered alternates the leader's agree() walks when the pinned judge's
        // vendor is unreachable. Leader-local reachability fallback, NOT consensus
        // state: followers never re-judge, so no cross-hub determinism is needed.
        this.JUDGE_FALLBACK_MODELS = [];
        // Explicit model-id → vendor overrides for ids the prefix inference in
        // llm.js vendorOfModel doesn't know. Governance-controlled, so a new vendor's model can be
        // approved without a code deploy (its transport still needs code).
        this.MODEL_VENDORS = {};
        // When true, healthCheck() fails unless credentials resolve for EVERY vendor
        // on the fetch + judge chains (self-test enforcement of fallback readiness).
        // Governance flips this once the federation has provisioned fallback keys.
        this.REQUIRE_ALL_VENDORS = false;
        this.MAX_TOKENS_DEFAULT  = 1024;
        this.DEFAULT_TEMPERATURE = 0;
        this.PROMPT_ENVELOPE_VERSION = 1;
        // Governance kill switch (see llmEnabled) and per-call CLI budget
        // (see DEFAULT_MAX_BUDGET_USD above).
        this.LLM_ENABLED_CONFIG = true;      // governance additional_config.enabled (default on)
        this.MAX_BUDGET_USD_CONFIG = null;   // governance additional_config.max_budget_usd
        // hotReload runs _setConfig on EVERY finalized governance proposal, whatever it
        // changed, so an undeduped warning would reprint the same line for the life of the
        // hub. Keyed on the unknown-key set itself, not on a boolean, so a config that later
        // adds a second unknown key still reports it.
        this.LAST_UNCONSUMED_WARNED = null;
    }

    // Operator kill switch for this paid provider. The only pre-existing
    // lever was failing healthCheck (which the hub penalizes: the validator is still
    // counted in N, so unserved rounds expire and accrue missed_count), i.e. a failure
    // mode, not a control. This is a first-class pause that stops fetch()/agree() from
    // dialing any billed vendor. Two sources, either can pause:
    //   - LLM_PROVIDER_ENABLED=false : operator-local env kill (mirrors the publisher
    //     *_ENABLED idiom, e.g. StateAnchorPublisher ANCHOR_ENABLED). Authoritative and
    //     immediate for the operator; survives a governance hotReload.
    //   - additional_config.enabled=false : governance-driven, federation-wide pause.
    // Default (both unset): enabled, so behavior is unchanged.
    llmEnabled() {
        if (String(this.hubConfig.LLM_PROVIDER_ENABLED || 'true') === 'false') return false;
        return this.LLM_ENABLED_CONFIG !== false;
    }
    pausedError() {
        let src = (String(this.hubConfig.LLM_PROVIDER_ENABLED || 'true') === 'false')
            ? 'LLM_PROVIDER_ENABLED=false' : 'additional_config.enabled=false';
        let err = new Error('llm: provider paused (' + src + '); no paid API call issued');
        err.paused = true;   // distinct, non-transient marker so callers/health can tell
        return err;          // a deliberate pause from a real vendor/transport failure
    }

    // The per-call CLI budget; rationale at DEFAULT_MAX_BUDGET_USD above.
    resolveMaxBudgetUsd() {
        let envVal = parseFloat(this.hubConfig.LLM_MAX_BUDGET_USD);
        if (Number.isFinite(envVal) && envVal > 0) return envVal;
        if (Number.isFinite(this.MAX_BUDGET_USD_CONFIG) && this.MAX_BUDGET_USD_CONFIG > 0) return this.MAX_BUDGET_USD_CONFIG;
        // Sized so it cannot cut off legitimate work: one attestation call is a
        // single --print turn with tools disabled, bounded by fetchTimeoutMs (10s
        // stock, 60s ceiling in runLlm), which is orders of magnitude under $5. It
        // bounds the runaway shape instead, and env/governance can widen it.
        return DEFAULT_MAX_BUDGET_USD;
    }

    // The model chain half of an install: which models serve, which judges, and
    // which vendor each id maps to.
    installModelChain(ac) {
        if (Array.isArray(ac.approved_models) && ac.approved_models.length > 0)
            this.APPROVED_MODELS = ac.approved_models.slice();
        if (ac.judge_model)                this.JUDGE_MODEL        = String(ac.judge_model);
        if (Array.isArray(ac.judge_fallback_models))
            this.JUDGE_FALLBACK_MODELS = ac.judge_fallback_models.map(String);
        if (ac.model_vendors && typeof ac.model_vendors === 'object')
            this.MODEL_VENDORS = { ...ac.model_vendors };
        if (typeof ac.require_all_vendors === 'boolean')
            this.REQUIRE_ALL_VENDORS = ac.require_all_vendors;
    }

    // The numeric bounds half of an install, each validated before it is installed.
    installBounds(ac) {
        // Validate before installing. A bare truthy check admitted -1, 1.5
        // and Infinity as the federation-wide token budget: the clamp in fetch() is a
        // min() against this same value so a negative survives it, chat/Claude API then
        // send it verbatim for a deterministic vendor 400, and the reasoning path's
        // +FETCH_REASONING_TOKEN_HEADROOM flips it positive into a silently wrong
        // budget instead. Same positive-integer rule the per-request envelope.max_tokens
        // boundary already enforces; warn-and-keep rather than throw, so one
        // bad key holds the prior default instead of aborting the whole config install,
        // matching the sibling default_temperature handling directly below.
        if (ac.max_completion_tokens !== undefined) {
            let mt = Number(ac.max_completion_tokens);
            if (Number.isInteger(mt) && mt > 0)
                this.MAX_TOKENS_DEFAULT = mt;
            else
                this.logger.warn('llm: ignoring additional_config.max_completion_tokens ' + ac.max_completion_tokens +
                    ' (must be a positive integer); keeping ' + this.MAX_TOKENS_DEFAULT);
        }
        // Range-check the governance default against the cross-vendor intersection. This one
        // value serves EVERY vendor and every fetch that omits envelope.temperature,
        // and the Claude Messages API rejects anything outside [0, 1] with a 400, so
        // an out-of-range value (perfectly legal for OpenAI, which allows up to 2) is a
        // federation-wide provider_error outage on the default Claude approved_models
        // with no code deploy behind it. Keeping the prior value is the deterministic
        // failure mode: every hub rejects the identical payload and so holds the
        // identical default. A caller that genuinely wants an OpenAI temperature above 1
        // still has the per-request envelope, which is bounded to [0, 2] in fetch().
        if (typeof ac.default_temperature === 'number') {
            if (Number.isFinite(ac.default_temperature) &&
                ac.default_temperature >= 0 && ac.default_temperature <= 1)
                this.DEFAULT_TEMPERATURE = ac.default_temperature;
            else
                this.logger.warn('llm: ignoring additional_config.default_temperature ' + ac.default_temperature +
                    ' (must be a number in [0, 1]); keeping ' + this.DEFAULT_TEMPERATURE);
        }
        // Positive-integer rule for the envelope-version ceiling, same warn-and-keep as the
        // two siblings above: this value is the ONLY check at the fetch() boundary
        // (`Number(envelope.envelope_version) > PROMPT_ENVELOPE_VERSION`), so a negative
        // ceiling rejects every well-formed envelope_version:1 request on every hub and
        // Infinity disables the ceiling entirely, both from one governance key with no
        // code deploy behind it.
        if (ac.prompt_envelope_version !== undefined) {
            let ev = Number(ac.prompt_envelope_version);
            if (Number.isInteger(ev) && ev > 0)
                this.PROMPT_ENVELOPE_VERSION = ev;
            else
                this.logger.warn('llm: ignoring additional_config.prompt_envelope_version ' + ac.prompt_envelope_version +
                    ' (must be a positive integer); keeping ' + this.PROMPT_ENVELOPE_VERSION);
        }
    }

    // Allow ProviderRegistry to inject the registered provider def at load time
    // so governance-controlled `additional_config` takes effect without a hub
    // restart. Called from ProviderRegistry.load() / .hotReload().
    setConfig(def) {
        if (!def || !def.additional_config) return;
        let ac = def.additional_config;
        this.installModelChain(ac);
        this.installBounds(ac);
        // Governance kill switch and per-call spend cap.
        if (typeof ac.enabled === 'boolean') this.LLM_ENABLED_CONFIG = ac.enabled;
        if (ac.max_budget_usd !== undefined) {
            let b = parseFloat(ac.max_budget_usd);
            this.MAX_BUDGET_USD_CONFIG = (Number.isFinite(b) && b > 0) ? b : null;
        }
        // Every OTHER key in the governance payload is silently discarded, which is the
        // one failure mode the warn-and-keep validations above do not cover: a malformed
        // value at least says so, an unread key says nothing at all. judge_equivalence_threshold
        // shipped in DEFAULTS for months and round-tripped through config history and
        // hotReload with no signal that no runtime read it. Log-only and never throwing,
        // so one unrecognised key cannot abort the rest of the install: a hub deliberately
        // running older code against newer governance keys must still apply what it knows.
        this.warnUnconsumedKeys(ac);
    }

    // Warn once per distinct set of unread keys (dedupe rationale at LAST_UNCONSUMED_WARNED).
    warnUnconsumedKeys(ac) {
        let unknown = Object.keys(ac).filter(k => !CONSUMED_CONFIG_KEYS.has(k)).sort();
        let signature = unknown.join(',');
        if (signature === this.LAST_UNCONSUMED_WARNED) return;
        this.LAST_UNCONSUMED_WARNED = signature;
        if (unknown.length === 0) return;
        this.logger.warn('llm: additional_config key(s) not consumed by this build (ignored): ' +
            unknown.join(', '));
    }

    // Test seam: the dedupe is instance state, so a suite exercising the warning
    // twice needs to clear it between cases the way it would be cleared by a restart.
    resetUnconsumedWarnState() { this.LAST_UNCONSUMED_WARNED = null; }
}

LlmSettings.DEFAULT_MAX_BUDGET_USD = DEFAULT_MAX_BUDGET_USD;
LlmSettings.CONSUMED_CONFIG_KEYS   = CONSUMED_CONFIG_KEYS;

module.exports = LlmSettings;
