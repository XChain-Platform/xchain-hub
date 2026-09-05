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
});

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

    it('classifies the sampling-free Anthropic families, bare and dated', function () {
        const llm = _reloadProvider();
        for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
                          'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5'])
            expect(llm._anthropicRejectsSampling(id), id).to.equal(true);
        expect(llm._anthropicRejectsSampling('claude-opus-4-7-20260101')).to.equal(true);
    });

    it('leaves every other Anthropic id on the explicit-temperature path', function () {
        const llm = _reloadProvider();
        for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5',
                          'claude-future-not-yet-listed', '', undefined])
            expect(llm._anthropicRejectsSampling(id), String(id)).to.equal(false);
        // Prefix-only ids must not match by substring: 4-6 is not 4-7's family.
        expect(llm._anthropicRejectsSampling('claude-opus-4-70')).to.equal(false);
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

    // A key nobody reads is the one failure the warn-and-keep validations above miss:
    // a malformed value at least says so, an unread key is silent. Governance can put
    // arbitrary keys in this payload, so the honesty guarantee has to be enforced here.
    describe('unconsumed additional_config keys', function () {

        afterEach(function () { sinon.restore(); });

        it('warns once, and still applies the known sibling keys', function () {
            const llm = _reloadProvider();
            llm._resetUnconsumedWarnState();
            let warn = sinon.stub(console, 'warn');
            llm._setConfig({ additional_config: {
                judge_model: 'claude-haiku-4-5',
                prompt_envelope_version: 2,
                judge_equivalence_threshold: 0.85
            } });
            let hits = warn.getCalls().filter(c => /not consumed by this build/.test(String(c.args[0])));
            expect(hits.length).to.equal(1);
            expect(hits[0].args[0]).to.match(/judge_equivalence_threshold/);
            // The unknown key must not abort the install of the rest. Asserted through
            // the one observable a sibling key has (there is no public getter), the same
            // envelope_version ceiling the suite above uses. The assertion is on the
            // CEILING the message reports, not merely on being rejected: a rejection
            // alone is not discriminating, since the default ceiling of 1 also rejects
            // version 3, so `max 2` is the only part that can tell an install that
            // happened from one the unrecognised key aborted.
            return llm.fetch(JSON.stringify({ prompt: 'hi', envelope_version: 3 }), {})
                .then(() => { throw new Error('expected envelope_version reject'); })
                .catch((e) => { expect(e.message).to.match(/unsupported envelope_version \(got 3, max 2\)/); });
        });

        it('does not repeat the warning for the same unknown-key set', function () {
            const llm = _reloadProvider();
            llm._resetUnconsumedWarnState();
            let warn = sinon.stub(console, 'warn');
            let ac = { judge_model: 'claude-haiku-4-5', judge_equivalence_threshold: 0.85 };
            llm._setConfig({ additional_config: ac });
            llm._setConfig({ additional_config: ac });
            let hits = warn.getCalls().filter(c => /not consumed by this build/.test(String(c.args[0])));
            expect(hits.length).to.equal(1);
        });

        it('warns again when a further unknown key appears', function () {
            const llm = _reloadProvider();
            llm._resetUnconsumedWarnState();
            let warn = sinon.stub(console, 'warn');
            llm._setConfig({ additional_config: { judge_equivalence_threshold: 0.85 } });
            llm._setConfig({ additional_config: { judge_equivalence_threshold: 0.85, some_future_key: 1 } });
            let hits = warn.getCalls().filter(c => /not consumed by this build/.test(String(c.args[0])));
            expect(hits.length).to.equal(2);
            expect(hits[1].args[0]).to.match(/some_future_key/);
        });

        it('says nothing when every key is one this build consumes', function () {
            const llm = _reloadProvider();
            llm._resetUnconsumedWarnState();
            let warn = sinon.stub(console, 'warn');
            llm._setConfig({ additional_config: {
                approved_models: ['claude-opus-4-7'], judge_model: 'claude-haiku-4-5',
                judge_fallback_models: [], model_vendors: {}, require_all_vendors: false,
                max_completion_tokens: 1024, default_temperature: 0,
                prompt_envelope_version: 1, enabled: true, max_budget_usd: 5
            } });
            let hits = warn.getCalls().filter(c => /not consumed by this build/.test(String(c.args[0])));
            expect(hits.length).to.equal(0);
        });

        // The knob this warning was built for is gone from the shipped defaults, so a
        // fresh hub no longer advertises a governance value the runtime cannot read.
        it('no longer ships judge_equivalence_threshold in the llm provider defaults', function () {
            const { DEFAULTS } = require('../../src/ProviderRegistry');
            let ac = DEFAULTS && DEFAULTS.llm && DEFAULTS.llm.additional_config;
            expect(ac).to.be.an('object');
            expect(ac).to.not.have.property('judge_equivalence_threshold');
            // Guard the guard: the fixture must still be the real defaults object.
            expect(ac).to.have.property('judge_model');
        });
    });
});

