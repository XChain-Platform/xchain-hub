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
 * XChain Hub - llm attestation provider tests
 *
 * Network/spawn paths are not exercised here. fetch() requires a live
 * transport, so those are e2e-tested in xchain-e2e-test. This file
 * focuses on the parts that work without external dependencies:
 *   - healthCheck() picks up resolveHubLlmAuth's verdict
 *   - agree() implements the judge_model branch (trivial N=1 case + JSON
 *     parse + canonical_index dispatch)
 *   - _setConfig() applies the registry's additional_config
 *   - fetch() input validation
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const nock       = require('nock');
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
    // resolution happens per _runLlm call, not just in the sync prefix), so
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

// Reload the module under each scenario so its env-dependent require-time
// state is fresh. cache-bust the dependency chain too.
function _reloadProvider(){
    delete require.cache[require.resolve('../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../src/lib/hub-credentials.js')];
    delete require.cache[require.resolve('../../src/lib/claude-spawn.js')];
    return require('../../src/providers/llm.js');
}

describe('llm provider, healthCheck', function () {

    it('reports ok:false when no credentials are configured', async function () {
        const result = await _withEnv({}, async () => {
            const llm = _reloadProvider();
            return await llm.healthCheck({ defaultConfigDir: HERMETIC_DEFAULT_DIR });
        });
        expect(result.ok).to.equal(false);
        expect(result.error).to.be.a('string');
    });

    it('reports ok:true with transport=anthropic_api when ANTHROPIC_API_KEY is set', async function () {
        const result = await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
            const llm = _reloadProvider();
            return await llm.healthCheck({ defaultConfigDir: HERMETIC_DEFAULT_DIR });
        });
        expect(result.ok).to.equal(true);
        expect(result.transport).to.equal('anthropic_api');
        expect(result.source).to.equal('api_key');
    });
});

