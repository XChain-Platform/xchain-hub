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
 * XChain Hub - llm attestation provider tests: the HTTP transports
 *
 * The suites here drive fetch() and agree() through nock-intercepted vendor
 * HTTP calls: the governance bounds observed on the request body, the
 * sampling-parameter gate, the message and chat transports, the judge
 * paths and their fallback chain, vendor inference and multi-vendor
 * healthCheck. The transport-free surface (healthCheck credentials, the
 * envelope validation, _setConfig, the claude_spawn transport with its
 * spend audit and budget, the kill switch, the auth fallback chain and
 * agree() meta canonicalization) lives in the llm_provider_* siblings.
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

// Reload the module under each scenario so its env-dependent require-time
// state is fresh. cache-bust the dependency chain too.
function _reloadProvider(){
    delete require.cache[require.resolve('../../../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../../../src/lib/hub_credentials.js')];
    delete require.cache[require.resolve('../../../../src/providers/llm/claude_spawn.js')];
    return require('../../../../src/providers/llm.js');
}

// max_completion_tokens was the one governance key installed on a bare
// truthy check, so -1 / 1.5 / Infinity became the federation-wide token budget.
// MAX_TOKENS_DEFAULT has no getter; the observable is the budget the vendor is sent.
describe('llm provider, governance max_completion_tokens bounds (#4466)', function () {

    afterEach(function () { nock.cleanAll(); sinon.restore(); });

    async function anthropicMaxTokensFor(additionalConfig) {
        return await _withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
            const llm = _reloadProvider();
            const warn = sinon.stub(console, 'warn');
            llm._setConfig({ additional_config: additionalConfig });
            warn.restore();
            let capturedBody;
            nock('https://api.anthropic.com')
                .post('/v1/messages', (body) => { capturedBody = body; return true; })
                .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
            await llm.fetch(JSON.stringify({ prompt: 'q' }), {});
            return capturedBody.max_tokens;
        });
    }

    registerMaxTokensBoundTests(anthropicMaxTokensFor);
});

function registerMaxTokensBoundTests(anthropicMaxTokensFor) {
    it('installs a valid positive-integer budget', async function () {
        expect(await anthropicMaxTokensFor({ max_completion_tokens: 2048 })).to.equal(2048);
    });

    it('ignores a negative budget instead of sending it to the vendor', async function () {
        // -1 survived the min() clamp in fetch() and was sent verbatim.
        expect(await anthropicMaxTokensFor({ max_completion_tokens: -1 })).to.equal(1024);
    });

    it('ignores a fractional budget', async function () {
        expect(await anthropicMaxTokensFor({ max_completion_tokens: 1.5 })).to.equal(1024);
    });

    it('ignores a non-finite budget', async function () {
        expect(await anthropicMaxTokensFor({ max_completion_tokens: Number.POSITIVE_INFINITY })).to.equal(1024);
    });

    it('ignores a non-numeric budget', async function () {
        expect(await anthropicMaxTokensFor({ max_completion_tokens: 'abc' })).to.equal(1024);
    });

    it('ignores zero rather than installing a zero-token budget', async function () {
        expect(await anthropicMaxTokensFor({ max_completion_tokens: 0 })).to.equal(1024);
    });

    it('does not let a negative budget reach a reasoning model as headroom-corrected', async function () {
        // -1 + FETCH_REASONING_TOKEN_HEADROOM = 2047: a valid-LOOKING budget, which is
        // why this path never surfaced a 400 and produced a silently wrong one instead.
        const sent = await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            const warn = sinon.stub(console, 'warn');
            llm._setConfig({ additional_config: { max_completion_tokens: -1 } });
            warn.restore();
            let capturedBody;
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => { capturedBody = body; return true; })
                .reply(200, { choices: [{ message: { content: 'ok' } }] });
            await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini' });
            return capturedBody.max_completion_tokens;
        });
        expect(sent).to.equal(1024 + 2048);
    });
}

