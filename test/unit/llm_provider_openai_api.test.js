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
 * XChain Hub - llm attestation provider tests: fetch() via openai_api
 *
 * The OpenAI chat transport: reasoning-family classification and the
 * temperature and token-budget shape it decides, the request and system
 * message shape, error payloads and the maxResponseBytes cap.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const nock       = require('nock');

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
    delete require.cache[require.resolve('../../src/providers/llm.js')];
    delete require.cache[require.resolve('../../src/lib/hub_credentials.js')];
    delete require.cache[require.resolve('../../src/providers/llm/claude_spawn.js')];
    return require('../../src/providers/llm.js');
}

// item 3535: the reasoning predicate gates BOTH the temperature on the OpenAI
// request and the reasoning token headroom. A bare /^gpt-5/ also matched the
// non-reasoning gpt-5-chat* ChatGPT model, which honors an explicit temperature,
// so a judge call meant to run deterministically at 0 silently ran at the API
// default of 1. These cases pin the family boundary on both sides.
describe('llm provider, reasoning-family classification (item 3535)', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    registerReasoningClassificationTests();
    registerReasoningTransportTests();
});

function registerReasoningClassificationTests() {
    it('classifies the gpt-5 reasoning ids and the o-series as reasoning', function () {
        const llm = _reloadProvider();
        expect(llm._isReasoningModel('gpt-5')).to.equal(true);
        expect(llm._isReasoningModel('gpt-5-mini')).to.equal(true);
        expect(llm._isReasoningModel('gpt-5-nano')).to.equal(true);
        expect(llm._isReasoningModel('o3')).to.equal(true);
        expect(llm._isReasoningModel('o1-mini')).to.equal(true);
        // a version segment must not by itself demote a reasoning id.
        expect(llm._isReasoningModel('gpt-5.1')).to.equal(true);
        expect(llm._isReasoningModel('gpt-5.1-mini')).to.equal(true);
    });

    it('does NOT classify the non-reasoning gpt-5-chat variants as reasoning', function () {
        const llm = _reloadProvider();
        expect(llm._isReasoningModel('gpt-5-chat-latest')).to.equal(false);
        expect(llm._isReasoningModel('gpt-5-chat')).to.equal(false);
        expect(llm._isReasoningModel('gpt-4o')).to.equal(false);
        expect(llm._isReasoningModel('claude-sonnet-4-6')).to.equal(false);
        // the version segment sits between `gpt-5` and `-chat`, so the
        // old literal `(?!-chat)` lookahead cleared and these read as reasoning.
        expect(llm._isReasoningModel('gpt-5.1-chat-latest')).to.equal(false);
        expect(llm._isReasoningModel('gpt-5.2-chat-latest')).to.equal(false);
        expect(llm._isReasoningModel('gpt-5.3-chat-latest')).to.equal(false);
    });
}

function registerReasoningTransportTests() {
    it('sends the explicit temperature and plain budget for a VERSIONED chat id (#4465)', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            const scope = nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => {
                    expect(body.temperature, 'temperature-0 contract must survive').to.equal(0);
                    expect(body.max_completion_tokens, 'no reasoning headroom').to.equal(1024);
                    return true;
                })
                .reply(200, { choices: [{ message: { content: 'ok' } }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5.1-chat-latest' });
            expect(res.body.toString('utf8')).to.equal('ok');
            expect(scope.isDone()).to.equal(true);
        });
    });

    it('sends the explicit temperature and the plain token budget for gpt-5-chat-latest', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            const scope = nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => {
                    expect(body.temperature, 'temperature-0 contract must survive for a chat model').to.equal(0);
                    expect(body.max_completion_tokens, 'no reasoning headroom for a chat model').to.equal(1024);
                    return true;
                })
                .reply(200, { choices: [{ message: { content: 'ok' } }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-chat-latest' });
            expect(res.body.toString('utf8')).to.equal('ok');
            expect(scope.isDone()).to.equal(true);
        });
    });

    it('still omits temperature and adds reasoning headroom for gpt-5-mini', async function () {
        await _withEnv({ OPENAI_API_KEY: 'sk-oai-test' }, async () => {
            const llm = _reloadProvider();
            const scope = nock('https://api.openai.com')
                .post('/v1/chat/completions', (body) => {
                    expect(body).to.not.have.property('temperature');
                    expect(body.max_completion_tokens).to.equal(1024 + 2048);
                    return true;
                })
                .reply(200, { choices: [{ message: { content: 'ok' } }] });
            const res = await llm.fetch(JSON.stringify({ prompt: 'q' }), { pinnedModel: 'gpt-5-mini' });
            expect(res.body.toString('utf8')).to.equal('ok');
            expect(scope.isDone()).to.equal(true);
        });
    });
}

describe('llm provider, fetch via openai_api', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    registerOpenAiFetchTests();
    registerOpenAiErrorAndCapTests();
});

function registerOpenAiFetchTests() {
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
}

function registerOpenAiErrorAndCapTests() {
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
}