describe('llm provider, agree (judge_model)', function () {

    let llm;
    before(function () { llm = require('../../src/providers/llm.js'); });

    it('returns null on empty input', async function () {
        expect(await llm.agree([])).to.be.null;
        expect(await llm.agree(null)).to.be.null;
        expect(await llm.agree(undefined)).to.be.null;
    });

    it('returns the single proposal trivially when redundancy=1', async function () {
        const result = await llm.agree([{ body: Buffer.from('hi', 'utf8'), meta: 'claude-sonnet-4-6' }]);
        expect(result).to.not.be.null;
        expect(result.body.toString('utf8')).to.equal('hi');
        expect(result.meta).to.equal('claude-sonnet-4-6');
    });

    it('returns null when judge is unreachable (no credentials)', async function () {
        // Multi-proposal case wants to call the judge; with no creds the
        // _runLlm throws and agree() catches → null (no_quorum surface).
        const r = await _withEnv({}, async () => {
            const fresh = _reloadProvider();
            return await fresh.agree([
                { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
                { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' },
                { body: Buffer.from('C', 'utf8'), meta: 'claude-sonnet-4-6' }
            ]);
        });
        expect(r).to.be.null;
    });
});

describe('llm provider, _setConfig', function () {

    it('applies approved_models / judge_model / token caps from the registry def', function () {
        const llm = _reloadProvider();
        llm._setConfig({
            additional_config: {
                approved_models: ['claude-opus-4-7'],
                judge_model:     'claude-haiku-4-5',
                max_completion_tokens: 2048,
                default_temperature:   0.3,
                prompt_envelope_version: 2
            }
        });
        // No public getter; verified indirectly via fetch() validating envelope_version.
        // An envelope_version of 3 should now exceed the configured 2 and throw.
        return llm.fetch(JSON.stringify({ prompt: 'hi', envelope_version: 3 }), {})
            .then(() => { throw new Error('expected envelope_version reject'); })
            .catch((e) => {
                expect(e.message).to.match(/unsupported envelope_version/);
            });
    });

    it('ignores _setConfig calls with no additional_config', function () {
        const llm = _reloadProvider();
        // Should not throw and not mutate any defaults.
        llm._setConfig({});
        llm._setConfig({ additional_config: null });
        llm._setConfig(null);
        llm._setConfig(undefined);
    });
});

describe('llm provider, fetch input validation', function () {

    it('rejects non-JSON payloads with a JSON-envelope message', async function () {
        const llm = _reloadProvider();
        let err;
        try { await llm.fetch('not json', {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/JSON envelope/);
    });

    it('rejects envelopes missing the prompt field', async function () {
        const llm = _reloadProvider();
        let err;
        try { await llm.fetch(JSON.stringify({ system: 'oops' }), {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/envelope\.prompt/);
    });

    it('accepts omitted options argument: options || {} branch', async function () {
        // Line 83: `options = options || {}`, the `{}` fallback when options is not passed
        const llm = _reloadProvider();
        let err;
        // Pass no second argument; options is undefined, falls back to {}
        try { await llm.fetch('not json'); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/JSON envelope/);  // hits the JSON parse error, not options error
    });
});

// ---- fetch() via claude_spawn transport -----------------------------------
// llm.js destructures runClaudePrint at require-time. We cannot stub it
// via sinon after the fact. Instead we inject a pre-patched claude-spawn
// module into the require cache BEFORE _reloadProvider() loads the llm module,
// so the destructured binding lands on our stub function.

describe('llm provider, fetch via claude_spawn', function () {

    let emptyDir;
    let savedCacheEntry;

    before(function () {
        const fsSync = require('fs');
        emptyDir = path.join(os.tmpdir(), 'llm-spawn-empty-' + process.pid);
        fsSync.mkdirSync(emptyDir, { recursive: true });
    });

    afterEach(function () {
        sinon.restore();
        // Restore any patched cache entry
        const spawnKey = require.resolve('../../src/lib/claude-spawn.js');
        if (savedCacheEntry !== undefined) {
            require.cache[spawnKey] = savedCacheEntry;
            savedCacheEntry = undefined;
        } else {
            delete require.cache[spawnKey];
        }
    });

    // Inject a fake claude-spawn module into the cache, reload llm.js so its
    // destructured binding picks up our stub, then restore after the test.
    function reloadWithSpawnStub(spawnResolveValue) {
        const spawnKey = require.resolve('../../src/lib/claude-spawn.js');
        savedCacheEntry = require.cache[spawnKey];

        const fakeRunClaudePrint = sinon.stub().resolves(spawnResolveValue);
        // Inject a fake module whose exports.runClaudePrint is our stub
        require.cache[spawnKey] = {
            id: spawnKey, filename: spawnKey, loaded: true,
            exports: { runClaudePrint: fakeRunClaudePrint, CLAUDE_BIN: 'claude' }
        };

        // Now reload llm.js; its `const { runClaudePrint }` will pick up our stub
        delete require.cache[require.resolve('../../src/providers/llm.js')];
        delete require.cache[require.resolve('../../src/lib/hub-credentials.js')];
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

    it('omits maxBudgetUsd when no budget is configured (behavior unchanged)', async function () {
        const savedBudget = process.env.LLM_MAX_BUDGET_USD;
        delete process.env.LLM_MAX_BUDGET_USD;
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } finally { if (savedBudget !== undefined) process.env.LLM_MAX_BUDGET_USD = savedBudget; }
        expect(stub.calledOnce).to.equal(true);
        expect(stub.firstCall.args[0]).to.not.have.property('maxBudgetUsd');
    });

    it('omits maxBudgetUsd for a non-numeric / non-positive budget', async function () {
        const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
        process.env.LLM_MAX_BUDGET_USD = 'not-a-number';
        try {
            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
        } finally { delete process.env.LLM_MAX_BUDGET_USD; }
        expect(stub.firstCall.args[0]).to.not.have.property('maxBudgetUsd');
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
});

// ---- item 2680 kill switch + item 2679 budget resolution ------------------

describe('llm provider, kill switch + budget (items 2680 / 2679)', function () {

    afterEach(function () {
        delete process.env.LLM_PROVIDER_ENABLED;
        delete process.env.LLM_MAX_BUDGET_USD;
    });

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

    it('governance additional_config.enabled=false also pauses', async function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { enabled: false } });
        let err;
        try { await llm.fetch(JSON.stringify({ prompt: 'hi' }), {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.paused).to.equal(true);
    });

    it('_setConfig max_budget_usd feeds _resolveMaxBudgetUsd; 0 clears it', function () {
        delete process.env.LLM_MAX_BUDGET_USD;
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { max_budget_usd: 1.25 } });
        expect(llm._resolveMaxBudgetUsd()).to.equal(1.25);
        llm._setConfig({ additional_config: { max_budget_usd: 0 } });
        expect(llm._resolveMaxBudgetUsd()).to.equal(undefined);
    });

    it('LLM_MAX_BUDGET_USD env overrides the governance budget', function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { max_budget_usd: 1.25 } });
        process.env.LLM_MAX_BUDGET_USD = '0.10';
        expect(llm._resolveMaxBudgetUsd()).to.equal(0.10);
    });
});

// ---- fetch() via anthropic_api transport (nock) ---------------------------

describe('llm provider, fetch via anthropic_api', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    function withApiKey(fn) {
        const saved = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-test-key';
        // Delete claude_spawn precedence vars
        const savedHub  = process.env.HUB_CLAUDE_CONFIG_DIR;
        const savedCli  = process.env.CLAUDE_CONFIG_DIR;
        const savedHubT = process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN;
        const savedCliT = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        delete process.env.HUB_CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        try {
            return fn();
        } finally {
            if (saved === undefined)    delete process.env.ANTHROPIC_API_KEY;
            else                        process.env.ANTHROPIC_API_KEY = saved;
            if (savedHub !== undefined) process.env.HUB_CLAUDE_CONFIG_DIR = savedHub;
            if (savedCli !== undefined) process.env.CLAUDE_CONFIG_DIR = savedCli;
            if (savedHubT !== undefined) process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN = savedHubT;
            if (savedCliT !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedCliT;
        }
    }

    it('returns { body, meta } from a successful Anthropic API call', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: 'Paris is the capital of France.' }],
                usage:   { input_tokens: 10, output_tokens: 8 }
            });

        const result = await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Capital of France?' }), {})
        );

        expect(Buffer.isBuffer(result.body)).to.equal(true);
        expect(result.body.toString('utf8')).to.equal('Paris is the capital of France.');
        expect(typeof result.meta).to.equal('string');
    });

    it('respects custom max_tokens in the envelope', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, {
                content: [{ type: 'text', text: 'short answer' }],
                usage:   { input_tokens: 5, output_tokens: 2 }
            });

        await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Q?', max_tokens: 64 }), {})
        );

        expect(capturedBody.max_tokens).to.equal(64);
    });

    it('respects custom temperature in the envelope', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, {
                content: [{ type: 'text', text: 'creative answer' }],
                usage:   { input_tokens: 5, output_tokens: 3 }
            });

        await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Q?', temperature: 0.7 }), {})
        );

        expect(capturedBody.temperature).to.equal(0.7);
    });

    it('includes system prompt in the request when provided', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, {
                content: [{ type: 'text', text: 'ok' }],
                usage:   { input_tokens: 5, output_tokens: 1 }
            });

        await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Q?', system: 'You are helpful.' }), {})
        );

        expect(capturedBody.system).to.equal('You are helpful.');
    });

    it('rejects when the Anthropic API returns an error payload', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, { type: 'error', error: { type: 'invalid_request_error', message: 'bad input' } });

        let err;
        try {
            await withApiKey(() =>
                llm.fetch(JSON.stringify({ prompt: 'Q?' }), {})
            );
        } catch (e) { err = e; }

        expect(err).to.exist;
        expect(err.message).to.match(/bad input/);
    });

    it('rejects when the Anthropic API returns malformed (non-JSON) response', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, 'not json at all!!!');

        let err;
        try {
            await withApiKey(() =>
                llm.fetch(JSON.stringify({ prompt: 'Q?' }), {})
            );
        } catch (e) { err = e; }

        expect(err).to.exist;
        expect(err.message).to.match(/malformed response/);
    });

    it('rejects on a network error from the Anthropic API', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .replyWithError('ECONNRESET');

        let err;
        try {
            await withApiKey(() =>
                llm.fetch(JSON.stringify({ prompt: 'Q?' }), {})
            );
        } catch (e) { err = e; }

        expect(err).to.exist;
        expect(err.message).to.match(/request error/);
    });

    it('throws when the API returns empty text (no text content items)', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'image', source: 'data:...' }],
                usage:   { input_tokens: 5, output_tokens: 0 }
            });

        let err;
        try {
            await withApiKey(() =>
                llm.fetch(JSON.stringify({ prompt: 'Q?' }), {})
            );
        } catch (e) { err = e; }

        expect(err).to.exist;
        expect(err.message).to.match(/empty text/);
    });

    it('ignores process.env.LLM_DEFAULT_MODEL (removed from the consensus path)', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, {
                content: [{ type: 'text', text: 'ok' }],
                usage:   { input_tokens: 5, output_tokens: 1 }
            });

        process.env.LLM_DEFAULT_MODEL = 'claude-opus-4-7';  // an APPROVED model, but env must be ignored
        let result;
        try {
            result = await withApiKey(() =>
                // pinnedModel is the only model source; env is no longer consulted
                llm.fetch(JSON.stringify({ prompt: 'Q?' }), { pinnedModel: 'claude-sonnet-4-6' })
            );
        } finally {
            delete process.env.LLM_DEFAULT_MODEL;
        }
        expect(result).to.exist;
        expect(capturedBody.model).to.equal('claude-sonnet-4-6');  // pinnedModel wins, env disregarded
    });

    it('fetch() uses options.pinnedModel for the request model', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });

        await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Q?' }), { pinnedModel: 'claude-opus-4-7' })
        );
        expect(capturedBody.model).to.equal('claude-opus-4-7');
    });

    it('fetch() honors a block-anchored pinnedModel even when it is not in the live APPROVED_MODELS', async function () {
        // Consensus determinism (item 4560): the pinnedModel is resolved from
        // block-anchored governance config, so it must be used as-is. Clamping it
        // against the live, governance-mutable APPROVED_MODELS would fork an updated
        // validator (swaps to APPROVED_MODELS[0]) from a laggard (keeps the pin) the
        // instant a hotReload changes the approved list.
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });

        await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Q?' }), { pinnedModel: 'claude-future-not-yet-listed' })
        );
        expect(capturedBody.model).to.equal('claude-future-not-yet-listed');
    });

    it('fetch() falls back to APPROVED_MODELS[0] when no pinnedModel is supplied', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });

        await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Q?' }), {})
        );
        expect(capturedBody.model).to.equal('claude-sonnet-4-6');  // default APPROVED_MODELS[0]
    });

    it('agree() uses options.pinnedJudgeModel for the judge call', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent":true,"canonical_index":1}' }],
                usage:   { input_tokens: 1, output_tokens: 1 }
            });

        const proposals = [{ body: Buffer.from('a'), meta: 'm' }, { body: Buffer.from('a'), meta: 'm' }];
        await withApiKey(() => llm.agree(proposals, { pinnedJudgeModel: 'claude-opus-4-7' }));
        expect(capturedBody.model).to.equal('claude-opus-4-7');
    });

    it('agree() falls back to the module JUDGE_MODEL when no pinnedJudgeModel is given', async function () {
        const llm = _reloadProvider();
        let capturedBody;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent":true,"canonical_index":1}' }],
                usage:   { input_tokens: 1, output_tokens: 1 }
            });

        const proposals = [{ body: Buffer.from('a'), meta: 'm' }, { body: Buffer.from('a'), meta: 'm' }];
        await withApiKey(() => llm.agree(proposals));  // no options
        expect(capturedBody.model).to.equal('claude-haiku-4-5');  // module default JUDGE_MODEL
    });

    it('accumulates token usage across multiple calls', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .twice()
            .reply(200, {
                content: [{ type: 'text', text: 'answer' }],
                usage:   { input_tokens: 5, output_tokens: 3 }
            });

        await withApiKey(() => llm.fetch(JSON.stringify({ prompt: 'Q1' }), {}));
        await withApiKey(() => llm.fetch(JSON.stringify({ prompt: 'Q2' }), {}));

        // Token usage is tracked; we can verify via healthCheck
        const health = await withApiKey(() => llm.healthCheck({ defaultConfigDir: require('path').join(require('os').tmpdir(), 'noexist') }));
        expect(health.tokenUsage.calls).to.be.at.least(2);
    });
});