// the Anthropic branch emitted `temperature` for every model, but the
// Opus 4.7+ / Sonnet 5 / Fable 5 contract REMOVED the sampling parameters (HTTP 400,
// not accepted-and-ignored). claude-opus-4-7 is the default approved_models fallback
// and the pinned temperature-0 judge, so those calls were deterministic vendor 400s.
describe('llm provider, anthropic sampling-parameter gate (#4464)', function () {

    afterEach(function () { nock.cleanAll(); sinon.restore(); });

    function withApiKey(fn) { return _withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, fn); }

    async function anthropicBodyForModel(pinnedModel) {
        return await withApiKey(async () => {
            const llm = _reloadProvider();
            let capturedBody;
            nock('https://api.anthropic.com')
                .post('/v1/messages', (body) => { capturedBody = body; return true; })
                .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
            await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel });
            return capturedBody;
        });
    }

    registerSamplingGateTests(withApiKey, anthropicBodyForModel);
});

function registerSamplingGateTests(withApiKey, anthropicBodyForModel) {
    it('classifies the sampling-free Anthropic families, bare and dated', function () {
        const llm = _reloadProvider();
        for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
                          'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5'])
            expect(llm.anthropicRejectsSampling(id), id).to.equal(true);
        expect(llm.anthropicRejectsSampling('claude-opus-4-7-20260101')).to.equal(true);
    });

    it('leaves every other Anthropic id on the explicit-temperature path', function () {
        const llm = _reloadProvider();
        for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5',
                          'claude-future-not-yet-listed', '', undefined])
            expect(llm.anthropicRejectsSampling(id), String(id)).to.equal(false);
        // Prefix-only ids must not match by substring: 4-6 is not 4-7's family.
        expect(llm.anthropicRejectsSampling('claude-opus-4-70')).to.equal(false);
    });

    it('omits temperature for the default claude-opus-4-7 fallback', async function () {
        const body = await anthropicBodyForModel('claude-opus-4-7');
        expect(body).to.not.have.property('temperature');
        expect(body.model).to.equal('claude-opus-4-7');
    });

    it('keeps the temperature-0 contract for claude-sonnet-4-6, which still honors it', async function () {
        const body = await anthropicBodyForModel('claude-sonnet-4-6');
        expect(body.temperature).to.equal(0);
    });

    it('omits temperature on the Opus 4.7 judge call too', async function () {
        const captured = await withApiKey(async () => {
            const llm = _reloadProvider();
            let capturedBody;
            nock('https://api.anthropic.com')
                .post('/v1/messages', (body) => { capturedBody = body; return true; })
                .reply(200, {
                    content: [{ type: 'text', text: '{"equivalent":true,"canonical_index":1}' }],
                    usage:   { input_tokens: 1, output_tokens: 1 }
                });
            const proposals = [{ body: Buffer.from('a'), meta: 'm' }, { body: Buffer.from('a'), meta: 'm' }];
            await llm.agree(proposals, { pinnedJudgeModel: 'claude-opus-4-7' });
            return capturedBody;
        });
        expect(captured.model).to.equal('claude-opus-4-7');
        expect(captured).to.not.have.property('temperature');
    });
}

// item 3890: max_tokens and temperature are requester-supplied numerics that used to
// reach the vendor body unvalidated. The damage was not a uniform 400 - it forked three
// ways by model family (the reasoning headroom add turns a negative budget positive; the
// reasoning path omits temperature entirely), so one malformed field produced three
// different behaviors out of an attested payload.
describe('llm provider, envelope numeric bounds', function () {

    afterEach(function () { nock.cleanAll(); });

    async function rejects(envelope, options) {
        const llm = _reloadProvider();
        let err;
        try { await llm.fetch(JSON.stringify({ prompt: 'q', ...envelope }), options || {}); }
        catch (e) { err = e; }
        expect(err, 'fetch rejected the envelope').to.exist;
        return err;
    }

    registerEnvelopeRejectTests(rejects);
    registerEnvelopeTemperatureTests(rejects);
});

