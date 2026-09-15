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
 * XChain Hub - llm attestation provider tests: rolling spend budget
 *
 * The aggregate per-window ceiling on the claude_spawn transport: the
 * estimate charged per billed call, the CLI invoice re-pricing it, the
 * refusal once the window is spent, and the platform clamp on the ceiling.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const path = require('path');
const os = require('os');

// Guaranteed-nonexistent default-config-dir path, so resolveHubLlmAuth's
// final fallback to ~/.claude-xchain doesn't bleed real operator state
// into env-cleared scenarios.
const HERMETIC_DEFAULT_DIR = path.join(os.tmpdir(), 'llm-provider-test-noexist-' + process.pid);

function _withEnv(extra, fn){
    const saved = {};
    const keys  = ['HUB_CLAUDE_CONFIG_DIR','CLAUDE_CONFIG_DIR',
                   'HUB_CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN',
                   'HUB_CLAUDE_DEFAULT_CONFIG_DIR',
                   'ANTHROPIC_API_KEY','LLM_DEFAULT_MODEL',
                   'HUB_OPENAI_API_KEY','OPENAI_API_KEY'];
    for (const k of keys){ saved[k] = process.env[k]; }
    const restore = () => {
        for (const k of keys){
            if (saved[k] === undefined) delete process.env[k];
            else                        process.env[k] = saved[k];
        }
    };
    let result;
    try {
        for (const k of keys){ delete process.env[k]; }
        // Hermetic default: neutralize the resolver's last-resort fallback to a
        // populated ~/.claude-xchain on the host (real hub creds would otherwise
        // leak into "no claude credentials" scenarios). Scenarios can still
        // override it via `extra`.
        process.env.HUB_CLAUDE_DEFAULT_CONFIG_DIR = '/nonexistent/hub-claude-test';
        for (const [k,v] of Object.entries(extra || {})) { process.env[k] = v; }
        result = fn();
    } catch (e) {
        restore();
        throw e;
    }
    // An async fn must keep the scenario env across its awaits (credential
    // resolution happens per runLlm call, not just in the sync prefix), so
    // restore only once the promise settles.
    if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
            (v) => { restore(); return v; },
            (e) => { restore(); throw e; }
        );
    }
    restore();
    return result;
}

// The spawn transport is stubbed through the require cache exactly as in
// llm_provider_claude_spawn.test.js, which explains the technique.

let emptyDir;
let savedCacheEntry;

const fsSync = require('fs');
let sinkPath, savedSink;

const BUDGET_KEYS = ['LLM_MAX_SPEND_USD_CENTS_PER_WINDOW',
                     'LLM_EST_SPEND_USD_CENTS',
                     'LLM_SPEND_WINDOW_MS'];
let savedBudget;

// Inject a fake claude-spawn module into the cache, reload llm.js so its
// destructured binding picks up our stub, then restore after the test.
function reloadWithSpawnStub(spawnResolveValue) {
    const spawnKey = require.resolve('../../src/providers/llm/claude_spawn.js');
    savedCacheEntry = require.cache[spawnKey];

    const fakeRunClaudePrint = sinon.stub().resolves(spawnResolveValue);
    // Inject a fake module whose exports.runClaudePrint is our stub
    require.cache[spawnKey] = {
        id: spawnKey, filename: spawnKey, loaded: true,
        exports: { runClaudePrint: fakeRunClaudePrint, CLAUDE_BIN: 'claude' }
    };

    // Now reload llm.js; its `const { runClaudePrint }` will pick up our stub
    delete require.cache[require.resolve('../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../src/lib/hub_credentials.js')];
    const llm = require('../../src/providers/llm.js');
    return { llm, stub: fakeRunClaudePrint };
}

function withSpawnEnv(fn) {
    const saved = {
        HUB_CLAUDE_CODE_OAUTH_TOKEN: process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN,
        CLAUDE_CONFIG_DIR:           process.env.CLAUDE_CONFIG_DIR,
        ANTHROPIC_API_KEY:           process.env.ANTHROPIC_API_KEY,
        HUB_CLAUDE_CONFIG_DIR:       process.env.HUB_CLAUDE_CONFIG_DIR
    };
    process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN = 'test-spawn-token';
    process.env.CLAUDE_CONFIG_DIR = emptyDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HUB_CLAUDE_CONFIG_DIR;
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else                 process.env[k] = v;
        }
    }
}