// ---- agree() multi-proposal judge paths via anthropic_api -----------------

describe('llm provider, agree judge_model paths', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    function withApiKey(fn) {
        const saved = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-judge-key';
        const savedHub  = process.env.HUB_CLAUDE_CONFIG_DIR;
        const savedCli  = process.env.CLAUDE_CONFIG_DIR;
        const savedHubT = process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN;
        const savedCliT = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        delete process.env.HUB_CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        try {
            return fn();
        } finally {
            if (saved === undefined)    delete process.env.ANTHROPIC_API_KEY;
            else                        process.env.ANTHROPIC_API_KEY = saved;
            if (savedHub !== undefined) process.env.HUB_CLAUDE_CONFIG_DIR = savedHub;
            if (savedCli !== undefined) process.env.CLAUDE_CONFIG_DIR = savedCli;
            if (savedHubT !== undefined) process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN = savedHubT;
            if (savedCliT !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedCliT;
        }
    }

    it('returns the canonical proposal when judge says equivalent=true', async function () {
        const llm = _reloadProvider();
        // Judge returns equivalent=true, canonical_index=1 (1-indexed)
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 1}' }],
                usage:   { input_tokens: 50, output_tokens: 10 }
            });

        const proposals = [
            { body: Buffer.from('The capital is Paris.', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('Paris is the capital.', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.not.be.null;
        expect(result.body.toString('utf8')).to.equal('The capital is Paris.');
    });

    it('returns null when judge says equivalent=false', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": false, "canonical_index": null}' }],
                usage:   { input_tokens: 50, output_tokens: 10 }
            });

        const proposals = [
            { body: Buffer.from('Paris', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('London', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('returns null when judge returns JSON wrapped in markdown prose (extraction fails)', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: 'Here is my answer:\n{"equivalent": true, "canonical_index": 2}\nDone.' }],
                usage:   { input_tokens: 50, output_tokens: 15 }
            });

        const proposals = [
            { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        // Hardened parse: the verdict must be the ENTIRE trimmed output as one
        // JSON object. Conversational preamble ("Here is my answer:") no longer
        // has its embedded {...} scraped out and trusted (that was the injection
        // vector, since candidate bodies are attacker-chosen bytes). It fails
        // closed to no_quorum, exactly as this test's title states.
        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('returns null when judge returns no JSON object', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: 'I cannot determine this.' }],
                usage:   { input_tokens: 50, output_tokens: 5 }
            });

        const proposals = [
            { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('returns null when judge returns malformed JSON', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{not valid json}' }],
                usage:   { input_tokens: 50, output_tokens: 5 }
            });

        const proposals = [
            { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('returns null when judge returns equivalent=true but out-of-range canonical_index', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 99}' }],
                usage:   { input_tokens: 50, output_tokens: 10 }
            });

        const proposals = [
            { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('handles proposals with non-Buffer body (converts to string)', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 1}' }],
                usage:   { input_tokens: 50, output_tokens: 10 }
            });

        const proposals = [
            { body: 'string body A', meta: 'claude-sonnet-4-6' },
            { body: 'string body B', meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.not.be.null;
    });

    it('returns null when judge API call times out (network error → null)', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .replyWithError('ETIMEDOUT');

        const proposals = [
            { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('returns null when judge returns empty text (judgeText falsy branch)', async function () {
        // Line 145: `if (!judgeText) return null`
        // Simulate judge returning a response with NO text content items → empty string → falsy
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [],  // empty content → text = '' → falsy
                usage: { input_tokens: 5, output_tokens: 0 }
            });

        const proposals = [
            { body: Buffer.from('A', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('converts null/undefined proposal body to empty string in judge prompt (p.body || "" branch)', async function () {
        // Line 128: `Buffer.isBuffer(p.body) ? p.body.toString('utf8') : String(p.body || '')`
        // p.body is null → falls back to '' via String(null || '') → String('')
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 1}' }],
                usage: { input_tokens: 10, output_tokens: 5 }
            });

        const proposals = [
            { body: null, meta: 'claude-sonnet-4-6' },  // null body → String(null || '') = ''
            { body: Buffer.from('B', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        // canonical_index=1 → proposals[0], which has null body, returned as-is
        expect(result).to.not.be.null;
    });

    it('fails closed to no_quorum when the judge selects a truncated candidate', async function () {
        // A candidate longer than MAX_JUDGE_CANDIDATE_CHARS (4096) is only
        // partially shown to the judge; finalizing its full untruncated body
        // would put bytes the judge never evaluated on-chain. agree() must
        // return null instead of the long candidate.
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 1}' }],
                usage:   { input_tokens: 50, output_tokens: 10 }
            });

        const longBody = 'A'.repeat(4096) + 'HIDDEN-TAIL-THE-JUDGE-NEVER-SAW';
        const proposals = [
            { body: Buffer.from(longBody, 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('A'.repeat(10), 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.be.null;
    });

    it('still selects an at-cap (untruncated) candidate normally', async function () {
        // A candidate exactly at MAX_JUDGE_CANDIDATE_CHARS is fully seen by the
        // judge, so it stays selectable (regression guard for honest traffic).
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 1}' }],
                usage:   { input_tokens: 50, output_tokens: 10 }
            });

        const atCap = 'A'.repeat(4096);
        const proposals = [
            { body: Buffer.from(atCap, 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('A'.repeat(10), 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        const result = await withApiKey(() => llm.agree(proposals));
        expect(result).to.not.be.null;
        expect(result.body.toString('utf8')).to.equal(atCap);
    });

    it('carries the judge rubric and SECURITY framing in the system role, candidates only in the user turn', async function () {
        const llm = _reloadProvider();
        let capturedBody = null;
        nock('https://api.anthropic.com')
            .post('/v1/messages', (body) => { capturedBody = body; return true; })
            .reply(200, {
                content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 1}' }],
                usage:   { input_tokens: 50, output_tokens: 10 }
            });

        const proposals = [
            { body: Buffer.from('The capital is Paris.', 'utf8'), meta: 'claude-sonnet-4-6' },
            { body: Buffer.from('Paris is the capital.', 'utf8'), meta: 'claude-sonnet-4-6' }
        ];

        await withApiKey(() => llm.agree(proposals));
        expect(capturedBody).to.not.be.null;
        // Trusted framing lives in system.
        expect(capturedBody.system).to.include('You are an evaluator');
        expect(capturedBody.system).to.include('SECURITY:');
        expect(capturedBody.system).to.include('canonical_index');
        // User turn carries only the fenced candidates, not the rubric.
        const userMsg = capturedBody.messages[0].content;
        expect(userMsg).to.include('<candidate');
        expect(userMsg).to.include('The capital is Paris.');
        expect(userMsg).to.not.include('You are an evaluator');
    });
});

// ---- auth fallback chain edge cases ----------------------------------------
// These tests use the cache-injection pattern to stub hub-credentials.js
// BEFORE llm.js loads it (same technique as the claude_spawn tests above).

describe('llm provider, auth credential fallback chain', function () {

    let savedCredsCacheEntry;

    afterEach(function () {
        sinon.restore();
        const credsKey = require.resolve('../../src/lib/hub-credentials.js');
        if (savedCredsCacheEntry !== undefined) {
            require.cache[credsKey] = savedCredsCacheEntry;
            savedCredsCacheEntry = undefined;
        } else {
            delete require.cache[credsKey];
        }
    });

    function reloadWithAuthStub(authResult) {
        const credsKey = require.resolve('../../src/lib/hub-credentials.js');
        savedCredsCacheEntry = require.cache[credsKey];

        const fakeResolve = sinon.stub().returns(authResult);
        const fakeOpenAi  = sinon.stub().returns({ ok: false, reason: 'no_credential_configured' });
        require.cache[credsKey] = {
            id: credsKey, filename: credsKey, loaded: true,
            exports: {
                resolveHubLlmAuth: fakeResolve,
                resolveOpenAiAuth: fakeOpenAi,
                // Mirror the real module's vendor dispatch so llm.js's
                // multi-vendor paths route through the same stubs.
                resolveLlmVendorAuth: (vendor, ctx) =>
                    (vendor === 'openai') ? fakeOpenAi(ctx) : fakeResolve(ctx),
                DEFAULT_HUB_CLAUDE_CONFIG_DIR: '/tmp/fake-dir'
            }
        };

        // Reload llm.js so it picks up our fake hub-credentials
        delete require.cache[require.resolve('../../src/providers/llm.js')];
        delete require.cache[require.resolve('../../src/lib/claude-spawn.js')];
        const llm = require('../../src/providers/llm.js');
        return { llm, stub: fakeResolve };
    }

    it('healthCheck uses auth.reason when auth.detail is absent (detail || reason branch)', async function () {
        const { llm } = reloadWithAuthStub({
            ok: false, reason: 'no_creds_configured', detail: null  // detail is null → reason
        });
        const result = await llm.healthCheck({});
        expect(result.ok).to.equal(false);
        expect(result.error).to.equal('no_creds_configured');
    });

    it('healthCheck uses literal fallback when both detail and reason are absent', async function () {
        const { llm } = reloadWithAuthStub({
            ok: false, reason: null, detail: null  // both null → literal
        });
        const result = await llm.healthCheck({});
        expect(result.ok).to.equal(false);
        expect(result.error).to.equal('no_credential_configured');
    });

    it('fetch throws using auth.reason when detail is absent (_runLlm error path)', async function () {
        // B56: `auth.detail || auth.reason || 'no credentials'` in _runLlm
        const { llm } = reloadWithAuthStub({
            ok: false, reason: 'my_custom_reason', detail: null
        });
        let err;
        try { await llm.fetch(JSON.stringify({ prompt: 'hello' }), {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/my_custom_reason/);
    });

    it('fetch throws using literal "no credentials" when both detail and reason are absent', async function () {
        const { llm } = reloadWithAuthStub({
            ok: false, reason: null, detail: null
        });
        let err;
        try { await llm.fetch(JSON.stringify({ prompt: 'hello' }), {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/no credentials/);
    });
});

// ---- _callAnthropic error format edge cases --------------------------------

describe('llm provider, _callAnthropic error format edge cases', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    function withApiKey(fn) {
        const saved = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-edge-key';
        const savedHub  = process.env.HUB_CLAUDE_CONFIG_DIR;
        const savedCli  = process.env.CLAUDE_CONFIG_DIR;
        const savedHubT = process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN;
        const savedCliT = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        delete process.env.HUB_CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN;
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        try { return fn(); }
        finally {
            if (saved === undefined)    delete process.env.ANTHROPIC_API_KEY;
            else                        process.env.ANTHROPIC_API_KEY = saved;
            if (savedHub !== undefined) process.env.HUB_CLAUDE_CONFIG_DIR = savedHub;
            if (savedCli !== undefined) process.env.CLAUDE_CONFIG_DIR = savedCli;
            if (savedHubT !== undefined) process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN = savedHubT;
            if (savedCliT !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedCliT;
        }
    }

    it('rejects with JSON.stringify of error payload when json.error has no message field', async function () {
        // Line 264: `json.error.message ? json.error.message : JSON.stringify(json)`. The stringify branch
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                type: 'error',
                error: { type: 'rate_limit_error' }  // no .message field
            });

        let err;
        try { await withApiKey(() => llm.fetch(JSON.stringify({ prompt: 'Q?' }), {})); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/Anthropic API/);
    });

    it('handles API response where usage fields are null/undefined (??0 fallback)', async function () {
        // Lines 269/270: `json.usage.input_tokens ?? 0` and `output_tokens ?? 0`
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                content: [{ type: 'text', text: 'answer' }],
                usage: {}  // no input_tokens or output_tokens fields → nullish coalesce to 0
            });

        const result = await withApiKey(() => llm.fetch(JSON.stringify({ prompt: 'Q?' }), {}));
        expect(result).to.exist;
    });

    it('handles API error payload with no error field but type=error', async function () {
        // When type === 'error' but json.error is undefined → JSON.stringify fallback
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, { type: 'error' });  // no .error field

        let err;
        try { await withApiKey(() => llm.fetch(JSON.stringify({ prompt: 'Q?' }), {})); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/Anthropic API/);
    });
});

// ---- Multi-vendor fallback chain (Phase 4) ---------------------------------

describe('llm provider, vendor inference', function () {

    afterEach(function () { sinon.restore(); });

    it('maps claude-* to anthropic and gpt-*/o-series to openai', function () {
        const llm = _reloadProvider();
        expect(llm._vendorOfModel('claude-sonnet-4-6')).to.equal('anthropic');
        expect(llm._vendorOfModel('gpt-5-mini')).to.equal('openai');
        expect(llm._vendorOfModel('o3-mini')).to.equal('openai');
        expect(llm._vendorOfModel('chatgpt-4o-latest')).to.equal('openai');
    });

    it('throws on an unmapped model id instead of guessing a vendor', function () {
        const llm = _reloadProvider();
        expect(() => llm._vendorOfModel('llama-3-70b')).to.throw(/cannot infer vendor/);
    });

    it('honors explicit model_vendors overrides from additional_config', function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { model_vendors: { 'llama-3-70b': 'openai' } } });
        expect(llm._vendorOfModel('llama-3-70b')).to.equal('openai');
    });
});

describe('llm provider, fetch via openai_api', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    it('serves an openai-vendor pinned model through api.openai.com', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            const scope = nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => {
                    expect(body.model).to.equal('gpt-5-mini');
                    expect(body.messages[body.messages.length - 1].content).to.equal('hello');
                    return true;
                })
                .reply(200, {
                    choices: [{ message: { role: 'assistant', content: 'world' } }],
                    usage:   { prompt_tokens: 3, completion_tokens: 2 }
                });
            const res = await llm.fetch(JSON.stringify({ prompt: 'hello' }), { pinnedModel: 'gpt-5-mini' });
            expect(res.body.toString('utf8')).to.equal('world');
            expect(res.meta).to.equal('gpt-5-mini');
            expect(scope.isDone()).to.equal(true);
        });
    });

    it('threads the system prompt as a system message', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => {
                    expect(body.messages[0]).to.deep.equal({ role: 'system', content: 'be terse' });
                    return true;
                })
                .reply(200, { choices: [{ message: { content: 'ok' } }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q', system: 'be terse' }), { pinnedModel: 'gpt-5-mini' });
            expect(res.body.toString('utf8')).to.equal('ok');
        });
    });

    it('fails a claude-vendor model when only OpenAI credentials exist', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            let err;
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'claude-sonnet-4-6' }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.match(/HUB_CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|no_credential/);
        });
    });

    it('rejects on an OpenAI API error payload', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(429, { error: { message: 'rate limited' } });
            let err;
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini' }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.match(/OpenAI API: rate limited/);
        });
    });

    // #2488: fetch() must enforce options.maxResponseBytes like http_get does, so an
    // over-cap body fails loudly here instead of being silently dropped by every
    // peer's PROPOSE/PREPARE gate (unattributable quorum loss).
    it('rejects a response exceeding options.maxResponseBytes', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            const big = 'x'.repeat(200);
            nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(200, { choices: [{ message: { content: big } }] });
            let err;
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini', maxResponseBytes: 64 }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.match(/exceeds maxResponseBytes/);
        });
    });

    it('serves a response at/under maxResponseBytes normally', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(200, { choices: [{ message: { content: 'world' } }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini', maxResponseBytes: 64 });
            expect(res.body.toString('utf8')).to.equal('world');
        });
    });
});

