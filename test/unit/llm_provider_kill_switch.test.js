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
 * XChain Hub - llm attestation provider tests: kill switch and budget
 *
 * LLM_PROVIDER_ENABLED=false and governance enabled=false pause every
 * billed path with a distinct paused error, and the per-call budget
 * resolves from governance, env and the built-in default in that order.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const path = require('path');
const os = require('os');

// Guaranteed-nonexistent default-config-dir path, so resolveHubLlmAuth's
// final fallback to ~/.claude-xchain doesn't bleed real operator state
// into env-cleared scenarios.
const HERMETIC_DEFAULT_DIR = path.join(os.tmpdir(), 'llm-provider-test-noexist-' + process.pid);

// Reload the module under each scenario so its env-dependent require-time
// state is fresh. cache-bust the dependency chain too.
function _reloadProvider(){
    delete require.cache[require.resolve('../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../src/lib/hub_credentials.js')];
    delete require.cache[require.resolve('../../src/providers/llm/claude_spawn.js')];
    return require('../../src/providers/llm.js');
}

// ---- item 2680 kill switch + item 2679 budget resolution ------------------

describe('llm provider, kill switch + budget (items 2680 / 2679)', function () {

    afterEach(function () {
        delete process.env.LLM_PROVIDER_ENABLED;
        delete process.env.LLM_MAX_BUDGET_USD;
    });

    registerKillSwitchPauseTests();
    registerKillSwitchBudgetTests();
});

function registerKillSwitchPauseTests() {
    it('healthCheck reports paused, distinct from a credential failure', async function () {
        const llm = _reloadProvider();
        process.env.LLM_PROVIDER_ENABLED = 'false';
        const h = await llm.healthCheck({ defaultConfigDir: HERMETIC_DEFAULT_DIR });
        expect(h.ok).to.equal(false);
        expect(h.paused).to.equal(true);
        expect(h.error).to.match(/paused/);
    });

    it('fetch refuses with a distinct paused error', async function () {
        const llm = _reloadProvider();
        process.env.LLM_PROVIDER_ENABLED = 'false';
        let err;
        try { await llm.fetch(JSON.stringify({ prompt: 'hi' }), {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.paused).to.equal(true);
    });

    it('agree returns null + inconclusive(provider_paused) for a multi-proposal round while paused', async function () {
        const llm = _reloadProvider();
        process.env.LLM_PROVIDER_ENABLED = 'false';
        const outcome = {};
        const r = await llm.agree([
            { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('C', 'utf8'), meta: 'claude-sonnet-4-6' }
        ], { outcome });
        expect(r).to.be.null;
        expect(outcome.inconclusive).to.equal(true);
        expect(outcome.reason).to.equal('provider_paused');
    });

    it('a single proposal still resolves while paused (returns no billed call)', async function () {
        const llm = _reloadProvider();
        process.env.LLM_PROVIDER_ENABLED = 'false';
        const r = await llm.agree([{ body: Buffer.from('solo', 'utf8'), meta: 'claude-sonnet-4-6' }]);
        expect(r).to.not.be.null;
        expect(r.body.toString('utf8')).to.equal('solo');
    });
}

function registerKillSwitchBudgetTests() {
    it('governance additional_config.enabled=false also pauses', async function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { enabled: false } });
        let err;
        try { await llm.fetch(JSON.stringify({ prompt: 'hi' }), {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.paused).to.equal(true);
    });

    it('_setConfig max_budget_usd feeds resolveMaxBudgetUsd; 0 falls back to the default', function () {
        delete process.env.LLM_MAX_BUDGET_USD;
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { max_budget_usd: 1.25 } });
        expect(llm.resolveMaxBudgetUsd()).to.equal(1.25);
        // clearing the governance value does not mean "no ceiling".
        llm._setConfig({ additional_config: { max_budget_usd: 0 } });
        expect(llm.resolveMaxBudgetUsd()).to.equal(llm._DEFAULT_MAX_BUDGET_USD);
    });

    it('LLM_MAX_BUDGET_USD env overrides the governance budget', function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { max_budget_usd: 1.25 } });
        process.env.LLM_MAX_BUDGET_USD = '0.10';
        expect(llm.resolveMaxBudgetUsd()).to.equal(0.10);
    });
}
