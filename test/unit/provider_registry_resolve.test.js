'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The provider registry loads each provider module by a path built from an id read
// out of the database, inside a try/catch that returns null, and a null module means
// the provider is simply unavailable: no error reaches a round. The registry lives in
// a feature directory while the providers stay in src/providers/, so this suite loads
// both shipped providers through the registry's own loader.

const { expect } = require('chai');

const ProviderRegistry = require('../../src/validators/provider_registry.js');
const SpendGuard       = require('../../src/lib/spend_guard.js');

// Every provider the registry pre-seeds, with the hooks a round calls on it.
const PROVIDERS = ['http_get', 'llm'];
const HOOKS     = ['fetch', 'agree', 'healthCheck'];

describe('provider registry module resolution', function () {

    // getModule() installs config into llm and rebuilds its spend guard, both module
    // state. Loading a fresh llm instance and putting the cached one and its guard
    // registration back afterwards keeps that state out of every later suite.
    const LLM_PATH = require.resolve('../../src/providers/llm.js');
    let cachedLlm;
    let priorGuard;

    before(function () {
        cachedLlm  = require.cache[LLM_PATH];
        priorGuard = SpendGuard.get('llm');
        delete require.cache[LLM_PATH];
    });

    after(function () {
        if (cachedLlm) require.cache[LLM_PATH] = cachedLlm; else delete require.cache[LLM_PATH];
        if (priorGuard) SpendGuard.registry.set('llm', priorGuard); else SpendGuard.unregister('llm');
    });

    for (const id of PROVIDERS) {
        it('loads the ' + id + ' provider module through getModule', function () {
            // No peerManager, so llm's spend window is never persisted to disk.
            const reg = new ProviderRegistry({ p2pConfig: { HUB_NETWORK: 'regtest' }, network: 'regtest', db: {} });
            expect(reg.isKnown(id), id + ' is not pre-seeded, so getModule would refuse it before loading').to.equal(true);
            const mod = reg.getModule(id);
            expect(mod, 'src/providers/' + id + '.js did not load through the registry, so every ' + id + ' round would find no provider')
                .to.not.equal(null);
            for (const hook of HOOKS) {
                expect(typeof mod[hook], 'providers/' + id + ' loaded without its ' + hook + ' hook').to.equal('function');
            }
        });
    }
});