describe('llm provider, requester fallback policy', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    it('rejects an unknown envelope.fallback value', async function () {
        const llm = _reloadProvider();
        let err;
        try { await llm.fetch(JSON.stringify({ prompt: 'q', fallback: 'maybe' }), {}); }
        catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/envelope.fallback/);
    });

    it('strict policy refuses a non-primary model without calling any vendor', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            let err;
            try {
                await llm.fetch(JSON.stringify({ prompt: 'q', fallback: 'strict' }),
                                { pinnedModel: 'gpt-5-mini', modelRank: 1 });
            } catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.match(/fallback_policy_strict/);
            expect(nock.pendingMocks().length).to.equal(0);  // nothing was even mocked; no call attempted
        });
    });

    it('strict policy still serves the primary model (rank 0)', async function () {
        await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.anthropic.com')
                .post('/v1/messages')
                .reply(200, { content: [{ type: 'text', text: 'primary answer' }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q', fallback: 'strict' }),
                                        { pinnedModel: 'claude-sonnet-4-6', modelRank: 0 });
            expect(res.body.toString('utf8')).to.equal('primary answer');
        });
    });

    it('default policy (any) serves a fallback-rank model', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(200, { choices: [{ message: { content: 'fallback answer' } }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q' }),
                                        { pinnedModel: 'gpt-5-mini', modelRank: 1 });
            expect(res.body.toString('utf8')).to.equal('fallback answer');
        });
    });
});