function registerEnvelopeRejectTests(rejects) {
    it('rejects a negative max_tokens instead of clamping it', async function () {
        expect((await rejects({ max_tokens: -1 })).message).to.match(/max_tokens must be a positive integer/);
    });

    it('rejects max_tokens 0', async function () {
        expect((await rejects({ max_tokens: 0 })).message).to.match(/max_tokens must be a positive integer/);
    });

    it('rejects a fractional max_tokens', async function () {
        expect((await rejects({ max_tokens: 1.5 })).message).to.match(/max_tokens must be a positive integer/);
    });

    // envelope.system was the one requester field forwarded untyped: an object became
    // '[object Object]' in json_object mode and failed per transport in text mode.
    it('rejects a non-string envelope.system at the boundary (object, number, null)', async function () {
        expect((await rejects({ system: { role: 'x' } })).message).to.match(/envelope\.system must be a string/);
        expect((await rejects({ system: 42 })).message).to.match(/envelope\.system must be a string/);
        expect((await rejects({ system: null })).message).to.match(/envelope\.system must be a string/);
    });

    // The headroom add is what made this case silent: -1 + 2048 = 2047, a valid-looking
    // budget the vendor accepts, so no 400 ever surfaced the bad envelope.
    it('rejects a negative max_tokens on a reasoning model rather than sending 2047', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const scope = nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(200, { choices: [{ message: { content: 'should not be reached' } }] });
            expect((await rejects({ max_tokens: -1 }, { pinnedModel: 'gpt-5-mini' })).message)
                .to.match(/max_tokens must be a positive integer/);
            expect(scope.isDone(), 'no vendor call was made').to.equal(false);
        });
    });

    it('rejects an out-of-range temperature on either side', async function () {
        expect((await rejects({ temperature: 5 })).message).to.match(/temperature must be a number in \[0, 2\]/);
        expect((await rejects({ temperature: -3 })).message).to.match(/temperature must be a number in \[0, 2\]/);
    });
}

function registerEnvelopeTemperatureTests(rejects) {
    // Anthropic caps at 1 where OpenAI chat allows 2, so the bound is vendor-resolved
    // once the model is pinned. Same pinned model + pinned vendor map on every validator,
    // so the split verdict is still deterministic.
    it('bounds temperature at 1 for an anthropic-vendor model', async function () {
        expect((await rejects({ temperature: 1.5 })).message)
            .to.match(/temperature must be a number in \[0, 1\] for this model/);
    });

    it('accepts the same 1.5 against an openai chat model', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            let capturedBody;
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => { capturedBody = body; return true; })
                .reply(200, { choices: [{ message: { content: 'ok' } }] });
            await llm.fetch(JSON.stringify({ prompt: 'q', temperature: 1.5 }), { pinnedModel: 'gpt-4o' });
            expect(capturedBody.temperature).to.equal(1.5);
        });
    });

    it('leaves the defaults alone when neither field is supplied', async function () {
        await _withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
            const llm = _reloadProvider();
            let capturedBody;
            nock('https://api.anthropic.com')
                .post('/v1/messages', (body) => { capturedBody = body; return true; })
                .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
            await llm.fetch(JSON.stringify({ prompt: 'q' }), {});
            expect(capturedBody.max_tokens).to.equal(1024);
            expect(capturedBody.temperature).to.equal(0);
        });
    });
}

