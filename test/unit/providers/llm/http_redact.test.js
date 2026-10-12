'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const nock       = require('nock');
const { redactVendorText, httpStatusError, settleOnce, callOpenAi } = require('../../../../src/providers/llm/http.js');
const { closeOutcome } = require('../../../../src/providers/llm/cli_outcome.js');
const SpendAudit = require('../../../../src/providers/llm/spend.js');

const MASKED_401 = 'Incorrect API key provided: sk-proj-********abcd. ' +
    'You can find your API key at https://platform.openai.com/account/api-keys.';

// Vendor and proxy error text reaches thrown errors, warn logs and the durable
// spend audit, so credentials it echoes are masked where the text first enters.
describe('LLM vendor error text redaction', function () {

    it('masks sk- keys, masked key echoes and the literal key that was sent', function () {
        const out = redactVendorText(MASKED_401);
        expect(out).to.not.contain('sk-');
        expect(out).to.contain('[redacted]');
        expect(out).to.contain('https://platform.openai.com/account/api-keys');
        expect(redactVendorText('echo sk-ant-api03-AAAAAAAAAAAA end')).to.equal('echo [redacted] end');
        expect(redactVendorText('proxy saw key-material-1234 here', 'key-material-1234'))
            .to.equal('proxy saw [redacted] here');
    });

    it('masks echoed authorization, bearer and x-api-key headers', function () {
        expect(redactVendorText('Authorization: Bearer abcdefgh12345678')).to.equal('Authorization: [redacted]');
        expect(redactVendorText('upstream said bearer abcdefgh12345678')).to.equal('upstream said Bearer [redacted]');
        expect(redactVendorText('{"x-api-key":"plainvalue99"}')).to.equal('{"x-api-key":"[redacted]"}');
    });

    it('passes text with no credential through unchanged and never throws', function () {
        const txid = 'ab'.repeat(32);
        for (const s of ['Overloaded', 'rate limit exceeded', txid, 'task-runner failed'])
            expect(redactVendorText(s)).to.equal(s);
        expect(redactVendorText(null)).to.equal('');
        expect(redactVendorText(undefined)).to.equal('');
        expect(redactVendorText(529)).to.equal('529');
    });
});

describe('LLM vendor error text redaction at each error path', function () {

    afterEach(function () { nock.cleanAll(); });

    it('redacts a non-2xx vendor message and raw body while keeping the status fields', function () {
        const err = httpStatusError({ statusCode: 401 }, 'OpenAI API', { error: { message: MASKED_401 } }, '');
        expect(err.message).to.match(/^llm: OpenAI API: /);
        expect(err.message).to.not.contain('sk-proj');
        expect(err.httpStatus).to.equal(401);
        expect(err.transient).to.equal(false);
        const raw = httpStatusError({ statusCode: 502 }, 'OpenAI API', null,
            '<html>' + 'x'.repeat(175) + ' Bearer abcdefgh12345678</html>', 'unused-secret');
        expect(raw.message).to.not.contain('abcdefgh');
        expect(raw.transient).to.equal(true);
    });

    it('keeps the sent key out of an OpenAI error and its malformed-response branch', async function () {
        const key = 'sk-test-redaction-key-0001';
        nock('https://api.openai.com').post('/v1/chat/completions')
            .reply(401, { error: { message: MASKED_401 } });
        nock('https://api.openai.com').post('/v1/chat/completions')
            .reply(502, '<html>Authorization: Bearer ' + key + '</html>');
        const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
        let hard, gateway;
        try { await callOpenAi('/v1/chat/completions', {}, key, { timeoutMs: 2000 }, usage); } catch (e) { hard = e; }
        try { await callOpenAi('/v1/chat/completions', {}, key, { timeoutMs: 2000 }, usage); } catch (e) { gateway = e; }
        expect(hard.message).to.not.contain('sk-proj');
        expect(hard.httpStatus).to.equal(401);
        expect(gateway.message).to.match(/malformed response/);
        expect(gateway.message).to.not.contain(key);
        expect(gateway.transient).to.equal(true);
    });

    it('redacts every rejection settled for a keyed call, the Messages API branch included', async function () {
        const key = 'sk-ant-api03-redaction-0001';
        const keyed = new Promise((resolve, reject) => {
            const { safeReject } = settleOnce(resolve, reject, key);
            safeReject(new Error('malformed response (<html>x-api-key: ' + key + '</html>)'));
        });
        const err = await keyed.then(() => null, (e) => e);
        expect(err.message).to.not.contain(key);
        expect(err.message).to.contain('malformed response');
    });
});

describe('LLM vendor error text redaction in the Messages API transport', function () {

    afterEach(function () { nock.cleanAll(); });

    it('redacts a Messages API malformed body before the cut, so no key head survives it', async function () {
        const key = 'AbCdEf0123456789ZyXwVuTsRq';
        const envKeys = ['HUB_CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'HUB_CLAUDE_CODE_OAUTH_TOKEN',
            'CLAUDE_CODE_OAUTH_TOKEN', 'HUB_CLAUDE_DEFAULT_CONFIG_DIR', 'ANTHROPIC_API_KEY',
            'LLM_DEFAULT_MODEL', 'HUB_OPENAI_API_KEY', 'OPENAI_API_KEY'];
        const saved = {};
        for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
        process.env.HUB_CLAUDE_DEFAULT_CONFIG_DIR = '/nonexistent/hub-redact-test';
        process.env.ANTHROPIC_API_KEY = key;
        const llmPath = require.resolve('../../../../src/providers/llm.js');
        delete require.cache[llmPath];
        const origWarn = console.warn;
        let err;
        try {
            const llm = require(llmPath);
            nock(/.*/).post('/v1/messages').times(5)
                .reply(502, '<html>' + 'x'.repeat(180) + key + '</html>');
            console.warn = () => {};
            try { await llm.fetch(JSON.stringify({ prompt: 'q' }), {}); } catch (e) { err = e; }
        } finally {
            console.warn = origWarn;
            for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
            delete require.cache[llmPath];
        }
        expect(err.message).to.match(/malformed response/);
        expect(err.message).to.not.contain(key.slice(0, 8));
    });
});

describe('LLM vendor error text redaction at the CLI and audit sinks', function () {

    it('redacts CLI stderr in the message but classifies on the raw stream', function () {
        const out = closeOutcome(1, '', 'API Error: 503 Service Unavailable sk-ant-api03-AAAAAAAAAAAA');
        expect(out.transient).to.equal(true);
        expect(out.message).to.not.contain('sk-ant');
        expect(out.message).to.contain('[redacted]');
    });

    it('writes a redacted error into the spend-audit settle record', function () {
        const audit = new SpendAudit({ hubConfig: {}, logger: { warn() {}, error() {} } });
        let written = null;
        audit.appendSpendRecord = (rec) => { written = rec; };
        audit.recordSpendSettle({ id: 'i1', vendor: 'openai', transport: 'api', model: 'm' }, 'error', null,
            new Error('gateway echoed sk-live-AAAAAAAAAAAAAAAA'));
        expect(written.error).to.contain('[redacted]');
        expect(written.error).to.not.contain('sk-live');
    });
});