function readSink() {
    let raw = '';
    try { raw = fsSync.readFileSync(sinkPath, 'utf8'); } catch { return []; }
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('llm provider, fetch via claude_spawn', function () {

    before(function () {
        const fsSync = require('fs');
        emptyDir = path.join(os.tmpdir(), 'llm-spawn-empty-' + process.pid);
        fsSync.mkdirSync(emptyDir, { recursive: true });
    });

    afterEach(function () {
        sinon.restore();
        // Restore any patched cache entry
        const spawnKey = require.resolve('../../src/providers/llm/claude_spawn.js');
        if (savedCacheEntry !== undefined) {
            require.cache[spawnKey] = savedCacheEntry;
            savedCacheEntry = undefined;
        } else {
            delete require.cache[spawnKey];
        }
    });

    // - a crash mid-call must still leave local evidence that a vendor
    // charge was initiated, on the CLI transport most of all: it recorded nothing.
    describe('durable spend audit', function () {

        beforeEach(function () {
            savedSink = process.env.LLM_SPEND_LOG_PATH;
            sinkPath = path.join(os.tmpdir(),
                'llm-spend-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.jsonl');
            process.env.LLM_SPEND_LOG_PATH = sinkPath;
        });

        afterEach(function () {
            if (savedSink === undefined) delete process.env.LLM_SPEND_LOG_PATH;
            else process.env.LLM_SPEND_LOG_PATH = savedSink;
            try { fsSync.unlinkSync(sinkPath); } catch { /* never written */ }
        });

        registerRollingBudgetSuite();
    });
});

function registerRollingBudgetSuite() {
    // ---- the aggregate budget the per-call caps never bounded ----
    //
    // The per-call ceilings bound ONE call each, so N cheap calls cost N times a
    // cheap call. On testnet a request costs its author nothing, so this window is
    // the only thing standing between a spam loop and the operator's vendor bill.
    describe('rolling spend budget', function () {

        beforeEach(function () {
            savedBudget = {};
            for (const k of BUDGET_KEYS){ savedBudget[k] = process.env[k]; delete process.env[k]; }
        });

        afterEach(function () {
            for (const k of BUDGET_KEYS){
                if (savedBudget[k] === undefined) delete process.env[k];
                else                              process.env[k] = savedBudget[k];
            }
        });

        registerRollingBudgetChargeTests();
        registerRollingBudgetCeilingTests();
        registerRollingBudgetFailureTests();
    });
}

function registerRollingBudgetChargeTests() {
    it('charges a billed call against the window at the built-in estimate', async function () {
        const { llm } = reloadWithSpawnStub({ result: 'ok' });

        await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

        const stats = llm.spendStats();
        expect(stats.spentInWindowUsdCents).to.equal(5);
        expect(stats.maxSpendUsdCents).to.equal(1000);   // $10 default, not the $2000 clamp
    });

    it('re-prices the reservation to the CLI invoice when one is reported', async function () {
        const { llm } = reloadWithSpawnStub({
            result: 'ok', json: { total_cost_usd: 0.0123 }
        });

        await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

        // ceil(1.23) - a partial cent was spent, not free - replacing the estimate.
        expect(llm.spendStats().spentInWindowUsdCents).to.equal(2);
    });

    it('refuses the call WITHOUT dialing the vendor once the window is spent', async function () {
        process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = '1';   // under one estimated call
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });

        let err;
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } catch (e) { err = e; }

        expect(err, 'the call must be refused').to.be.an('error');
        expect(err.budgetExhausted).to.equal(true);
        expect(err.paused, 'a budget stop is not the operator kill switch').to.equal(undefined);
        expect(stub.called, 'no paid vendor call may be issued').to.equal(false);
    });
}

function registerRollingBudgetCeilingTests() {
    it('closes the audit intent out as blocked rather than leaving it open', async function () {
        process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = '1';
        const { llm } = reloadWithSpawnStub({ result: 'ok' });

        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } catch { /* expected */ }

        // An intent with no settle is the operator's post-crash reconciliation
        // list; a refusal is not a call in flight and must not land on it.
        const lines = readSink();
        expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'settle']);
        expect(lines[1].status).to.equal('blocked');
    });

    it('lets an operator raise the ceiling by env', async function () {
        process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = '4200';   // $42
        const { llm } = reloadWithSpawnStub({ result: 'ok' });

        await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

        const stats = llm.spendStats();
        expect(stats.maxSpendUsdCents).to.equal(4200);
        expect(stats.spentInWindowUsdCents).to.equal(5);
    });

    it('never lets config exceed the platform $2000 window clamp', async function () {
        process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = '999999';
        const { llm } = reloadWithSpawnStub({ result: 'ok' });

        await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

        expect(llm.spendStats().maxSpendUsdCents).to.equal(200000);
    });
}

function registerRollingBudgetFailureTests() {
    it('charges a call that reached the vendor and then threw', async function () {
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        stub.rejects(new Error('cli exploded'));

        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } catch { /* expected */ }

        // A refusal or a truncation still bills. Over-counting fails closed and
        // ages out within the window; handing budget back to a call that may
        // have billed does not.
        expect(llm.spendStats().spentInWindowUsdCents).to.equal(5);
    });

    it('charges nothing when no credential resolves, since nothing can bill', async function () {
        const { llm } = reloadWithSpawnStub({ result: 'ok' });

        try {
            await _withEnv({ HUB_CLAUDE_DEFAULT_CONFIG_DIR: HERMETIC_DEFAULT_DIR },
                () => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } catch { /* no credentials */ }

        expect(llm.spendStats().spentInWindowUsdCents).to.equal(0);
    });
}