describe('llm provider, judge fallback chain', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    const PROPOSALS = [
        { body: Buffer.from('answer A'), meta: 'claude-sonnet-4-6' },
        { body: Buffer.from('answer A.'), meta: 'claude-sonnet-4-6' }
    ];

    it('falls back to an alternate-vendor judge when the pinned judge vendor is down', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-mini'] } });
            // Pinned judge is claude-* with NO anthropic creds → transport
            // failure → chain advances to the OpenAI judge below.
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => body.model === 'gpt-5-mini')
                .reply(200, { choices: [{ message: { content: '{"equivalent": true, "canonical_index": 1}' } }] });
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'claude-haiku-4-5' });
            expect(winner).to.exist;
            expect(winner.body.toString('utf8')).to.equal('answer A');
        });
    });

    it('returns null when the whole judge chain is unreachable', async function () {
        await _withEnv({}, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-mini'] } });
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'claude-haiku-4-5' });
            expect(winner).to.equal(null);
        });
    });

    it('does NOT advance the chain on a reachable judge with an unparseable verdict', async function () {
        await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-mini'] } });
            nock('https://api.anthropic.com')
                .post('/v1/messages')
                .reply(200, { content: [{ type: 'text', text: 'I cannot decide' }] });
            // No openai mock: reaching for gpt-5-mini would throw a nock error.
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'claude-haiku-4-5' });
            expect(winner).to.equal(null);
        });
    });

    it('skips an early o-series pinned judge (cannot carry a system role) and falls back to a capable model', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-mini'] } });
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => body.model === 'gpt-5-mini')
                .reply(200, { choices: [{ message: { content: '{"equivalent": true, "canonical_index": 1}' } }] });
            // o1-mini cannot carry the trusted judge framing in a system/developer
            // turn; it must be filtered out of the chain rather than silently
            // collapsing the SECURITY framing into the user turn.
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'o1-mini' });
            expect(winner).to.exist;
            expect(winner.body.toString('utf8')).to.equal('answer A');
        });
    });

    it('marks options.outcome as inconclusive (not a real verdict) when the whole judge chain is unreachable', async function () {
        await _withEnv({}, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-mini'] } });
            const outcome = {};
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'claude-haiku-4-5', outcome });
            expect(winner).to.equal(null);
            expect(outcome.inconclusive).to.equal(true);
            expect(outcome.reason).to.equal('unreachable');
        });
    });

    it('marks options.outcome as inconclusive on a truncated-candidate fail-closed pick', async function () {
        await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.anthropic.com')
                .post('/v1/messages')
                .reply(200, {
                    content: [{ type: 'text', text: '{"equivalent": true, "canonical_index": 1}' }],
                    usage:   { input_tokens: 50, output_tokens: 10 }
                });
            const longBody = 'A'.repeat(4096) + 'HIDDEN-TAIL-THE-JUDGE-NEVER-SAW';
            const proposals = [
                { body: Buffer.from(longBody, 'utf8'), meta: 'claude-sonnet-4-6' },
                { body: Buffer.from('A'.repeat(10), 'utf8'), meta: 'claude-sonnet-4-6' }
            ];
            const outcome = {};
            const winner = await llm.agree(proposals, { outcome });
            expect(winner).to.equal(null);
            expect(outcome.inconclusive).to.equal(true);
            expect(outcome.reason).to.equal('truncated_pick');
        });
    });

    // #2489: a reasoning-family judge (gpt-5/o-series) bills reasoning against
    // max_completion_tokens, so the 256 pin starved the verdict. Reasoning judges
    // now get JUDGE_MAX_TOKENS_REASONING (2048) while chat judges keep 256.
    it('sends a raised max_completion_tokens for a reasoning-family judge', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            let seenBudget;
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => { seenBudget = body.max_completion_tokens; return body.model === 'gpt-5-mini'; })
                .reply(200, { choices: [{ message: { content: '{"equivalent": true, "canonical_index": 1}' } }] });
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'gpt-5-mini' });
            expect(winner).to.exist;
            expect(seenBudget).to.equal(2048);
        });
    });

    // #2489: a finish_reason 'length' with empty content is budget exhaustion, a
    // reached-judge outcome. It must be classified (not returned as an empty
    // verdict), defer to no_quorum, and NOT advance the chain to a fallback model.
    it('classifies a truncated (finish_reason length, empty content) judge outcome and does not advance the chain', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-nano'] } });
            // Pinned judge returns a length-truncated empty verdict. No mock for the
            // fallback gpt-5-nano: if the chain advanced, nock would throw.
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => body.model === 'gpt-5-mini')
                .reply(200, { choices: [{ finish_reason: 'length', message: { content: '' } }] });
            const outcome = {};
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'gpt-5-mini', outcome });
            expect(winner).to.equal(null);
            expect(outcome.inconclusive).to.equal(true);
            expect(outcome.reason).to.equal('judge_truncation');
        });
    });

    // #2746: the judge budget is a single deadline shared across the whole fallback
    // chain, not a per-attempt allowance. With no budget left, the chain must stop
    // advancing rather than fire another full-budget attempt (k+1 x timeoutMs).
    it('stops advancing the judge chain once the shared budget is exhausted', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-nano'] } });
            // A 1ms budget is below the remaining-budget floor by the time the loop
            // body runs, so NO judge call is dialed (nock scope stays pending).
            const scope = nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(200, { choices: [{ message: { content: '{"equivalent": true, "canonical_index": 1}' } }] });
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'gpt-5-mini', timeoutMs: 1 });
            expect(winner).to.equal(null);
            expect(scope.isDone(), 'no judge call should be dialed with an exhausted budget').to.equal(false);
            nock.cleanAll();
        });
    });

    it('does NOT mark options.outcome as inconclusive when the judge genuinely finds the candidates not equivalent', async function () {
        await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.anthropic.com')
                .post('/v1/messages')
                .reply(200, { content: [{ type: 'text', text: '{"equivalent": false}' }] });
            const outcome = {};
            const winner = await llm.agree(PROPOSALS, { outcome });
            expect(winner).to.equal(null);
            // A genuine not-equivalent verdict is a real judgment, not an
            // inconclusive could-not-judge outcome.
            expect(outcome.inconclusive).to.not.equal(true);
        });
    });
});