// The vendor bound on an explicit envelope.temperature never covered the GOVERNANCE
// default, which fetch() falls back to whenever the envelope omits the field. An
// out-of-range default_temperature is legal for OpenAI (up to 2) and 400s every
// Anthropic call, so a single config change with no deploy behind it took out the
// default approved_models federation-wide.
describe('llm provider, governance default_temperature bounds', function () {

    afterEach(function () { nock.cleanAll(); });

    async function anthropicBodyFor(additionalConfig) {
        return await _withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: additionalConfig });
            let capturedBody;
            nock('https://api.anthropic.com')
                .post('/v1/messages', (body) => { capturedBody = body; return true; })
                .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
            await llm.fetch(JSON.stringify({ prompt: 'q' }), {});
            return capturedBody;
        });
    }

    it('applies an in-range governance default to a fetch that omits temperature', async function () {
        const body = await anthropicBodyFor({ default_temperature: 0.4 });
        expect(body.temperature).to.equal(0.4);
    });

    it('ignores an above-range governance default instead of 400ing every anthropic fetch', async function () {
        const body = await anthropicBodyFor({ default_temperature: 1.5 });
        expect(body.temperature).to.equal(0);
    });

    it('ignores a negative governance default', async function () {
        const body = await anthropicBodyFor({ default_temperature: -1 });
        expect(body.temperature).to.equal(0);
    });

    it('ignores a non-finite governance default', async function () {
        const body = await anthropicBodyFor({ default_temperature: Number.POSITIVE_INFINITY });
        expect(body.temperature).to.equal(0);
    });

    it('leaves an explicit in-range envelope temperature untouched on the anthropic path', async function () {
        await _withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
            const llm = _reloadProvider();
            let capturedBody;
            nock('https://api.anthropic.com')
                .post('/v1/messages', (body) => { capturedBody = body; return true; })
                .reply(200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
            await llm.fetch(JSON.stringify({ prompt: 'q', temperature: 0.9 }), {});
            expect(capturedBody.temperature).to.equal(0.9);
        });
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

    registerApiFetchResponseTests(withApiKey);
    registerApiFetchEnvelopeTests(withApiKey);
    registerApiFetchAuditAndSystemTests(withApiKey);
    registerApiFetchErrorTests(withApiKey);
    registerApiFetchEmptyAndEnvTests(withApiKey);
    registerApiFetchModelPinTests(withApiKey);
    registerApiJudgePinTests(withApiKey);
});

function registerApiFetchResponseTests(withApiKey) {
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

    // item 4467: the truncation guards used to fire only when the emitted text was
    // EMPTY, so a truncated-but-non-empty response was returned as a complete answer
    // -- and on this path that partial is what fetch() signs as the on-chain
    // attestation body. Both Anthropic truncation stops must fail closed at any
    // emitted length, including model_context_window_exceeded, which was previously
    // not handled at all.
    for (const stopReason of ['max_tokens', 'model_context_window_exceeded']) {
        it('fails closed on a NON-EMPTY Anthropic response truncated by ' + stopReason, async function () {
            const llm = _reloadProvider();
            nock('https://api.anthropic.com')
                .post('/v1/messages')
                .reply(200, {
                    stop_reason: stopReason,
                    content: [{ type: 'text', text: 'Paris is the capital of Fra' }],
                    usage:   { input_tokens: 10, output_tokens: 8 }
                });

            let err;
            try {
                await withApiKey(() => llm.fetch(JSON.stringify({ prompt: 'Capital of France?' }), {}));
            } catch (e) { err = e; }

            expect(err, 'a partial answer must never be signed on-chain').to.exist;
            expect(err.kind).to.equal('truncation');
            expect(err.transient).to.equal(false);
        });
    }
}

