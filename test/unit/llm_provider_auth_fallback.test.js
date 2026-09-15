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
 * XChain Hub - llm attestation provider tests: auth credential fallback chain
 *
 * healthCheck() and fetch() report the resolver's detail, then its reason,
 * then a literal, driven through a stubbed hub_credentials module.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

// ---- auth fallback chain edge cases ----------------------------------------
// These tests use the cache-injection pattern to stub hub-credentials.js
// BEFORE llm.js loads it (same technique as the claude_spawn suite in
// llm_provider_claude_spawn.test.js).

let savedCredsCacheEntry;

function reloadWithAuthStub(authResult) {
    const credsKey = require.resolve('../../src/lib/hub_credentials.js');
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
    delete require.cache[require.resolve('../../src/providers/llm/claude_spawn.js')];
    const llm = require('../../src/providers/llm.js');
    return { llm, stub: fakeResolve };
}

describe('llm provider, auth credential fallback chain', function () {

    afterEach(function () {
        sinon.restore();
        const credsKey = require.resolve('../../src/lib/hub_credentials.js');
        if (savedCredsCacheEntry !== undefined) {
            require.cache[credsKey] = savedCredsCacheEntry;
            savedCredsCacheEntry = undefined;
        } else {
            delete require.cache[credsKey];
        }
    });

    registerAuthReasonFallbackTests();
});

function registerAuthReasonFallbackTests() {
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

    it('fetch throws using auth.reason when detail is absent (runLlm error path)', async function () {
        // B56: `auth.detail || auth.reason || 'no credentials'` in runLlm
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
}