describe('llm provider, multi-vendor healthCheck', function () {

    afterEach(function () { sinon.restore(); });

    it('is ok with primary-vendor creds; missing fallback vendors are reported, not fatal', async function () {
        const result = await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: {
                approved_models: ['claude-sonnet-4-6', 'gpt-5-mini'],
                judge_model:     'claude-haiku-4-5'
            } });
            return await llm.healthCheck({ defaultConfigDir: HERMETIC_DEFAULT_DIR });
        });
        expect(result.ok).to.equal(true);
        expect(result.vendors).to.deep.equal({ anthropic: true, openai: false });
        expect(result.missing).to.deep.equal(['openai']);
    });

    it('fails when require_all_vendors is set and a fallback vendor has no creds', async function () {
        const result = await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: {
                approved_models:     ['claude-sonnet-4-6', 'gpt-5-mini'],
                judge_model:         'claude-haiku-4-5',
                require_all_vendors: true
            } });
            return await llm.healthCheck({ defaultConfigDir: HERMETIC_DEFAULT_DIR });
        });
        expect(result.ok).to.equal(false);
        expect(result.error).to.match(/openai/);
    });

    it('passes require_all_vendors once every vendor resolves', async function () {
        const result = await _withEnv({ ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-oai' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: {
                approved_models:     ['claude-sonnet-4-6', 'gpt-5-mini'],
                judge_model:         'claude-haiku-4-5',
                judge_fallback_models: ['gpt-5-mini'],
                require_all_vendors: true
            } });
            return await llm.healthCheck({ defaultConfigDir: HERMETIC_DEFAULT_DIR });
        });
        expect(result.ok).to.equal(true);
        expect(result.vendors).to.deep.equal({ anthropic: true, openai: true });
        expect(result.missing).to.equal(undefined);
    });

    it('fails when the PRIMARY vendor has no creds even if a fallback vendor does', async function () {
        const result = await _withEnv({ OPENAI_API_KEY: 'sk-oai' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: {
                approved_models: ['claude-sonnet-4-6', 'gpt-5-mini'],
                judge_model:     'claude-haiku-4-5'
            } });
            return await llm.healthCheck({ defaultConfigDir: HERMETIC_DEFAULT_DIR });
        });
        expect(result.ok).to.equal(false);
        expect(result.vendors).to.deep.equal({ anthropic: false, openai: true });
    });
});