function registerApiFetchEnvelopeTests(withApiKey) {
    it('still returns a complete Anthropic response whose stop_reason is end_turn', async function () {
        const llm = _reloadProvider();
        nock('https://api.anthropic.com')
            .post('/v1/messages')
            .reply(200, {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Paris.' }],
                usage:   { input_tokens: 10, output_tokens: 2 }
            });

        const result = await withApiKey(() =>
            llm.fetch(JSON.stringify({ prompt: 'Capital of France?' }), {})
        );
        expect(result.body.toString('utf8')).to.equal('Paris.');
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
}

function registerApiFetchAuditAndSystemTests(withApiKey) {
    // - the audit wraps the dispatch, so it must cover the HTTP
    // transports too, not only the CLI branch its own tests live in.
    it('writes an intent/settle pair carrying real usage on the API transport', async function () {
        const fsSync   = require('fs');
        const sinkPath = path.join(os.tmpdir(), 'llm-spend-api-' + process.pid + '.jsonl');
        const saved    = process.env.LLM_SPEND_LOG_PATH;
        process.env.LLM_SPEND_LOG_PATH = sinkPath;
        try {
            const llm = _reloadProvider();
            nock('https://api.anthropic.com')
                .post('/v1/messages')
                .reply(200, {
                    content: [{ type: 'text', text: 'ok' }],
                    usage:   { input_tokens: 9, output_tokens: 4 }
                });

            await withApiKey(() => llm.fetch(JSON.stringify({ prompt: 'Q?' }), {}));

            const lines = fsSync.readFileSync(sinkPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
            expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'settle']);
            expect(lines[0].transport).to.equal('anthropic_api');
            expect(lines[1].id).to.equal(lines[0].id);
            expect(lines[1].usage.tokens).to.deep.equal({ input_tokens: 9, output_tokens: 4 });
        } finally {
            if (saved === undefined) delete process.env.LLM_SPEND_LOG_PATH;
            else process.env.LLM_SPEND_LOG_PATH = saved;
            try { fsSync.unlinkSync(sinkPath); } catch { /* never written */ }
        }
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
}

function registerApiFetchErrorTests(withApiKey) {
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
}

function registerApiFetchEmptyAndEnvTests(withApiKey) {
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
}

function registerApiFetchModelPinTests(withApiKey) {
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
}

function registerApiJudgePinTests(withApiKey) {
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
}

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

    registerJudgeVerdictTests(withApiKey);
    registerJudgeParseFailureTests(withApiKey);
    registerJudgeEdgeTests(withApiKey);
    registerJudgeBodyTests(withApiKey);
    registerJudgeTruncationTests(withApiKey);
    registerJudgeFramingTests(withApiKey);
});

function registerJudgeVerdictTests(withApiKey) {
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
}

function registerJudgeParseFailureTests(withApiKey) {
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
}

function registerJudgeEdgeTests(withApiKey) {
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
}

function registerJudgeBodyTests(withApiKey) {
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
}

function registerJudgeTruncationTests(withApiKey) {
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
}

function registerJudgeFramingTests(withApiKey) {
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
}

// ---- callAnthropic error format edge cases --------------------------------

describe('llm provider, callAnthropic error format edge cases', function () {

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

    registerErrorFormatTests(withApiKey);
});

function registerErrorFormatTests(withApiKey) {
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
}

// ---- Multi-vendor fallback chain (Phase 4) ---------------------------------

describe('llm provider, vendor inference', function () {

    afterEach(function () { sinon.restore(); });

    registerVendorMapTests();
    registerVendorPinningTests();
});

function registerVendorMapTests() {
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

    // item 3482: the pinned map travels with the pinned model id from the SAME
    // block-anchored config, so a hub that has not yet hotReloaded still resolves
    // the vendor instead of throwing and recording provider_error alone.
    it('lets a block-anchored vendor map resolve an id the live module map has never seen', function () {
        const llm = _reloadProvider();
        expect(() => llm._vendorOfModel('llama-3-70b')).to.throw(/cannot infer vendor/);
        expect(llm._vendorOfModel('llama-3-70b', { 'llama-3-70b': 'openai' })).to.equal('openai');
    });

    it('gives the block-anchored map precedence over the live module map', function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { model_vendors: { 'llama-3-70b': 'anthropic' } } });
        expect(llm._vendorOfModel('llama-3-70b', { 'llama-3-70b': 'openai' })).to.equal('openai');
        // A pinned map that says nothing about this id no longer falls through to the
        // live map: the two are the same governance field at two different anchors, so
        // consulting the local one would resolve an anchored round against whatever
        // config this hub happens to hold. Deterministic throw on every hub instead.
        expect(() => llm._vendorOfModel('llama-3-70b', { 'other-model': 'openai' }))
            .to.throw(/cannot infer vendor/);
    });
}

function registerVendorPinningTests() {
    // #7167: the divergence the exclusivity rule exists to stop. Same block-anchored
    // request, two hubs at different hotReload states; without exclusivity the reloaded
    // one routes claude-sonnet-4-6 to OpenAI and the laggard to Anthropic, prompting two
    // different third parties over one round.
    it('ignores a live model_vendors override when a block-anchored map is supplied', function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { model_vendors: { 'claude-sonnet-4-6': 'openai' } } });
        expect(llm._vendorOfModel('claude-sonnet-4-6', {}),
            'anchored: the live override is not consulted, prefix inference answers')
            .to.equal('anthropic');
        expect(llm._vendorOfModel('claude-sonnet-4-6'),
            'unpinned: the live override still wins, unchanged')
            .to.equal('openai');
    });

    it('routes fetch through options.pinnedVendors for an unmapped model family', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            // Module map deliberately left empty: only the per-call pinned map knows.
            const scope = nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => body.model === 'llama-3-70b')
                .reply(200, { choices: [{ message: { content: 'ok' } }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q' }), {
                pinnedModel: 'llama-3-70b',
                pinnedVendors: { 'llama-3-70b': 'openai' }
            });
            expect(res.body.toString('utf8')).to.equal('ok');
            expect(scope.isDone()).to.equal(true);
        });
    });

    it('still fails a fetch on an unmapped id when no pinned vendor map is supplied', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            let err;
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'llama-3-70b' }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.message).to.match(/cannot infer vendor/);
        });
    });
}

