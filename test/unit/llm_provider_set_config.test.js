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
 * XChain Hub - llm attestation provider tests: governance config install
 *
 * _setConfig() applies the registry's additional_config, warns once per
 * unconsumed key, and installs the prompt_envelope_version ceiling under
 * the same positive-integer warn-and-keep rule as the other bounds.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

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

        registerUnconsumedKeyWarnTests();
        registerUnconsumedKeyDefaultsTests();
    });
});

function registerUnconsumedKeyWarnTests() {
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
}

function registerUnconsumedKeyDefaultsTests() {
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
    // fresh hub does not advertise a governance value the runtime cannot read.
    it('no longer ships judge_equivalence_threshold in the llm provider defaults', function () {
        const { DEFAULTS } = require('../../src/validators/provider_registry');
        let ac = DEFAULTS && DEFAULTS.llm && DEFAULTS.llm.additional_config;
        expect(ac).to.be.an('object');
        expect(ac).to.not.have.property('judge_equivalence_threshold');
        // Guard the guard: the fixture must still be the real defaults object.
        expect(ac).to.have.property('judge_model');
    });
}

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