// The envelope-version ceiling is read at exactly one place, the fetch() boundary, so
// a bare-truthiness install let a negative governance value reject every valid
// envelope_version:1 request and Infinity disable the ceiling. Same positive-integer
// warn-and-keep rule as max_completion_tokens / default_temperature.
describe('llm provider, governance prompt_envelope_version bounds', function () {

    afterEach(function () { sinon.restore(); });

    // No getter: probe the installed ceiling through fetch()'s envelope_version gate.
    // Hermetic env: no credential resolves, so an accepted version fails later at the
    // transport rather than dialing anything.
    function ceilingAccepts(additionalConfig, version) {
        return _withEnv({}, async () => {
            const llm = _reloadProvider();
            const warn = sinon.stub(console, 'warn');
            llm._setConfig({ additional_config: additionalConfig });
            warn.restore();
            try { await llm.fetch(JSON.stringify({ prompt: 'q', envelope_version: version }), {}); }
            catch (e) { return !/unsupported envelope_version/.test(e.message); }
            return true;
        });
    }

    it('installs a valid positive-integer ceiling', async function () {
        expect(await ceilingAccepts({ prompt_envelope_version: 2 }, 2)).to.equal(true);
        expect(await ceilingAccepts({ prompt_envelope_version: 2 }, 3)).to.equal(false);
    });

    for (const bad of [-3, 1.5, Number.POSITIVE_INFINITY, 0, 'abc']) {
        it('ignores ' + String(bad) + ' and keeps the prior ceiling (envelope_version 1 still accepted)', async function () {
            expect(await ceilingAccepts({ prompt_envelope_version: bad }, 1)).to.equal(true);
            expect(await ceilingAccepts({ prompt_envelope_version: bad }, 2)).to.equal(false);
        });
    }

    it('warns once per rejected value', async function () {
        const llm = _reloadProvider();
        const warn = sinon.stub(console, 'warn');
        llm._setConfig({ additional_config: { prompt_envelope_version: -3 } });
        expect(warn.calledOnce).to.equal(true);
        expect(warn.firstCall.args[0]).to.match(/ignoring additional_config\.prompt_envelope_version -3/);
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
});

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

    // - these two used to pin the OPPOSITE contract (an unconfigured hub
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

    // - a crash mid-call must still leave local evidence that a vendor
    // charge was initiated, on the CLI transport most of all: it recorded nothing.
    describe('durable spend audit', function () {

        const fsSync = require('fs');
        let sinkPath, savedSink;

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

        function readSink() {
            let raw = '';
            try { raw = fsSync.readFileSync(sinkPath, 'utf8'); } catch { return []; }
            return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
        }

        it('writes the intent BEFORE the vendor is dialed, and settles it after', async function () {
            let sinkAtDispatch = null;
            const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
            stub.callsFake(async () => {
                // Observed from inside the call: the durable record already exists.
                sinkAtDispatch = readSink();
                return { result: 'ok', json: {} };
            });

            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

            expect(sinkAtDispatch, 'the intent must be on disk before the call').to.have.length(1);
            expect(sinkAtDispatch[0].phase).to.equal('intent');
            expect(sinkAtDispatch[0].transport).to.equal('claude_spawn');

            const lines = readSink();
            expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'settle']);
            expect(lines[1].id).to.equal(lines[0].id);
            expect(lines[1].status).to.equal('ok');
        });

        it('settles the CLI cost the branch used to discard', async function () {
            const { llm, stub } = reloadWithSpawnStub({
                result: 'ok',
                json: { total_cost_usd: 0.0123, usage: { input_tokens: 11, output_tokens: 7 } }
            });
            expect(stub.called).to.equal(false);

            await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

            const settle = readSink().find(l => l.phase === 'settle');
            expect(settle.usage.costUsd).to.equal(0.0123);
            expect(settle.usage.tokens).to.deep.equal({ input_tokens: 11, output_tokens: 7 });
            // The same numbers now reach healthCheck's in-memory accounting, which
            // the CLI transport was absent from entirely.
            const health = await withSpawnEnv(() => llm.healthCheck());
            expect(health.tokenUsage.calls).to.equal(1);
            expect(health.tokenUsage.inputTokens).to.equal(11);
        });

        it('leaves an intent with an error settle when the call throws', async function () {
            const { llm, stub } = reloadWithSpawnStub({ result: 'ok' });
            stub.rejects(new Error('cli exploded'));

            try {
                await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));
            } catch { /* expected */ }

            const lines = readSink();
            expect(lines.map(l => l.phase)).to.deep.equal(['intent', 'settle']);
            expect(lines[1].status).to.equal('error');
            expect(lines[1].error).to.contain('cli exploded');
        });

        it('is best-effort: an unwritable sink never blocks the round', async function () {
            process.env.LLM_SPEND_LOG_PATH = '/dev/null/not-a-dir/spend.jsonl';
            const { llm } = reloadWithSpawnStub({ result: 'still served' });

            const out = await withSpawnEnv(() => llm.fetch(JSON.stringify({ prompt: 'hi' }), {}));

            expect(out.body.toString('utf8')).to.equal('still served');
        });

        // ---- the aggregate budget the per-call caps never bounded ----
        //
        // The per-call ceilings bound ONE call each, so N cheap calls cost N times a
        // cheap call. On testnet a request costs its author nothing, so this window is
        // the only thing standing between a spam loop and the operator's vendor bill.
        describe('rolling spend budget', function () {

            const BUDGET_KEYS = ['LLM_MAX_SPEND_USD_CENTS_PER_WINDOW',
                                 'LLM_EST_SPEND_USD_CENTS',
                                 'LLM_SPEND_WINDOW_MS'];
            let savedBudget;

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
        });
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

    it('_setConfig max_budget_usd feeds _resolveMaxBudgetUsd; 0 falls back to the default', function () {
        delete process.env.LLM_MAX_BUDGET_USD;
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { max_budget_usd: 1.25 } });
        expect(llm._resolveMaxBudgetUsd()).to.equal(1.25);
        // clearing the governance value no longer means "no ceiling".
        llm._setConfig({ additional_config: { max_budget_usd: 0 } });
        expect(llm._resolveMaxBudgetUsd()).to.equal(llm._DEFAULT_MAX_BUDGET_USD);
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
        // A pinned map that says nothing about this id falls through, not throws.
        expect(llm._vendorOfModel('llama-3-70b', { 'other-model': 'openai' })).to.equal('anthropic');
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
});

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

        it('types the budget error at its source for every _runLlm caller', async function () {
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

/*********************************************************************
 * agree() must not canonicalize an unvouched `meta`.
 *
 * `meta` (the model that served a response) is consensus-visible: the canonical
 * signature binds it and the ATTEST v1 wire records it on-chain. But proposals
 * come from other validators and the judge only ever evaluates their BODIES, so
 * whichever proposal won had its meta copied straight through. A Byzantine
 * validator could put arbitrary bytes on-chain without ever winning on content.
 *
 * Two fail-closed gates, mirroring the truncated_pick precedent in the same
 * function: an exact allowlist against the block-anchored approved identifiers,
 * and corroboration across proposals.
 ********************************************************************/
describe('llm provider, agree() meta canonicalization', function () {

    const APPROVED = 'claude-sonnet-4-6';
    const body = (s) => Buffer.from(s, 'utf8');

    it('passes an approved, corroborated meta through unchanged (single proposal)', async function () {
        const llm = _reloadProvider();
        const r = await llm.agree([{ body: body('solo'), meta: APPROVED }]);
        expect(r).to.not.be.null;
        expect(r.meta).to.equal(APPROVED);
    });

    it('rejects an unapproved meta on the single-proposal path', async function () {
        const llm = _reloadProvider();
        const outcome = {};
        // Nothing to corroborate against, but the allowlist still applies: an
        // unrecognized identifier must never reach the canonical signature.
        const r = await llm.agree([{ body: body('solo'), meta: 'evil-model-9000' }], { outcome });
        expect(r).to.be.null;
        expect(outcome.inconclusive).to.equal(true);
        expect(outcome.reason).to.equal('meta_unrecognized');
    });

    it('rejects a non-string or empty meta rather than coercing it', async function () {
        for (const bad of [undefined, null, '', 42, { model: APPROVED }, Buffer.from(APPROVED)]) {
            const llm = _reloadProvider();
            const outcome = {};
            const r = await llm.agree([{ body: body('solo'), meta: bad }], { outcome });
            expect(r, 'meta=' + String(bad)).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        }
    });

    it('does not accept a near-miss of an approved identifier', async function () {
        // Exact membership only: no prefix, suffix or case-insensitive matching, any
        // of which would let a crafted value ride in alongside a legitimate one.
        for (const near of [APPROVED + '-evil', 'x' + APPROVED, APPROVED.toUpperCase(), ' ' + APPROVED]) {
            const llm = _reloadProvider();
            const outcome = {};
            const r = await llm.agree([{ body: body('solo'), meta: near }], { outcome });
            expect(r, near).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        }
    });

    it('honours a governance-updated approved_models list', async function () {
        const llm = _reloadProvider();
        llm._setConfig({ additional_config: { approved_models: ['some-new-approved-model', 'claude-opus-4-7'] } });
        const r = await llm.agree([{ body: body('solo'), meta: 'some-new-approved-model' }]);
        expect(r).to.not.be.null;
        expect(r.meta).to.equal('some-new-approved-model');
        // ...and the previous default is no longer approved once governance replaced it.
        const outcome = {};
        expect(await llm.agree([{ body: body('solo'), meta: APPROVED }], { outcome })).to.be.null;
        expect(outcome.reason).to.equal('meta_unrecognized');
    });

    // The corroboration half is exercised through the internal helper, because
    // reaching the judge-winner return requires a live judge transport. The gate is
    // the same function used on that path.
    describe('corroboration across proposals', function () {

        it('requires a second proposal reporting the identical meta', async function () {
            const llm = _reloadProvider();
            // Two proposals, only one claiming the approved model: uncorroborated.
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: APPROVED },
                { body: body('B'), meta: 'claude-opus-4-7' }
            ], 0, outcome);
            expect(r).to.be.null;
            expect(outcome.reason).to.equal('meta_uncorroborated');
        });

        it('accepts when a second proposal corroborates', async function () {
            const llm = _reloadProvider();
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: APPROVED },
                { body: body('B'), meta: APPROVED }
            ], 0, outcome);
            expect(r).to.equal(APPROVED);
            expect(outcome.inconclusive).to.be.undefined;
        });

        it('fails closed on honest divergence too, rather than recording an unsupported claim', async function () {
            // A validator that legitimately fell back to another model and whose body
            // the judge then picked lands here as well. Inconclusive is the correct
            // outcome: the federation cannot corroborate which model served it.
            const llm = _reloadProvider();
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: 'claude-opus-4-7' },
                { body: body('B'), meta: APPROVED },
                { body: body('C'), meta: APPROVED }
            ], 0, outcome);
            expect(r).to.be.null;
            expect(outcome.reason).to.equal('meta_uncorroborated');
        });

        it('does not admit a judge-fallback identifier, which no fetch can produce', async function () {
            // The judge chain picks who EVALUATES bodies; a proposal's meta is always
            // the fetch model. A corroborated pair naming a judge fallback is therefore
            // two validators vouching for a model that served nothing.
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: {
                approved_models:       [APPROVED],
                judge_fallback_models: ['gpt-5-mini']
            } });
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: 'gpt-5-mini' },
                { body: body('B'), meta: 'gpt-5-mini' }
            ], 0, outcome);
            expect(r).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        });

        it('an unapproved meta is rejected before corroboration is even considered', async function () {
            // Even a fully corroborated value must be an approved identifier: a
            // colluding pair must not be able to vote an arbitrary string onto the chain.
            const llm = _reloadProvider();
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: 'evil-model-9000' },
                { body: body('B'), meta: 'evil-model-9000' }
            ], 0, outcome);
            expect(r).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        });
    });

    // fetch() honours the block-anchored pinned model, so the gate that
    // judges the meta it returns has to read the same block-anchored list. Reading
    // the live one made a governance delisting permanent: every retry re-pinned the
    // removed model, every meta came back unrecognized, and the request expired at
    // no_quorum despite successful provider responses.
    describe('block-anchored allowlist (options.pinnedApprovedModels)', function () {

        it('accepts a meta pinned at the request block after governance delists the model', async function () {
            const llm = _reloadProvider();
            // Governance hot reload removes 'retired-model-1' from the live set.
            llm._setConfig({ additional_config: { approved_models: ['claude-opus-4-7'] } });
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: 'retired-model-1' },
                { body: body('B'), meta: 'retired-model-1' }
            ], 0, outcome, ['retired-model-1', 'claude-opus-4-7']);
            expect(r).to.equal('retired-model-1');
            expect(outcome.inconclusive).to.be.undefined;
        });

        it('still rejects that same meta when no block-anchored list is threaded', async function () {
            // The regression this fix removes, kept as the control: without the pinned
            // list the live set decides and the round is frozen at no_quorum.
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { approved_models: ['claude-opus-4-7'] } });
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: 'retired-model-1' },
                { body: body('B'), meta: 'retired-model-1' }
            ], 0, outcome);
            expect(r).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        });

        it('does not widen the allowlist: a meta in neither list is still refused', async function () {
            // The pinned list REPLACES the live one, it does not union with arbitrary
            // values. This control has to survive the liveness fix intact.
            const llm = _reloadProvider();
            llm._setConfig({ additional_config: { approved_models: ['claude-opus-4-7'] } });
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: 'evil-model-9000' },
                { body: body('B'), meta: 'evil-model-9000' }
            ], 0, outcome, ['retired-model-1', 'claude-opus-4-7']);
            expect(r).to.be.null;
            expect(outcome.reason).to.equal('meta_unrecognized');
        });

        it('keeps corroboration in force under a block-anchored list', async function () {
            const llm = _reloadProvider();
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: 'retired-model-1' },
                { body: body('B'), meta: 'claude-opus-4-7' }
            ], 0, outcome, ['retired-model-1', 'claude-opus-4-7']);
            expect(r).to.be.null;
            expect(outcome.reason).to.equal('meta_uncorroborated');
        });

        it('falls back to the live set when the pinned list is empty or absent', async function () {
            const llm = _reloadProvider();
            const outcome = {};
            const r = llm._canonicalMetaForTest([
                { body: body('A'), meta: APPROVED },
                { body: body('B'), meta: APPROVED }
            ], 0, outcome, []);
            expect(r).to.equal(APPROVED);
        });
    });
});