// #7168: the HTTP status decides whether a response is a completion; the body's
// shape only says which vendor wrote the error. Both transports asked the second
// question alone, so a gateway 503 carrying neither `error` nor `type` parsed
// clean, resolved as SUCCESS, and degraded to empty text -- on agree() that is
// `empty_verdict`, which the spot-checker does not hold for re-judge, so the
// outage discarded the check with no evidence while the SAME 503 with a vendor
// error envelope failed over correctly.
describe('llm provider, HTTP status-first error classification (#7168)', function () {

    afterEach(function () { nock.cleanAll(); sinon.restore(); });

    it('rejects an Anthropic 503 whose body carries no error envelope', async function () {
        await _withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.anthropic.com')
                .post('/v1/messages')
                .reply(503, { message: 'Service unavailable' });
            let err;
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'claude-sonnet-4-6' }); }
            catch (e) { err = e; }
            expect(err, 'a 503 must not resolve as a completion').to.exist;
            expect(err.httpStatus).to.equal(503);
            expect(err.transient, 'a 5xx earns a same-round judge fallback').to.equal(true);
        });
    });

    it('rejects an OpenAI 503 whose body carries no error envelope', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(503, { message: 'Service unavailable' });
            let err;
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini' }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.httpStatus).to.equal(503);
            expect(err.transient).to.equal(true);
        });
    });

    it('classifies an envelope-less 4xx as hard, so the judge chain stops honestly', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(400, { detail: 'bad request' });
            let err;
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini' }); }
            catch (e) { err = e; }
            expect(err).to.exist;
            expect(err.httpStatus).to.equal(400);
            expect(err.transient).to.equal(false);
        });
    });

    it('still serves a normal 200 completion', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            nock('https://api.openai.com')
                .post('/v1/chat/completions')
                .reply(200, { choices: [{ message: { content: 'served' } }], usage: {} });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini' });
            expect(res.body.toString('utf8')).to.equal('served');
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

    registerJudgeChainFallbackTests(PROPOSALS);
    registerJudgeChainUnreachableTests(PROPOSALS);
    registerSpentBudgetSuite(PROPOSALS);
    registerJudgeChainOutcomeTests(PROPOSALS);
    registerJudgeChainTruncationTests(PROPOSALS);
    registerJudgeChainHardErrorTests(PROPOSALS);
    registerJudgeChainBudgetTests(PROPOSALS);
});

function registerJudgeChainFallbackTests(PROPOSALS) {
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
}

function registerJudgeChainUnreachableTests(PROPOSALS) {
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
}

function registerSpentBudgetSuite(PROPOSALS) {
    // A spent per-window budget is hub-global (one SpendGuard for every model and
    // vendor), so the fallback chain must stop before dialing anything and record a
    // budget reason rather than walking every model and stamping 'unreachable'.
    describe('spent spend budget', function () {
        let savedWindow;
        beforeEach(function () { savedWindow = process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW; });
        afterEach(function () {
            if (savedWindow === undefined) delete process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW;
            else process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = savedWindow;
        });

        it('stops the judge chain before any vendor call and records budget_exhausted', async function () {
            process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = '1';   // under one estimated call
            await _withEnv({ ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-oai-test' }, async () => {
                const llm = _reloadProvider();
                llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-mini'] } });
                // No nock interceptors: any dial would throw a nock error and advance the chain.
                const outcome = {};
                const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'claude-haiku-4-5', outcome });
                expect(winner).to.equal(null);
                expect(outcome.inconclusive).to.equal(true);
                expect(outcome.reason).to.equal('budget_exhausted');
                // The pre-loop gate is a pure predicate: nothing was reserved or blocked.
                expect(llm.spendStats().spentInWindowUsdCents).to.equal(0);
                llm._resetSpendGuardForTest();
            });
        });

        it('types the budget error at its source for every runLlm caller', async function () {
            process.env.LLM_MAX_SPEND_USD_CENTS_PER_WINDOW = '1';
            await _withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
                const llm = _reloadProvider();
                let err;
                try { await llm.fetch(JSON.stringify({ prompt: 'hi' }), {}); }
                catch (e) { err = e; }
                expect(err).to.exist;
                expect(err.budgetExhausted).to.equal(true);
                expect(err.kind).to.equal('budget_exhausted');
                expect(err.transient, 'a spend stop heals when the window rolls').to.equal(undefined);
                llm._resetSpendGuardForTest();
            });
        });
    });
}

