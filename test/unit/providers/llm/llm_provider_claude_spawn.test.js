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
 * XChain Hub - llm attestation provider tests: fetch() via claude_spawn
 *
 * The CLI transport, driven through a stubbed runClaudePrint: result
 * shape, empty-text refusal, the per-call spend ceiling and the kill
 * switch. The spend audit and rolling budget on this transport live in
 * llm_provider_spend_audit.test.js and llm_provider_spend_budget.test.js.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const path = require('path');
const os = require('os');

// ---- fetch() via claude_spawn transport -----------------------------------
// llm.js destructures runClaudePrint at require-time. We cannot stub it
// via sinon after the fact. Instead we inject a pre-patched claude-spawn
// module into the require cache BEFORE _reloadProvider() loads the llm module,
// so the destructured binding lands on our stub function.

let emptyDir;
let savedCacheEntry;

// Inject a fake claude-spawn module into the cache, reload llm.js so its
// destructured binding picks up our stub, then restore after the test.
function reloadWithSpawnStub(spawnResolveValue) {
    const spawnKey = require.resolve('../../../../src/providers/llm/claude_spawn.js');
    savedCacheEntry = require.cache[spawnKey];

    const fakeRunClaudePrint = sinon.stub().resolves(spawnResolveValue);
    // Inject a fake module whose exports.runClaudePrint is our stub
    require.cache[spawnKey] = {
        id: spawnKey, filename: spawnKey, loaded: true,
        exports: { runClaudePrint: fakeRunClaudePrint, CLAUDE_BIN: 'claude' }
    };

    // Now reload llm.js; its `const { runClaudePrint }` will pick up our stub
    delete require.cache[require.resolve('../../../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../../../src/lib/hub_credentials.js')];
    const llm = require('../../../../src/providers/llm.js');
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

describe('llm provider, fetch via claude_spawn', function () {

    before(function () {
        const fsSync = require('fs');
        emptyDir = path.join(os.tmpdir(), 'llm-spawn-empty-' + process.pid);
        fsSync.mkdirSync(emptyDir, { recursive: true });
    });

    afterEach(function () {
        sinon.restore();
        // Restore any patched cache entry
        const spawnKey = require.resolve('../../../../src/providers/llm/claude_spawn.js');
        if (savedCacheEntry !== undefined) {
            require.cache[spawnKey] = savedCacheEntry;
            savedCacheEntry = undefined;
        } else {
            delete require.cache[spawnKey];
        }
    });

    registerSpawnFetchTests();
    registerSpawnBudgetCeilingTests();
});

function registerSpawnFetchTests() {
    it('returns { body: Buffer, meta: model } on a successful claude_spawn call', async function () {
        const { llm, stub } = reloadWithSpawnStub({ result: 'Hello from LLM.' });
        const fetchResult = await withSpawnEnv(() =>
            llm.fetch(JSON.stringify({ prompt: 'Say hello' }), {})
        );
        expect(stub.calledOnce).to.equal(true);
        expect(Buffer.isBuffer(fetchResult.body)).to.equal(true);
        expect(fetchResult.body.toString('utf8')).to.equal('Hello from LLM.');
        expect(typeof fetchResult.meta).to.equal('string');
    });

    it('throws when claude_spawn returns empty text', async function () {
        const { llm } = reloadWithSpawnStub({ result: '' });
        let err;
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'Say nothing' }), {}));
        } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/empty text/);
    });

    // item 2679: the per-call spend budget must actually reach runClaudePrint.
    it('threads LLM_MAX_BUDGET_USD into runClaudePrint as maxBudgetUsd', async function () {
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        process.env.LLM_MAX_BUDGET_USD = '0.50';
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } finally { delete process.env.LLM_MAX_BUDGET_USD; }
        expect(stub.calledOnce).to.equal(true);
        expect(stub.firstCall.args[0].maxBudgetUsd).to.equal(0.5);
    });
}

function registerSpawnBudgetCeilingTests() {
    // - these two once pinned the OPPOSITE contract (an unconfigured hub
    // omits the flag, "behavior unchanged"). That omission was the gap: the CLI
    // transport carries no token cap of its own, so every paid invocation on a
    // stock hub ran uncapped. The ceiling is now default-on and these pin it.
    it('applies the built-in ceiling when no budget is configured', async function () {
        const savedBudget = process.env.LLM_MAX_BUDGET_USD;
        delete process.env.LLM_MAX_BUDGET_USD;
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } finally { if (savedBudget !== undefined) process.env.LLM_MAX_BUDGET_USD = savedBudget; }
        expect(stub.calledOnce).to.equal(true);
        expect(stub.firstCall.args[0].maxBudgetUsd).to.equal(llm._DEFAULT_MAX_BUDGET_USD);
        expect(stub.firstCall.args[0].maxBudgetUsd).to.be.a('number').greaterThan(0);
    });

    it('falls back to the built-in ceiling for a non-numeric / non-positive budget', async function () {
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        process.env.LLM_MAX_BUDGET_USD = 'not-a-number';
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } finally { delete process.env.LLM_MAX_BUDGET_USD; }
        expect(stub.firstCall.args[0].maxBudgetUsd).to.equal(llm._DEFAULT_MAX_BUDGET_USD);
    });

    // item 2680: a paused provider must not dial the spawn transport at all.
    it('does not call runClaudePrint while paused', async function () {
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        process.env.LLM_PROVIDER_ENABLED = 'false';
        let err;
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } catch (e) { err = e; } finally { delete process.env.LLM_PROVIDER_ENABLED; }
        expect(err).to.exist;
        expect(err.paused).to.equal(true);
        expect(stub.called).to.equal(false);
    });
}
