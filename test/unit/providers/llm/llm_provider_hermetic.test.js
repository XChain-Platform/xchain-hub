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
 * XChain Hub - llm attestation provider tests: the hermetic surface
 *
 * The parts that need no transport at all: healthCheck() picks up the
 * credential resolver's verdict, agree() takes its trivial and unreachable
 * judge_model paths, and fetch() validates its JSON envelope. The transport
 * suites live in the llm_provider_* siblings.
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
    before(function () { llm = require('../../../../src/providers/llm.js'); });

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
        // runLlm throws and agree() catches → null (no_quorum surface).
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