function registerJudgeChainOutcomeTests(PROPOSALS) {
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
}

function registerJudgeChainTruncationTests(PROPOSALS) {
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

    // item 4467: the same length-stop with NON-EMPTY content was returned as a
    // complete verdict, so a coincidentally-parseable partial JSON object could be
    // finalized as consensus truth. A 'length' stop is truncation at any emitted
    // length; it must classify identically to the empty case above and still not
    // advance the chain.
    it('classifies a truncated (finish_reason length, NON-empty content) judge outcome and does not advance the chain', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-nano'] } });
            // A partial verdict that still parses as JSON. No mock for the fallback
            // gpt-5-nano: if the chain advanced, nock would throw.
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => body.model === 'gpt-5-mini')
                .reply(200, { choices: [{
                    finish_reason: 'length',
                    message: { content: '{"equivalent": true, "canonical_index": 1}' }
                }] });
            const outcome = {};
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'gpt-5-mini', outcome });
            expect(winner, 'a truncated partial must not become the verdict').to.equal(null);
            expect(outcome.inconclusive).to.equal(true);
            expect(outcome.reason).to.equal('judge_truncation');
        });
    });
}

function registerJudgeChainHardErrorTests(PROPOSALS) {
    // item 3481: a reached judge can also fail hard for reasons that are NOT a model
    // refusal (a 4xx from a retired model id, an auth misconfiguration, a non-zero
    // claude CLI exit). Those arrive with err.transient false and err.kind undefined.
    // The chain still must not advance, but the recorded reason has to say hard error
    // so vendor-contract drift is distinguishable from content moderation.
    it('records judge_hard_error (not judge_refusal) for a non-transient API error with no kind', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-nano'] } });
            // No mock for the fallback gpt-5-nano: if the chain advanced, nock throws.
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => body.model === 'gpt-5-mini')
                .reply(400, { error: { message: 'model gpt-5-mini is not supported' } });
            const outcome = {};
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'gpt-5-mini', outcome });
            expect(winner).to.equal(null);
            expect(outcome.inconclusive).to.equal(true);
            expect(outcome.reason).to.equal('judge_hard_error');
        });
    });

    it('still records judge_refusal for a genuine model refusal', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { judge_fallback_models: ['gpt-5-nano'] } });
            nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => body.model === 'gpt-5-mini')
                .reply(200, { choices: [{ message: { content: null, refusal: 'I cannot help with that' } }] });
            const outcome = {};
            const winner = await llm.agree(PROPOSALS, { pinnedJudgeModel: 'gpt-5-mini', outcome });
            expect(winner).to.equal(null);
            expect(outcome.inconclusive).to.equal(true);
            expect(outcome.reason).to.equal('judge_refusal');
        });
    });
}

function registerJudgeChainBudgetTests(PROPOSALS) {
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
}

describe('llm provider, multi-vendor healthCheck', function () {

    afterEach(function () { sinon.restore(); });

    registerMultiVendorHealthTests();
});

function registerMultiVendorHealthTests() {
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
}

// ---- hub-credentials vendor resolution -------------------------------------

describe('hub-credentials, resolveOpenAiAuth / resolveLlmVendorAuth', function () {

    function freshCreds() {
        delete require.cache[require.resolve('../../../../src/lib/hub_credentials.js')];
        return require('../../../../src/lib/hub_credentials.js');
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