// ---- hub-credentials vendor resolution -------------------------------------

describe('hub-credentials, resolveOpenAiAuth / resolveLlmVendorAuth', function () {

    function freshCreds() {
        delete require.cache[require.resolve('../../src/lib/hub-credentials.js')];
        return require('../../src/lib/hub-credentials.js');
    }

    it('resolves HUB_OPENAI_API_KEY ahead of OPENAI_API_KEY', function () {
        const creds = freshCreds();
        const r = creds.resolveOpenAiAuth({ env: { HUB_OPENAI_API_KEY: 'hub-key', OPENAI_API_KEY: 'ambient-key' } });
        expect(r.ok).to.equal(true);
        expect(r.transport).to.equal('openai_api');
        expect(r.source).to.equal('hub_api_key');
        expect(r.apiKey).to.equal('hub-key');
    });

    it('reports no_credential_configured when neither OpenAI var is set', function () {
        const creds = freshCreds();
        const r = creds.resolveOpenAiAuth({ env: {} });
        expect(r.ok).to.equal(false);
        expect(r.reason).to.equal('no_credential_configured');
    });

    it('dispatches vendors and rejects unknown ones', function () {
        const creds = freshCreds();
        const oai = creds.resolveLlmVendorAuth('openai', { env: { OPENAI_API_KEY: 'k' } });
        expect(oai.ok).to.equal(true);
        expect(oai.transport).to.equal('openai_api');
        const anth = creds.resolveLlmVendorAuth('anthropic', { env: { ANTHROPIC_API_KEY: 'k' }, defaultConfigDir: HERMETIC_DEFAULT_DIR });
        expect(anth.ok).to.equal(true);
        expect(anth.transport).to.equal('anthropic_api');
        const unknown = creds.resolveLlmVendorAuth('acme', { env: {} });
        expect(unknown.ok).to.equal(false);
        expect(unknown.reason).to.equal('unknown_vendor');
    });
});
